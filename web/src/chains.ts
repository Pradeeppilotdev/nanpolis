import { defineChain } from "viem";
import deployment from "../../deployments.json";

// Monad mainnet, chain id 143 (docs.monad.xyz network information - mainnet)
export const monad = defineChain({
  id: deployment.chainId,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpc] } },
  blockExplorers: {
    default: { name: "MonadVision", url: deployment.explorer },
  },
});
