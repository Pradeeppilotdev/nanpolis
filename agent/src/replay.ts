import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlowIntelligence } from './nansen.ts';
import { decide } from './signal.ts';
const root = path.resolve(import.meta.dirname, '../..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'agent/config.json'), 'utf8'));
export function sampleSnapshot() {
  const dir = path.join(root, 'fixtures/_sample');
  const tokens = cfg.tokens.map((token: any) => {
    const name = fs.readdirSync(dir).filter(f => f.endsWith(`_${token.symbol}.json`)).sort().at(-1);
    if (!name) return { ...token, usable: false, skipReason: 'No published sample', recordedAt: null };
    const date = name.slice(0, 16).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
    const row = parseFlowIntelligence(fs.readFileSync(path.join(dir, name), 'utf8'));
    return { ...token, ...(row ? decide(row, cfg.signalFields, cfg.decision.minWalletCount) : { usable: false }), recordedAt: date,
      timeframe: 'unknown', rawFile: `fixtures/_sample/${name}`, historical: true, canTrigger: false };
  });
  return { generatedAt: tokens.find((t: any) => t.recordedAt)?.recordedAt ?? null, mode: 'REPLAY', demo: true,
    timeframe: 'unknown', timeframeSeconds: null, signalFields: cfg.signalFields, minWalletCount: cfg.decision.minWalletCount,
    note: 'Historical published samples. Timeframe metadata is unavailable; policy eligibility is not evaluated. No transactions can be sent.', tokens };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(sampleSnapshot(), null, 2));
