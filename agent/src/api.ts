import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PORT = Number(process.env.PORT ?? 8791);

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Time series for the dashboard chart, built from the recorded Nansen responses.
 * Only responses that have a .meta.json sidecar for the CURRENT timeframe are used,
 * so every point on the chart covers the same window as the on-chain policy.
 */
function history() {
  const cfg = readJson(path.join(ROOT, "agent", "config.json")) ?? {};
  const fields: string[] = cfg.signalFields ?? ["smart_trader", "top_pnl", "whale"];
  const timeframe: string = process.env.NANSEN_TIMEFRAME ?? cfg.timeframe?.default ?? "6h";
  const dir = path.join(ROOT, "fixtures");
  const series: Record<string, { t: string; netFlowUsd: number; walletCountSum: number }[]> = {};
  if (!fs.existsSync(dir)) return { timeframe, series };

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".meta.json")) continue;
    const meta = readJson(path.join(dir, f.replace(/\.json$/, ".meta.json")));
    if (!meta || meta.timeframe !== timeframe || meta.ok === false) continue;
    const raw = readJson(path.join(dir, f));
    const row = raw?.data?.data?.[0] ?? (Array.isArray(raw?.data) ? raw.data[0] : null);
    if (!row) continue;

    let net = 0;
    let wallets = 0;
    for (const s of fields) {
      const nf = row[`${s}_net_flow_usd`];
      const wc = row[`${s}_wallet_count`];
      net += typeof nf === "number" ? nf : 0;
      wallets += typeof wc === "number" ? wc : 0;
    }
    (series[meta.symbol] ??= []).push({ t: meta.recordedAt, netFlowUsd: net, walletCountSum: wallets });
  }
  for (const k of Object.keys(series)) {
    series[k].sort((a, b) => a.t.localeCompare(b.t));
    series[k] = series[k].slice(-288); // about a day of 5-minute polls
  }
  return { timeframe, series };
}

function sendFile(res: http.ServerResponse, file: string, fallback?: string) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) {
      res.writeHead(200, { "content-type": "application/json" }).end(fallback);
    } else {
      res.writeHead(503).end("no data yet");
    }
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(fs.readFileSync(file));
}

http
  .createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/history")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(history()));
      return;
    }
    if (url.startsWith("/api/protections")) {
      sendFile(res, path.join(ROOT, "logs", "protections.json"), "[]");
      return;
    }
    if (url.startsWith("/api/latest")) {
      sendFile(res, path.join(ROOT, "logs", "latest.json"));
      return;
    }
    res.writeHead(404).end("not found");
  })
  .listen(PORT, () => console.log(`agent api on http://127.0.0.1:${PORT}  GET /api/latest /api/protections /api/history`));
