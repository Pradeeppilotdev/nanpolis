import http from "node:http";
import { fileURLToPath } from "node:url";
import { TIMEFRAME_SECONDS, parseFlowIntelligence } from "./nansen.ts";
import { decide, validateFixture } from "./signal.ts";
import { sampleSnapshot } from "./replay.ts";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const PORT = Number(process.env.PORT ?? 8791);

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Historical points retain their original recording time and validated window. */
export function history(root = ROOT) {
  const cfg = readJson(path.join(root, "agent", "config.json")) ?? {};
  const fields: string[] = Array.isArray(cfg.signalFields) ? cfg.signalFields : ["smart_trader", "top_pnl", "whale"];
  const timeframe: string = process.env.NANSEN_TIMEFRAME ?? cfg.timeframe?.default ?? "6h";
  const dir = path.join(root, "fixtures");
  const series: Record<string, { t: string; netFlowUsd: number; walletCountSum: number }[]> = Object.create(null);
  if (!fs.existsSync(dir)) return { timeframe, series };

  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.endsWith(".meta.json")) continue;
    const meta = readJson(path.join(dir, f.replace(/\.json$/, ".meta.json")));
    if (!meta || typeof meta.symbol !== "string" || meta.timeframe !== timeframe || typeof meta.recordedAt !== "string") continue;
    const token = Array.isArray(cfg.tokens) ? cfg.tokens.find((t: any) => t.symbol === meta.symbol) : null;
    // History may be old; identity, success, timestamp and window still must be valid.
    if (!token || validateFixture(meta, token, TIMEFRAME_SECONDS, Date.now(), Infinity)) continue;
    const raw = readJson(path.join(dir, f));
    const row = parseFlowIntelligence(JSON.stringify(raw));
    if (!row) continue;
    const signal = decide(row, fields, 0);
    if (!signal.usable) continue;
    (series[meta.symbol] ??= []).push({ t: new Date(meta.recordedAt).toISOString(), netFlowUsd: signal.netFlowUsd, walletCountSum: signal.walletCountSum });
  }
  for (const k of Object.keys(series)) {
    series[k].sort((a, b) => a.t.localeCompare(b.t));
    series[k] = series[k].slice(-288);
  }
  return { timeframe, series };
}

/** Pure routing boundary keeps malformed local files from terminating the server. */
export function apiResponse(url: string, method = "GET", root = ROOT, demo = process.env.DEMO_MODE === "1"): { status: number; body: unknown } {
  try {
    if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "Method not allowed" } };
    const pathname = new URL(url, "http://localhost").pathname;
    if (pathname === "/api/history") return { status: 200, body: demo ? { timeframe: "unknown", series: {} } : history(root) };
    if (pathname === "/api/protections") {
      if (demo) return { status: 200, body: [] };
      const file = path.join(root, "logs", "protections.json");
      const data = fs.existsSync(file) ? readJson(file) : [];
      return Array.isArray(data) ? { status: 200, body: data } : { status: 503, body: { error: "Protection history unavailable" } };
    }
    if (pathname === "/api/latest") {
      if (demo) return { status: 200, body: sampleSnapshot() };
      const data = readJson(path.join(root, "logs", "latest.json"));
      return data && Array.isArray(data.tokens) ? { status: 200, body: data } : { status: 503, body: { error: "No valid recorder snapshot yet" } };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch {
    return { status: 503, body: { error: "Agent data unavailable" } };
  }
}

export function createApiServer() {
  return http.createServer((req, res) => {
    const { status, body } = apiResponse(req.url ?? "/", req.method);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createApiServer().listen(PORT, process.env.HOST ?? "127.0.0.1", () => console.log(`agent api on http://127.0.0.1:${PORT}  GET /api/latest /api/protections /api/history`));
}
