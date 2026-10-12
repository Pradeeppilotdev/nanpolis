import fs from "node:fs";
import path from "node:path";
import {
  flowIntelligenceREST,
  parseFlowIntelligence,
  saveRaw,
  ensureDir,
  timestampCompact,
  TIMEFRAME,
  TIMEFRAME_SECONDS,
} from "./nansen.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "agent", "config.json"), "utf8"));
const SIGNAL_FIELDS: string[] = CFG.signalFields;
const MIN_WALLETS: number = CFG.decision.minWalletCount;
const intervalSec = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);

const fixtureDir = ensureDir(path.join(ROOT, "fixtures"));
const pollDir = ensureDir(path.join(ROOT, "logs", "poll"));
const latestFile = path.join(ROOT, "logs", "latest.json");

let lastBucket: string | null = null;

function log(line: string) {
  const s = `${timestampCompact(new Date())} ${line}`;
  console.log(s);
  fs.appendFileSync(path.join(ROOT, "logs", "recorder.log"), s + "\n");
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function pollOnce() {
  const now = new Date();
  const ts = timestampCompact(now);
  const day = utcDay(now);
  const bucketReset = lastBucket !== null && lastBucket !== day;
  lastBucket = day;

  if (bucketReset) log(`[BUCKET_RESET_00:00_UTC] UTC day rolled to ${day}`);

  const latest: any = {
    generatedAt: now.toISOString(),
    timeframe: TIMEFRAME,
    timeframeSeconds: TIMEFRAME_SECONDS[TIMEFRAME] ?? null,
    bucketDateUtc: day,
    bucketReset,
    signalSource: "REST POST /api/v1/tgm/flow-intelligence",
    endpoint: "https://api.nansen.ai/api/v1/tgm/flow-intelligence",
    costPerCall: CFG.costPerCall,
    signalFields: SIGNAL_FIELDS,
    minWalletCount: MIN_WALLETS,
    tokens: [],
  };

  for (const t of CFG.tokens) {
    const { raw, ok, error, code } = flowIntelligenceREST(t.signalChain, t.token, TIMEFRAME);
    const rawName = `${ts}_${t.symbol}.json`;
    saveRaw(fixtureDir, rawName, raw);
    saveRaw(pollDir, rawName, raw);

    // Record the requested timeframe alongside the raw bytes so every saved
    // response is self-describing.
    fs.writeFileSync(
      path.join(fixtureDir, rawName.replace(/\.json$/, ".meta.json")),
      JSON.stringify(
        {
          symbol: t.symbol,
          token: t.token,
          chain: t.signalChain,
          timeframe: TIMEFRAME,
          timeframeSeconds: TIMEFRAME_SECONDS[TIMEFRAME] ?? null,
          endpoint: latest.endpoint,
          recordedAt: now.toISOString(),
          ok,
          code,
          error,
          rawFile: `fixtures/${rawName}`,
        },
        null,
        2,
      ),
    );

    const row = ok ? parseFlowIntelligence(raw) : null;
    if (!row) {
      latest.tokens.push({
        symbol: t.symbol,
        token: t.token,
        role: t.role,
        canTrigger: t.canTrigger ?? false,
        signalChain: t.signalChain,
        executionChain: t.executionChain,
        timeframe: TIMEFRAME,
        usable: false,
        skipReason: `nansen error: ${code ?? ""} ${error ?? "no row"}`,
        rawFile: `fixtures/${rawName}`,
      });
      log(`${t.symbol} tf=${TIMEFRAME} ERROR ${code ?? ""} ${error ?? ""} -> skipped, never faked`);
      continue;
    }

    const segments: Record<string, { netFlowUsd: number; walletCount: number }> = {};
    let netFlowSum = 0;
    let walletSum = 0;
    for (const f of SIGNAL_FIELDS) {
      const nf = typeof row[`${f}_net_flow_usd`] === "number" ? row[`${f}_net_flow_usd`] : 0;
      const wc = typeof row[`${f}_wallet_count`] === "number" ? row[`${f}_wallet_count`] : 0;
      segments[f] = { netFlowUsd: nf, walletCount: wc };
      netFlowSum += nf;
      walletSum += wc;
    }

    const distributionUsd = Math.floor(Math.max(0, -netFlowSum));
    const usable = walletSum >= MIN_WALLETS;

    latest.tokens.push({
      symbol: t.symbol,
      token: t.token,
      role: t.role,
      canTrigger: t.canTrigger ?? false,
      signalChain: t.signalChain,
      executionChain: t.executionChain,
      timeframe: TIMEFRAME,
      endpoint: latest.endpoint,
      bucketDateUtc: day,
      bucketReset,
      signalFields: SIGNAL_FIELDS,
      segments,
      netFlowUsd: netFlowSum,
      distributionUsd,
      walletCountSum: walletSum,
      minWalletCount: MIN_WALLETS,
      usable,
      skipReason: usable ? null : `walletCountSum ${walletSum} < minWalletCount ${MIN_WALLETS}`,
      rawFile: `fixtures/${rawName}`,
      logFile: `logs/poll/${rawName}`,
    });

    const segStr = SIGNAL_FIELDS.map(
      (f) => `${f}=${segments[f].netFlowUsd.toFixed(2)}/${segments[f].walletCount}w`,
    ).join(" ");
    log(
      `${t.symbol} tf=${TIMEFRAME} ${segStr} | netFlowSum=${netFlowSum.toFixed(2)} dist=${distributionUsd} wallets=${walletSum}/${MIN_WALLETS} usable=${usable}` +
        (bucketReset ? " [BUCKET_RESET_00:00_UTC]" : ""),
    );
  }

  fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2));
}

log(
  `recorder start interval=${intervalSec}s timeframe=${TIMEFRAME} tokens=${CFG.tokens.length} fields=${SIGNAL_FIELDS.join("+")} minWalletCount=${MIN_WALLETS} source=REST`,
);
await pollOnce();
setInterval(() => {
  pollOnce().catch((e) => log(`poll error: ${e?.message ?? e}`));
}, intervalSec * 1000);
