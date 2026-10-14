import fs from "node:fs";
import path from "node:path";
import {
  flowIntelligenceCLI as flowIntelligence,
  parseFlowIntelligence,
  walletCount,
  netFlow,
  saveRaw,
  ensureDir,
  timestampCompact,
  SEGMENTS,
} from "./nansen.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const TOKENS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "agent", "tokens.json"), "utf8"),
);

const days = Number(process.env.PROBE_DAYS ?? 1);
const chain = process.env.PROBE_CHAIN ?? TOKENS.chain;

const probeDir = ensureDir(path.join(ROOT, "logs", "probe"));
const summary: any[] = [];

console.log(
  `PROBE chain=${chain} days=${days} tokens=${TOKENS.tokens.length} (1 credit each)`,
);

for (const t of TOKENS.tokens) {
  const ts = timestampCompact(new Date());
  const { raw, ok, error, code } = flowIntelligence(chain, t.address, days);
  const file = path.join(probeDir, `${ts}_${t.symbol}_${t.address}.json`);
  saveRaw(probeDir, path.basename(file), raw);

  const row = ok ? parseFlowIntelligence(raw) : null;
  const counts: Record<string, number> = {};
  if (row) for (const s of SEGMENTS) counts[s] = walletCount(row, s);

  const anyNonZero = row && SEGMENTS.some((s) => counts[s] > 0);
  const rec = {
    ts,
    symbol: t.symbol,
    address: t.address,
    ok,
    error,
    code,
    counts,
    netflow: row
      ? Object.fromEntries(SEGMENTS.map((s) => [s, netFlow(row, s)]))
      : null,
    file: path.relative(ROOT, file),
  };
  summary.push(rec);

  const tag = !ok
    ? `ERROR ${code ?? ""} ${error}`
    : !anyNonZero
      ? "all-zero"
      : `HIT ${SEGMENTS.filter((s) => counts[s] > 0).map((s) => `${s}=${counts[s]}`).join(",")}`;
  console.log(`${t.symbol.padEnd(8)} ${tag}`);
}

fs.writeFileSync(
  path.join(ROOT, "logs", "probe", "probe-summary.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), chain, days, results: summary }, null, 2),
);

console.log("\n=== SUMMARY: tokens with any non-zero segment ===");
for (const r of summary.filter((r) => r.ok && r.counts && SEGMENTS.some((s) => r.counts[s] > 0))) {
  const segs = SEGMENTS.filter((s) => r.counts[s] > 0)
    .map((s) => `${s}:${r.counts[s]}@${r.netflow[s]?.toFixed?.(2) ?? r.netflow[s]}`)
    .join("  ");
  console.log(`${r.symbol.padEnd(8)} ${r.address}  ${segs}`);
}
console.log("\n=== tokens with no data (all zero or error) ===");
for (const r of summary.filter((r) => !r.ok || !SEGMENTS.some((s) => r.counts?.[s] > 0))) {
  console.log(`${r.symbol.padEnd(8)} ${r.ok ? "all-zero" : `error ${r.code}`}`);
}
