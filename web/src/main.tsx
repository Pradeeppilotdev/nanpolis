import React from "react";
import ReactDOM from "react-dom/client";
import { WagmiProvider, createConfig, http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { injected } from "wagmi/connectors";
import { monad } from "./chains";
import "@fontsource-variable/schibsted-grotesk";
import App from "./App";
import "./styles.css";

export const config = createConfig({
  chains: [monad],
  transports: { [monad.id]: http("https://rpc.monad.xyz") },
  connectors: [injected()],
  ssr: false,
});

const qc = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <WagmiProvider config={config}>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </WagmiProvider>,
);
