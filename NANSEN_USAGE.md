# NANSEN_USAGE.md — every Nansen call this project makes

All data comes from the **Nansen CLI v1.21.0** (`nansen-cli`), executed as a subprocess.
Every command below was taken from real `nansen --help` / subcommand `--help` output, not guessed.

Chain: **Monad mainnet** (`--chain monad`).
API key: read from the `NANSEN_API_KEY` environment variable. The agent loads the project
`.env` into the process environment **before** shelling out, because the CLI does not read
a project `.env` file itself.

---

## 1. REST `POST /api/v1/tgm/flow-intelligence` — THE decision engine (primary)

**Endpoint:** `POST /api/v1/tgm/flow-intelligence`
**Cost:** 1 credit per call (identical on Free and Pro). Only successful `2xx` responses are charged.
**Role:** this is the *only* Nansen call that feeds the on-chain trigger decision.

### Exact request used by the agent

```bash
curl -sS -X POST https://api.nansen.ai/api/v1/tgm/flow-intelligence \
  -H "apikey: $NANSEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"token_address":"<tokenAddress>","chain":"<signalChain>","timeframe":"6h"}'
```

Fields sent: `token_address`, `chain`, **`timeframe`**. Default timeframe used by the agent is
`6h` (21600s), overridable with `NANSEN_TIMEFRAME`. Valid per schema: `5m|1h|6h|12h|1d|7d`.

### Exact CLI command (used for probing only)

```
nansen research token flow-intelligence --chain <signalChain> --token <tokenAddress> --days 1
```

Source: `nansen research token flow-intelligence --help`

```
token flow-intelligence — Detailed flow intelligence by label
Params (* required): --chain (solana), --token*, --days (30)
Cost: 1 credit (Free tier) / 1 credit (Pro tier)
```

**The CLI cannot set a window.** `nansen-cli@v1.21.0/src/api.js:1047-1058` destructures only
`tokenAddress` and `chain` and sends `{token_address, chain}` — `--days` is dropped. Measured:

| Body field sent | Result |
|---|---|
| `date` | `422 unknown_field` |
| `days` | `422 unknown_field` |
| `timeframe` | **accepted** |

So the decision path uses REST (to control the window) and the CLI is kept for discovery.

```
token flow-intelligence — Detailed flow intelligence by label
Params (* required): --chain (solana), --token*, --days (30)
Cost: 1 credit (Free tier) / 1 credit (Pro tier)
```

### The `--days` flag is a no-op in this CLI version — measured, not assumed

`nansen-cli@v1.21.0/src/api.js:1047-1058`:

```js
async tokenFlowIntelligence(params = {}) {
  const { tokenAddress, chain = 'solana' } = params;
  if (tokenAddress) {
    const validation = validateTokenAddress(tokenAddress, chain);
    if (!validation.valid) throw new NansenError(validation.error, validation.code);
  }
  return this.request('/api/v1/tgm/flow-intelligence', {
    token_address: tokenAddress,
    chain
  });
}
```

`cli.js:1246` passes `days`, but `api.js` destructures only `tokenAddress` and `chain`,
so **`--days` is never sent**. Verified two ways:

1. Direct raw HTTP with `{"chain":"monad","token_address":"0x...","date":{...}}` →
   `422 {"code":"unknown_field","param":"date"}`
2. Direct raw HTTP with `... ,"days":1}` → `422 {"code":"unknown_field","param":"days"}`

**Consequence:** the signal window is the endpoint's **default `timeframe`**, documented as
`"1d"`. Per the schema: `timeframe` enum is `["5m","1h","6h","12h","1d","7d"]`, `default: "1d"`.
It is **not** a rolling 24h window and it is **not owner-configurable through the CLI**.
The on-chain `windowSecs = 86400` was chosen to match one `1d` bucket.

### Field definitions (quoted from docs.nansen.ai/api/token-god-mode/flow-intelligence)

| Field | Docs definition |
|---|---|
| `<seg>_net_flow_usd` | "Net flow (USD) for addresses labeled as \<Segment\>" |
| `<seg>_wallet_count` | "Unique wallet count for \<Segment\> addresses" |
| `<seg>_avg_flow_usd` | "**Geometric mean of absolute flow** for \<Segment\> addresses" |
| `exchange_wallet_count` | "Always 0 — exchange wallet count is not tracked, even when exchange net flow is non-zero." |
| `fresh_wallets_*` | "Only available for 1d and 7d timeframes." |

Because `avg_flow_usd` is a **geometric mean of absolute flow**, `avg_flow_usd × wallet_count`
is **not** expected to equal `net_flow_usd`. Any observation of that mismatch is a property of
the metric, not an API fault.

### Data freshness (quoted)

> "Recent (~last 24h) data is live; older data comes from an hourly batch and can lag up to
> about an hour. **Responses are cached 10–30 minutes depending on timeframe.**"

This documented 10–30 minute cache explains why repeated polls within that window return
byte-identical numbers.

### Segments used for the decision

`smart_trader`, `top_pnl`, `whale`

```
netFlowUsd      = sum of net_flow_usd across the three segments
distributionUsd = floor(max(0, -(netFlowSum)))
usable          = (sum of *_wallet_count) >= minWalletCount   // minWalletCount = 2
```

Segments deliberately **excluded** from decisions:
- `exchange` / CEX flow — exchange inflow/outflow is not smart-money distribution.
- `fresh_wallets` — not smart money.
- `public_figure` — removed per owner instruction.

---

## 2. Recorded evidence and the window sidecar

The raw response body of every REST call is written verbatim to
`fixtures/<UTCts>_<SYMBOL>.json` and `logs/poll/<UTCts>_<SYMBOL>.json`. Alongside it a
`<UTCts>_<SYMBOL>.meta.json` sidecar records the request that produced it:

```json
{
  "symbol": "WMON",
  "token": "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
  "chain": "monad",
  "timeframe": "6h",
  "timeframeSeconds": 21600,
  "endpoint": "https://api.nansen.ai/api/v1/tgm/flow-intelligence",
  "recordedAt": "2026-10-12T09:14:09.552Z",
  "ok": true,
  "rawFile": "fixtures/20261012T091409Z_WMON.json"
}
```

The decision loop reads the window **from this sidecar**, never from the on-chain policy, and
skips the token with a `WindowMismatch` line if `timeframeSeconds` differs from
`policy.windowSecs`, or if the sidecar is missing.

`evidenceHash` passed to `ExitGuard.protect()` is `keccak256()` over the exact bytes of the raw
JSON file, so the on-chain `Protected` event commits to the precise Nansen response that
justified the call. On a live trigger both the raw file and its sidecar are copied into
`fixtures/_evidence/`. Verify with:

```bash
cast keccak 0x$(xxd -p < fixtures/_evidence/<file>.json | tr -d '\n')
```

Measured example:

```
loop:   0xbb77640bf11a101bccf96ac542e68a37c0780194b1091da1a0bb818700cbba15
cast:   0xbb77640bf11a101bccf96ac542e68a37c0780194b1091da1a0bb818700cbba15   (match)
```

---

## 3. `nansen research token holders` — investigation only (5 credits)

```
nansen research token holders --chain monad --token <tokenAddress>
```
Used once during investigation to look for the wallets behind a segment figure.
**Not used in any decision path.** Not called by the agent at runtime.

## 4. `nansen research token who-bought-sold` — investigation only (1 credit)

```
nansen research token who-bought-sold --chain monad --token <tokenAddress> --days 1
```
Called once during investigation. **Not used in any decision path.**

## 5. `nansen account` — free balance check (0 credits)

Used to report credit consumption.

## 6. `nansen research smart-money netflow` — tried and rejected (5 credits/call)

```
nansen research smart-money netflow --chain monad --limit 10
```
Returns `{"data": [], ...}` on Monad — no chain-wide smart-money netflow rows. Superseded
by `tgm/flow-intelligence`, which does return per-token label segments on Monad. Not used at runtime.

## 7. `nansen research token flows` — tried, not used (1 credit/call)

Works on Monad for non-stablecoins, but its own API warning redirects to flow-intelligence:
> "For net flow per holder segment (e.g. smart money), use POST /api/v1/tgm/flow-intelligence."

Also returns `422 INVALID_TOKEN` for stablecoins (e.g. USDC). Not used at runtime.

---

## Cost summary for the running system

| Loop | Calls/poll | Credits/poll | Credits/day @5min |
|---|---|---|---|
| recorder (4 tokens: WMON, FOLKS, WETH, cbBTC) | 4 | 4 | 1152 |
| decision loop | **0** (reads `fixtures/`) | **0** | **0** |

`flow-intelligence` costs **1 credit** per call on both Free and Pro. Only successful `2xx`
responses are charged; `422` validation errors cost nothing.

The decision loop performs **no Nansen calls** — it reads the recorded fixtures, which is why
DRY_RUN, REPLAY and LIVE all share identical decision logic at zero marginal cost.
