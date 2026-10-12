import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// Load project .env into process.env BEFORE shelling out to nansen, because the
// nansen CLI only reads NANSEN_API_KEY from the environment / ~/.nansen/config.json.
dotenv.config({ path: path.join(ROOT, ".env") });

export const CHAIN = "monad";

/** Timeframe used by the decision path. Valid per API schema: 5m|1h|6h|12h|1d|7d */
export const TIMEFRAME = (process.env.NANSEN_TIMEFRAME ?? "6h") as
  | "5m" | "1h" | "6h" | "12h" | "1d" | "7d";

export const TIMEFRAME_SECONDS: Record<string, number> = {
  "5m": 300,
  "1h": 3600,
  "6h": 21600,
  "12h": 43200,
  "1d": 86400,
  "7d": 604800,
};

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function timestampCompact(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export function getApiKey(): string {
  const k = process.env.NANSEN_API_KEY;
  if (!k) throw new Error("NANSEN_API_KEY is not set (load .env first)");
  return k;
}

/* ------------------------------------------------------------------ *
 * REST: POST /api/v1/tgm/flow-intelligence  (the decision path)
 * ------------------------------------------------------------------ */

export type FlowResult = {
  raw: string;
  ok: boolean;
  timeframe: string;
  error?: string;
  code?: string;
};

/**
 * Direct REST call to the decision endpoint.
 *
 * The nansen CLI (v1.21.0) drops `--days`/timeframe entirely
 * (src/api.js:1047-1058 sends only {token_address, chain}), so the REST call is
 * used for anything that needs an explicit window. Verified: `date` and `days`
 * are rejected with 422 unknown_field, `timeframe` is accepted.
 */
export function flowIntelligenceREST(
  chain: string,
  token: string,
  timeframe: string = TIMEFRAME,
): FlowResult {
  const body = JSON.stringify({ token_address: token, chain, timeframe });
  let raw = "";
  try {
    raw = execFileSync(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "https://api.nansen.ai/api/v1/tgm/flow-intelligence",
        "-H",
        `apikey: ${getApiKey()}`,
        "-H",
        "Content-Type: application/json",
        "-d",
        body,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env },
    );
  } catch (e: any) {
    raw = e?.stdout?.toString() ?? "";
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (parsed && parsed.error) {
    return { raw, ok: false, timeframe, error: parsed.message ?? parsed.error, code: parsed.code };
  }
  if (parsed && !Array.isArray(parsed.data)) {
    return { raw, ok: false, timeframe, error: "unexpected response shape", code: parsed.code };
  }
  return { raw, ok: true, timeframe };
}

/* ------------------------------------------------------------------ *
 * CLI: kept for probing / discovery
 * ------------------------------------------------------------------ */

export function runNansen(args: string[]): { raw: string; ok: boolean; error?: string; code?: string } {
  let raw = "";
  try {
    raw = execFileSync("nansen", args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
  } catch (e: any) {
    raw = e?.stdout?.toString() ?? "";
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    return { raw, ok: false, error: parsed?.error ?? e?.message ?? "unknown", code: parsed?.code };
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (parsed && parsed.success === false) {
    return { raw, ok: false, error: parsed.error, code: parsed.code };
  }
  return { raw, ok: true };
}

export function flowIntelligenceCLI(chain: string, token: string, days = 1) {
  return runNansen([
    "research",
    "token",
    "flow-intelligence",
    "--chain",
    chain,
    "--token",
    token,
    "--days",
    String(days),
  ]);
}

export function parseFlowIntelligence(raw: string): Record<string, any> | null {
  try {
    const j = JSON.parse(raw);
    // CLI shape: { success, data: { data: [row] } }
    // REST shape: { data: [row] }
    const row = j?.data?.data?.[0] ?? (Array.isArray(j?.data) ? j.data[0] : null);
    return row ?? null;
  } catch {
    return null;
  }
}

export const SEGMENTS = [
  "smart_trader",
  "whale",
  "top_pnl",
  "public_figure",
  "fresh_wallets",
  "exchange",
] as const;

export type Segment = (typeof SEGMENTS)[number];

export function walletCount(row: Record<string, any>, seg: Segment): number {
  const v = row?.[`${seg}_wallet_count`];
  return typeof v === "number" ? v : 0;
}

export function netFlow(row: Record<string, any>, seg: Segment): number {
  const v = row?.[`${seg}_net_flow_usd`];
  return typeof v === "number" ? v : 0;
}

export function saveRaw(dir: string, name: string, body: string): string {
  ensureDir(dir);
  const p = path.join(dir, name);
  writeFileSync(p, body);
  return p;
}
