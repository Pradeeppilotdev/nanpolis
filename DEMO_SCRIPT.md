# Nanpolis demo

## Start without credentials

From the repository root:

```bash
npm run setup
npm run dev
```

Open the displayed Vite URL. Say: “This is a historical-data demo using real committed Nansen responses. It is not live protection and sends no transactions.”

Show the data provenance, WMON flow segments, observational watchlist, empty or recorded protection history, and contract-read status. Missing network data must remain unavailable rather than becoming a fictional balance or successful protection.

## Explain the decision

In a separate terminal:

```bash
npm run replay
```

Explain the sum of smart-trader, top-PnL, and whale flows and the minimum summed segment count. Label overlap means the count is not necessarily unique wallets. The published samples lack their original timeframe sidecars, so offline replay demonstrates signal math rather than a valid live policy trigger.

## Demonstrate current data, if configured

Stop the demo, copy `.env.example` to `.env`, and supply a Nansen key and Monad RPC URL. The following consumes Nansen credits:

```bash
npm run dev:live
```

After recording a fresh valid response, use another terminal:

```bash
cd agent
MODE=DRY_RUN ONE_SHOT=1 npm run loop
```

Show the actual verdict. Do not tune the policy, alter timestamps, or invent a trigger to improve the presentation. Say: “The worker checks fresh metadata and the on-chain policy. This run cannot send a transaction.”

## Explain limits

- The guard supplies the distribution number; the contract does not authenticate Nansen.
- The owner controls the destination, per-call cap, cooldown, and guard revocation.
- Moving WMON to another address does not hedge its price.
- An evidence hash commits the raw bytes, not their provenance or correctness.
- The repository's hardened contract source requires a new deployment. The historical address is not automatically updated.

Show a protection transaction only if a genuine confirmed event exists. Never present demo data, an eligible dry run, or an old screenshot as a completed transaction.
