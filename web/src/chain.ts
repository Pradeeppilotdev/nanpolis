import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { monad } from "./chains";
import deployment from "../../deployments.json";

export const EXITGUARD = getAddress(deployment.exitGuard);
export const OWNER = getAddress(deployment.wallets.deployer);
export const AGENT = getAddress(deployment.wallets.agent);
export const EXPLORER = deployment.explorer;
export const ASSET = getAddress(deployment.asset.token);

const READ_ABI = parseAbi([
  "function policies(address owner, address token) view returns (address guard, address safeAddr, uint128 thresholdUsd, uint32 windowSecs, uint16 maxBps, uint32 cooldownSecs, uint64 lastTrigger)",
  "function deposits(address owner, address token) view returns (uint256)",
]);

export type Policy = {
  guard: `0x${string}`;
  safeAddr: `0x${string}`;
  thresholdUsd: number;
  windowSecs: number;
  maxBps: number;
  cooldownSecs: number;
  lastTrigger: number; // unix seconds, 0 = never
};

export type VaultState = { policy: Policy; deposit: bigint };

const client = createPublicClient({ chain: monad, transport: http(monad.rpcUrls.default.http[0]) });

export async function readVault(token: string): Promise<VaultState> {
  const t = getAddress(token);
  const [p, d] = await Promise.all([
    client.readContract({ address: EXITGUARD, abi: READ_ABI, functionName: "policies", args: [OWNER, t] }) as Promise<
      readonly [`0x${string}`, `0x${string}`, bigint, number, number, number, bigint]
    >,
    client.readContract({ address: EXITGUARD, abi: READ_ABI, functionName: "deposits", args: [OWNER, t] }) as Promise<bigint>,
  ]);
  return {
    policy: {
      guard: p[0],
      safeAddr: p[1],
      thresholdUsd: Number(p[2]),
      windowSecs: Number(p[3]),
      maxBps: Number(p[4]),
      cooldownSecs: Number(p[5]),
      lastTrigger: Number(p[6]),
    },
    deposit: d,
  };
}
