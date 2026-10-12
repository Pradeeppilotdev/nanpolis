import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  hex,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

export const EXITGUARD_ABI = parseAbi([
  "function policies(address owner, address token) view returns (address guard, address safeAddr, uint128 thresholdUsd, uint32 windowSecs, uint16 maxBps, uint32 cooldownSecs, uint64 lastTrigger)",
  "function deposits(address owner, address token) view returns (uint256)",
  "function protect(address owner, address token, uint16 bps, uint256 distributionUsd, uint32 windowSecs, bytes32 evidenceHash)",
  "event Protected(address indexed owner, address indexed token, address indexed guard, uint256 amountMoved, uint16 bps, uint256 distributionUsd, uint32 windowSecs, bytes32 evidenceHash)",
]);

export type Policy = {
  guard: Address;
  safeAddr: Address;
  thresholdUsd: bigint;
  windowSecs: number;
  maxBps: number;
  cooldownSecs: number;
  lastTrigger: bigint;
};

export function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function publicClient(): PublicClient {
  return createPublicClient({
    transport: http(readEnv("MONAD_RPC_URL")),
  }) as PublicClient;
}

export function agentWallet(): WalletClient {
  const account = privateKeyToAccount(readEnv("AGENT_PRIVATE_KEY") as `0x${string}`);
  return createWalletClient({ account, transport: http(readEnv("MONAD_RPC_URL")) }) as WalletClient;
}

export async function getPolicy(
  client: PublicClient,
  exitGuard: Address,
  owner: Address,
  token: Address,
): Promise<Policy> {
  const p = (await client.readContract({
    address: exitGuard,
    abi: EXITGUARD_ABI,
    functionName: "policies",
    args: [owner, token],
  })) as readonly [Address, Address, bigint, number, number, number, bigint];
  return {
    guard: p[0],
    safeAddr: p[1],
    thresholdUsd: p[2],
    windowSecs: Number(p[3]),
    maxBps: Number(p[4]),
    cooldownSecs: Number(p[5]),
    lastTrigger: p[6],
  };
}

export type Decision = {
  ok: boolean;
  reason?: string;
  bps?: number;
};

/**
 * Mirror every revert condition in ExitGuard.protect() so we skip locally
 * instead of burning gas on a tx that is guaranteed to revert.
 */
export function simulateProtect(
  policy: Policy,
  agentAddress: Address,
  token: Address,
  opts: { distributionUsd: number; windowSecs: number; configuredBps: number; now: number; balance: bigint },
): Decision {
  if (policy.guard === "0x0000000000000000000000000000000000000000")
    return { ok: false, reason: "guard revoked on-chain (guard == address(0))" };
  if (policy.guard.toLowerCase() !== agentAddress.toLowerCase())
    return { ok: false, reason: `agent is not the policy guard (policy guard=${policy.guard})` };
  if (opts.windowSecs !== policy.windowSecs)
    return { ok: false, reason: `WindowMismatch: window ${opts.windowSecs} != policy ${policy.windowSecs}` };
  if (BigInt(opts.distributionUsd) < policy.thresholdUsd)
    return {
      ok: false,
      reason: `BelowThreshold: distributionUsd ${opts.distributionUsd} < thresholdUsd ${policy.thresholdUsd}`,
    };

  const bps = Math.min(opts.configuredBps, Number(policy.maxBps));
  if (bps <= 0) return { ok: false, reason: "BpsTooHigh: effective bps is 0" };

  if (policy.lastTrigger !== 0n) {
    const next = Number(policy.lastTrigger) + Number(policy.cooldownSecs);
    if (opts.now < next)
      return {
        ok: false,
        reason: `Cooldown: now ${opts.now} < lastTrigger ${policy.lastTrigger} + cooldown ${policy.cooldownSecs}`,
      };
  }

  const amount = (opts.balance * BigInt(bps)) / 10000n;
  if (amount === 0n) return { ok: false, reason: "NothingToMove: bps slice rounds to 0" };

  return { ok: true, bps };
}

/** keccak256 over the exact raw bytes of the Nansen JSON file on disk. */
export function evidenceHashFor(rawFile: string): { hash: `0x${string}`; file: string } {
  const abs = path.isAbsolute(rawFile) ? rawFile : path.join(ROOT, rawFile);
  const bytes = fs.readFileSync(abs);
  return { hash: keccak256(bytes), file: path.relative(ROOT, abs) };
}

export async function sendProtect(args: {
  wallet: WalletClient;
  client: PublicClient;
  exitGuard: Address;
  owner: Address;
  token: Address;
  bps: number;
  distributionUsd: number;
  windowSecs: number;
  evidenceHash: `0x${string}`;
}): Promise<{ txHash: `0x${string}`; blockNumber: bigint }> {
  const hash = await args.wallet.writeContract({
    address: args.exitGuard,
    abi: EXITGUARD_ABI,
    functionName: "protect",
    args: [args.owner, args.token, args.bps, BigInt(args.distributionUsd), args.windowSecs, args.evidenceHash],
    chain: null,
    account: args.wallet.account!,
  } as any);
  const receipt = (await args.client.waitForTransactionReceipt({ hash })) as any;
  return { txHash: hash, blockNumber: receipt.blockNumber };
}

export function protectedEventsFromLog(logs: readonly any[], exitGuard: Address) {
  return logs
    .filter((l) => l.address.toLowerCase() === exitGuard.toLowerCase())
    .flatMap((l) => {
      try {
        const p = argsToEvent(l);
        return p ? [p] : [];
      } catch {
        return [];
      }
    });
}

import { parseEventLogs } from "viem";
function argsToEvent(log: any) {
  const [ev] = parseEventLogs({
    abi: EXITGUARD_ABI,
    eventName: "Protected",
    logs: [
      {
        address: log.address,
        topics: log.topics,
        data: log.data,
      },
    ],
    strict: false,
  });
  return ev?.args;
}
