import fs from "node:fs";
import path from "node:path";
import {
  flowIntelligence,
  parseFlowIntelligence,
  saveRaw,
  ensureDir,
  timestampCompact,
} from "./nansen.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "agent", "config.json"), "utf8"));
const FIELDS: string[] = CFG.signalFields; // smart_trader, top_pnl, whale
const MIN_WALLETS = CFG.decision.minWalletCount;

const LIST = JSON.parse(fs.readFileSync("/tmp/opencode/probe_list.json", "utf8"));
// Exclude real stablecoins only. LSTs (WBTC, BTC.b, wstETH, weETH, ezETH, rsETH,
// STONE, WBETH) are deliberately NOT excluded - they are assets, not stables.
const STABLE = new Set(
  [
    "USDC","USDT","USDT0","USD1","AUSD","DAI","LVUSD","USDE","USDe","mUSD","USDF","USD0",
    "USDG","BOLD","CRVUSD","LUSD","RLUSD","PYUSD","FDUSD","TUSD","USDbC","USDS","FRAX",
    "EURS","EURC","EURI","AGEUR","XSGD","OUSD","SUSD","MUSD","RAI","USDJ","USTC","USDY","USDX",
    "AA_FalconXUSDC",
  ].map((s) => s.toUpperCase()),
);

const probeDir = ensureDir(path.join(ROOT, "logs", "probe"));
const ts = timestampCompact(new Date());
const results: any[] = [];

let credits = 0;
const CAP = Number(process.env.PROBE_CAP ?? 150);

console.log(`PROBE-ALL candidates=${LIST.length} cap=${CAP} fields=${FIELDS.join("+")}`);

for (const t of LIST) {
  if ((t.symbol || "").toUpperCase().startsWith("USDC") && t.symbol !== "AA_FalconXUSDC") {
    continue;
  }
  if (STABLE.has((t.symbol || "").toUpperCase())) continue;
  if (credits >= CAP) {
    console.log(`credit cap ${CAP} reached - stopping`);
    break;
  }

  const { raw, ok, error, code } = flowIntelligence(CFG.chain, t.address, 1);
  if (ok) credits += CFG.costPerCall;

  const file = path.join(probeDir, `${ts}_${t.symbol}_${t.address}.json`);
  saveRaw(probeDir, path.basename(file), raw);

  const row = ok ? parseFlowIntelligence(raw) : null;
  const segs: Record<string, { netFlowUsd: number; walletCount: number }> = {};
  let walletSum = 0;
  let netSum = 0;
  if (row) {
    for (const f of FIELDS) {
      const nf = typeof row[`${f}_net_flow_usd`] === "number" ? row[`${f}_net_flow_usd`] : 0;
      const wc = typeof row[`${f}_wallet_count`] === "number" ? row[`${f}_wallet_count`] : 0;
      segs[f] = { netFlowUsd: nf, walletCount: wc };
      walletSum += wc;
      netSum += nf;
    }
  }

  results.push({
    symbol: t.symbol,
    address: t.address,
    ok,
    error,
    code,
    segments: segs,
    walletCountSum: walletSum,
    netFlowUsd: netSum,
    distributionUsd: Math.floor(Math.max(0, -netSum)),
    qualifies: walletSum >= MIN_WALLETS,
    rawFile: path.relative(ROOT, file),
  });
  console.log(
    `${(t.symbol || "?").padEnd(16)} ok=${ok} wallets=${walletSum} net=${netSum.toFixed(2)}${ok ? "" : " " + (code ?? error)}`,
  );
}

fs.writeFileSync(
  path.join(probeDir, "probe-all-summary.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), chain: CFG.chain, fields: FIELDS, creditsSpent: credits, results }, null, 2),
);

console.log(`\n=== QUALIFYING (walletCountSum >= ${MIN_WALLETS}) ===`);
for (const r of results.filter((r) => r.qualifies)) {
  const s = FIELDS.map(
    (f) => `${f}=${r.segments[f].netFlowUsd.toFixed(2)}/${r.segments[f].walletCount}w`,
  ).join("  ");
  console.log(
    `${(r.symbol || "?").padEnd(16)} ${r.address}  ${s}  | wallets=${r.walletCountSum} net=${r.netFlowUsd.toFixed(2)} dist=${r.distributionUsd}`,
  );
}
console.log(`\ncredits spent: ${credits}`);
