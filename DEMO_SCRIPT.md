# DEMO_SCRIPT — 90 seconds

> **Replay disclosure:** sections marked **[LIVE]** run against real Nansen responses recorded by
> the background recorder. Sections marked **[REPLAY]** replay those same recorded responses
> through identical decision logic without sending a transaction. If the demo uses REPLAY for any
> trigger, say so on camera.

---

## 0:00 – 0:15 · The policy is enforced on-chain

Show the verified contract.

- MonadVision: `https://monadvision.com/address/0x921621dC0de402adB75a84479046e5150c5a10D5`
- Sourcify verification: `exact_match` (creation + runtime)

```
cast call 0x921621dC0de402adB75a84479046e5150c5a10D5 \
  "policies(address,address)((address,address,uint128,uint32,uint16,uint32,uint64))" \
  0x027b756B9B411c2838926534b3D5e119B8De8f2e \
  0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A \
  --rpc-url https://rpc.monad.xyz
```

Point at: `guard` = agent EOA, `safeAddr` = owner EOA, `thresholdUsd`, `maxBps = 2500`,
`cooldownSecs = 3600`, and `deposits = 2 WMON`.

**Line:** "The agent can only move a capped slice, only after the threshold, only inside the
window, only to this address."

---

## 0:15 – 0:35 · The Nansen signal, live

```
nansen research token flow-intelligence --chain monad \
  --token 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
```

Show the raw JSON: `smart_trader_*`, `top_pnl_*`, `whale_*`.

**Line:** "This is the decision engine. Sum the three net flows, floor(max(0, -sum)) gives
distribution. Exchange and fresh-wallet flows are excluded on purpose."

Then show the recorded series:

```
tail -5 logs/recorder.log
```

Point out the `bucket` field and any `[BUCKET_RESET_00:00_UTC]` marker.

---

## 0:35 – 0:55 · The decision loop

```
MODE=DRY_RUN ONE_SHOT=1 npx tsx src/loop.ts
```

Walk the output: the three segment values, the summed `netFlowSum`, `distributionUsd`, the
on-chain `POLICY` read, the staleness check, and the final `NO TRIGGER` / `TRIGGER ELIGIBLE`
verdict.

**Line:** "It reads the owner's policy from the contract and skips locally whenever protect()
would revert, so it never burns gas on a doomed transaction."

---

## 0:55 – 1:15 · The trigger and the evidence hash

If a live trigger fires:

```
grep "PROTECT SENT" logs/decision.log
```

Open the transaction on MonadVision and show the `Protected` event with `distributionUsd`,
`windowSecs` and `evidenceHash`.

Prove the evidence hash against the recorded file. Hash the **exact file bytes** (no trailing
newline, no JSON reformatting):

```
cast keccak 0x$(xxd -p < fixtures/<timestamp>_WMON.json | tr -d '\n')
```

This must print the same `evidenceHash` that appears in the `Protected` event on the explorer.

> Verified on a real recorded file: `cast keccak` over the file bytes and the agent's
> `keccak256(rawFileBytes)` both produce
> `0xd048e1df2f45f609aefa7dc43f1650cfae85c0dea69dead38cb49ddba51fc194`.

**Line:** "That hash is the exact Nansen response that justified this move, committed on-chain."

**If REPLAY is used, say explicitly:** "This part is a replay of recorded real Nansen responses
through the same decision logic — no transaction is sent."

---

## 1:15 – 1:30 · The UI

Run the frontend. Show: connected wallet, the WMON position, the live policy, the Nansen signal
table with per-segment net flows and wallet counts, and the latest protection with an explorer
link.

**Line:** "Nansen gives the signal, the contract enforces the decision."

---

## Honest statements to make if asked

- The threshold has **not** been tuned to force a trip; it was left at a fail-safe `1000000`.
- WMON has been net **inflow** in every recorded sample, so it has legitimately not triggered.
- Nansen caches responses **10–30 minutes**; Monad is cheap, final execution, not a real-time
  signal source.
- The `1d` signal bucket's rolling-vs-calendar alignment is **not yet verified**.
