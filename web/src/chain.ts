import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { monad } from "./chains";

export const EXITGUARD = getAddress("0x921621dC0de402adB75a84479046e5150c5a10D5");
export const OWNER = getAddress("0x027b756B9B411c2838926534b3D5e119B8De8f2e");
export const AGENT = getAddress("0x68a691c461c54CE767C6d539022fa344397b9f31");
export const EXPLORER = "https://monadvision.com";

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

// viem 2.57 and wagmi 2.19 disagree on some generic parameter shapes at the type
// level (runtime is fine). This client is only used for plain reads.
const client = createPublicClient({ chain: monad, transport: http(monad.rpcUrls.default.http[0]) });
const rpc = client as unknown as {
  readContract: (a: Record<string, unknown>) => Promise<unknown>;
};

export async function readVault(token: string): Promise<VaultState> {
  const t = getAddress(token);
  const [p, d] = await Promise.all([
    rpc.readContract({ address: EXITGUARD, abi: READ_ABI, functionName: "policies", args: [OWNER, t] }) as Promise<
      readonly [`0x${string}`, `0x${string}`, bigint, number, number, number, bigint]
    >,
    rpc.readContract({ address: EXITGUARD, abi: READ_ABI, functionName: "deposits", args: [OWNER, t] }) as Promise<bigint>,
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
