import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { monad } from "./chains";
import { AGENT, EXITGUARD, EXPLORER, OWNER, readVault, type VaultState } from "./chain";

/* ------------------------------------------------------------------ types */

type Seg = { netFlowUsd: number; walletCount: number };
type Tok = {
  symbol: string;
  token: string;
  role?: string;
  canTrigger?: boolean;
  segments?: Record<string, Seg>;
  netFlowUsd?: number;
  distributionUsd?: number;
  walletCountSum?: number;
  minWalletCount?: number;
  usable?: boolean;
  skipReason?: string | null;
};
type Latest = {
  generatedAt: string;
  timeframe: string;
  timeframeSeconds: number | null;
  signalFields: string[];
  minWalletCount: number;
  tokens: Tok[];
};
type Prot = {
  txHash: string;
  symbol: string;
  token: string;
  bps: number;
  amountMoved: string | null;
  distributionUsd: number;
  windowSecs: number;
  timeframe?: string;
  evidenceHash: string;
  evidenceFile: string;
  explorer: string;
  at: string;
};
type Pt = { t: string; netFlowUsd: number; walletCountSum?: number };

/* ---------------------------------------------------------------- helpers */

const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
const usdSigned = (n: number) => (n < 0 ? "\u2212" : n > 0 ? "+" : "") + usd(Math.abs(n));
const compact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1000 ? `${+(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `${Math.round(a)}`;
  return (n < 0 ? "\u2212" : "") + "$" + s;
};
const short = (a: string) => `${a.slice(0, 6)}\u2026${a.slice(-4)}`;
const TF_WORDS: Record<string, string> = {
  "5m": "5 minutes",
  "1h": "hour",
  "6h": "6 hours",
  "12h": "12 hours",
  "1d": "24 hours",
  "7d": "7 days",
};
const dur = (secs: number) => {
  if (secs % 3600 === 0) return `${secs / 3600} ${secs === 3600 ? "hour" : "hours"}`;
  return `${Math.round(secs / 60)} min`;
};
const ago = (ms: number) => {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

const copy = (s: string) => {
  try {
    navigator.clipboard?.writeText(s);
  } catch {
    /* clipboard unavailable */
  }
};

function usePoll<T>(url: string, ms: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && d && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url, ms]);
  return data;
}

function useNow(ms = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ------------------------------------------------------------------- icons */

const Ext = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 2.5h5v5M9.5 2.5 3 9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const CopyIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    <path d="M9 2.5H3.5a1 1 0 0 0-1 1V9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
const Mark = () => (
  <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
    <rect width="30" height="30" rx="9" fill="var(--violet)" />
    <path d="M6 20c3-1 5-6 9-6s6 5 9 6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
    <path d="M6 11h18" stroke="var(--amber)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="1 4.2" />
  </svg>
);

/* ----------------------------------------------------------------- pieces */

function CopyChip({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="chip-btn"
      aria-label={label}
      onClick={() => {
        copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? "Copied" : <CopyIcon />}
    </button>
  );
}

function DivBar({ value, scale }: { value: number; scale: number }) {
  const w = Math.min(Math.abs(value) / scale, 1) * 50;
  return (
    <div className="div-bar" role="img" aria-label={usdSigned(value)}>
      <span className="div-mid" />
      {value < 0 && <span className="div-fill neg" style={{ width: `${w}%` }} />}
      {value > 0 && <span className="div-fill pos" style={{ width: `${w}%` }} />}
    </div>
  );
}

const SEG_NAMES: Record<string, string> = {
  smart_trader: "Smart traders",
  top_pnl: "Top PnL wallets",
  whale: "Whales",
};

/* ------------------------------------------------------------- tripwire */

function Tripwire({
  vault,
  state,
  latest,
  maxMove,
  coolMin,
}: {
  vault: Tok | undefined;
  state: VaultState | null;
  latest: Latest | null;
  maxMove: string | null;
  coolMin: number;
}) {
  const thr = state?.policy.thresholdUsd ?? 0;
  const dist = vault?.distributionUsd ?? 0;
  const net = vault?.netFlowUsd ?? 0;
  const over = !!vault?.usable && thr > 0 && dist >= thr;
  const scaleMax = Math.max(thr * 2.2, dist * 1.12, 500);
  const fillPct = Math.min((dist / scaleMax) * 100, 100);
  const thrPct = Math.min((thr / scaleMax) * 100, 100);
  const tfWords = TF_WORDS[latest?.timeframe ?? ""] ?? latest?.timeframe ?? "";
  const segs = latest?.signalFields ?? ["smart_trader", "top_pnl", "whale"];
  const segMax = Math.max(1000, ...segs.map((s) => Math.abs(vault?.segments?.[s]?.netFlowUsd ?? 0)));

  let status = { cls: "wait", text: "Waiting for first reading" };
  if (vault && !vault.usable) status = { cls: "wait", text: "Not enough wallets to judge" };
  else if (vault && over && coolMin > 0) status = { cls: "cool", text: "Over your line, paused" };
  else if (vault && over) status = { cls: "over", text: "Over your line" };
  else if (vault) status = { cls: "under", text: "Under your line" };

  let headline: ReactNode;
  if (!vault) {
    headline = <>The agent has not reported a reading yet.</>;
  } else if (!vault.usable) {
    headline = (
      <>
        Only {vault.walletCountSum ?? 0} smart {vault.walletCountSum === 1 ? "wallet" : "wallets"} traded WMON in the
        last {tfWords}. The guard needs {latest?.minWalletCount ?? 2} before it will judge.
      </>
    );
  } else if (net < 0) {
    headline = (
      <>
        Smart wallets net sold <b className="n-neg">{usd(dist)}</b> of WMON in the last {tfWords}.
        {thr > 0 && (
          <>
            {" "}
            Your line is <b className="n-amber">{usd(thr)}</b>.
          </>
        )}
      </>
    );
  } else {
    headline = (
      <>
        Smart wallets net bought <b className="n-pos">{usd(net)}</b> of WMON in the last {tfWords}. Your line is{" "}
        <b className="n-amber">{usd(thr)}</b> of selling.
      </>
    );
  }

  const labelLeft = Math.min(Math.max(fillPct, 9), 91);

  return (
    <section className={`panel hero state-${status.cls}`} aria-labelledby="tw-title">
      <div className="panel-head">
        <h2 id="tw-title">WMON selling pressure</h2>
        <span className={`badge ${status.cls}`}>
          <i />
          {status.text}
        </span>
      </div>

      <p className="headline">{headline}</p>

      <div className="meter" aria-label={`Selling pressure ${usd(dist)} against a line of ${usd(thr)}`}>
        <div className="meter-track">
          {thr > 0 && <div className="meter-zone" style={{ left: `${thrPct}%` }} />}
          <div className="meter-fill" style={{ width: `${fillPct}%` }} />
        </div>
        {thr > 0 && (
          <div className="meter-line" style={{ left: `${thrPct}%` }}>
            <span className={`meter-line-label ${thrPct < 12 ? "al-left" : ""}`}>Your line {usd(thr)}</span>
          </div>
        )}
        {vault && (
          <div className="meter-now" style={{ left: `${labelLeft}%` }}>
            <span>Now {usd(dist)}</span>
          </div>
        )}
        <div className="meter-scale">
          <span>$0</span>
          <span>{usd(scaleMax)}</span>
        </div>
      </div>

      <div className="segs">
        <div className="segs-head">
          <span>Who is moving</span>
          <span>Net flow, last {tfWords}</span>
        </div>
        {segs.map((s) => {
          const g = vault?.segments?.[s];
          const empty = !g || g.walletCount === 0;
          return (
            <div className={`seg ${empty ? "idle" : ""}`} key={s}>
              <div className="seg-name">
                {SEG_NAMES[s] ?? s}
                <small>{empty ? "no wallets active" : `${g.walletCount} ${g.walletCount === 1 ? "wallet" : "wallets"}`}</small>
              </div>
              <DivBar value={empty ? 0 : g.netFlowUsd} scale={segMax} />
              <div className={`seg-val ${!empty && g.netFlowUsd < 0 ? "n-neg" : !empty && g.netFlowUsd > 0 ? "n-pos" : ""}`}>
                {empty ? "\u2014" : usdSigned(g.netFlowUsd)}
              </div>
            </div>
          );
        })}
      </div>

      <p className="foot-note">
        {coolMin > 0 ? (
          <>
            The agent is paused for <b>{coolMin} more min</b> after its last trigger. When the pause ends it can act again
            if selling is still over your line.
          </>
        ) : state && maxMove ? (
          <>
            If the agent triggers, it can move at most <b>{maxMove} WMON</b> ({state.policy.maxBps / 100}% of your
            vault) to your safe address {short(state.policy.safeAddr)}, and only inside the rules on the right.
          </>
        ) : (
          <>The policy loads from the contract.</>
        )}
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- vault */

function VaultPanel({
  vault,
  state,
  protections,
  now,
}: {
  vault: Tok | undefined;
  state: VaultState | null;
  protections: Prot[];
  now: number;
}) {
  const dec = 18;
  const dep = state?.deposit ?? 0n;
  const moved = protections
    .filter((p) => vault && p.token.toLowerCase() === vault.token.toLowerCase())
    .reduce((a, p) => a + (p.amountMoved ? BigInt(p.amountMoved) : 0n), 0n);
  const fmt = (v: bigint) => (+formatUnits(v, dec)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const p = state?.policy;

  let next = "Ready";
  if (p && p.lastTrigger > 0) {
    const ready = (p.lastTrigger + p.cooldownSecs) * 1000;
    next = now >= ready ? "Ready" : `Paused for ${Math.ceil((ready - now) / 60000)} more min`;
  }

  return (
    <aside className="panel vault" aria-labelledby="v-title">
      <div className="panel-head">
        <h2 id="v-title">Your vault</h2>
        <a className="ext" href={`${EXPLORER}/address/${EXITGUARD}`} target="_blank" rel="noreferrer">
          Contract <Ext />
        </a>
      </div>

      <div className="vault-big">
        <span className="vault-num">{state ? fmt(dep) : "\u2026"}</span>
        <span className="vault-unit">WMON in the vault</span>
      </div>
      <div className="vault-split" aria-label="Protected so far">
        <div className="vs-bar">
          <span style={{ width: `${dep + moved > 0n ? Number((moved * 10000n) / (dep + moved)) / 100 : 0}%` }} />
        </div>
        <div className="vs-text">
          <span>Moved to safety so far</span>
          <b>{fmt(moved)} WMON</b>
        </div>
      </div>

      <dl className="rules">
        <div>
          <dt>Trigger line</dt>
          <dd>{p ? usd(p.thresholdUsd) : "\u2026"}</dd>
        </div>
        <div>
          <dt>Signal window</dt>
          <dd>{p ? dur(p.windowSecs) : "\u2026"}</dd>
        </div>
        <div>
          <dt>Most it can move</dt>
          <dd>{p ? `${p.maxBps / 100}% per trigger` : "\u2026"}</dd>
        </div>
        <div>
          <dt>Pause between triggers</dt>
          <dd>{p ? dur(p.cooldownSecs) : "\u2026"}</dd>
        </div>
        <div>
          <dt>Last trigger</dt>
          <dd>{p ? (p.lastTrigger === 0 ? "Never" : new Date(p.lastTrigger * 1000).toLocaleString()) : "\u2026"}</dd>
        </div>
        <div>
          <dt>Next trigger</dt>
          <dd>{p ? next : "\u2026"}</dd>
        </div>
      </dl>

      <div className="who">
        <div>
          <span>Agent allowed to trigger</span>
          <a href={`${EXPLORER}/address/${p?.guard ?? AGENT}`} target="_blank" rel="noreferrer">
            {p && p.guard === zeroAddress ? "Revoked" : short(p?.guard ?? AGENT)}
          </a>
        </div>
        <div>
          <span>Funds can only go to</span>
          <a href={`${EXPLORER}/address/${p?.safeAddr ?? OWNER}`} target="_blank" rel="noreferrer">
            {short(p?.safeAddr ?? OWNER)}
          </a>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------- protection log */

function ProtectionLog({ protections, decimals }: { protections: Prot[]; decimals: number }) {
  const list = [...protections].reverse();
  return (
    <section className="panel log" aria-labelledby="log-title">
      <div className="panel-head">
        <h2 id="log-title">Protection log</h2>
        <span className="muted">{list.length === 0 ? "Nothing has fired yet" : `${list.length} on record`}</span>
      </div>

      {list.length === 0 ? (
        <div className="log-empty">
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="21" fill="none" stroke="var(--line)" />
            <path d="M10 28c4-1 6-8 12-8s8 7 12 8" fill="none" stroke="var(--faint)" strokeWidth="2" strokeLinecap="round" />
            <path d="M10 15h24" stroke="var(--amber)" strokeWidth="2" strokeLinecap="round" strokeDasharray="1 5" />
          </svg>
          <p>
            When selling pressure crosses your line and the agent acts, the transaction appears here with the exact
            Nansen response that justified it.
          </p>
        </div>
      ) : (
        <ul className="events">
          {list.map((p) => {
            const amt = p.amountMoved ? (+formatUnits(BigInt(p.amountMoved), decimals)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "\u2026";
            const cmd = `cast keccak 0x$(xxd -p < ${p.evidenceFile} | tr -d '\\n')`;
            return (
              <li key={p.txHash} className="event">
                <div className="ev-main">
                  <div className="ev-amount">
                    <b>{amt}</b> {p.symbol} moved to your safe address
                  </div>
                  <div className="ev-facts">
                    <span>{new Date(p.at).toLocaleString()}</span>
                    <span>{p.bps / 100}% of the vault</span>
                    <span>
                      {usd(p.distributionUsd)} sold over {dur(p.windowSecs)}
                    </span>
                  </div>
                  <div className="ev-hash">
                    <span>Nansen response fingerprint</span>
                    <code>{short(p.evidenceHash)}</code>
                    <CopyChip text={p.evidenceHash} label="Copy fingerprint" />
                  </div>
                  <details>
                    <summary>Check it yourself</summary>
                    <p>
                      Hash the saved Nansen response. It should equal the fingerprint recorded onchain in the
                      transaction.
                    </p>
                    <div className="cmd">
                      <code>{cmd}</code>
                      <CopyChip text={cmd} label="Copy command" />
                    </div>
                    <small>{p.evidenceFile}</small>
                  </details>
                </div>
                <a className="btn-link" href={p.explorer} target="_blank" rel="noreferrer">
                  View transaction <Ext />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- chart */

function niceTicks(min: number, max: number, n = 5) {
  const span = max - min || 1;
  const raw = span / (n - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.01; v += step) out.push(Math.round(v));
  return out;
}

function HistoryChart({ points, thr, tfWords }: { points: Pt[]; thr: number; tfWords: string }) {
  const W = 900,
    H = 290,
    L = 58,
    R = 18,
    T = 16,
    B = 30;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const ts = points.map((p) => new Date(p.t).getTime());
    const vs = points.map((p) => p.netFlowUsd);
    const t0 = ts[0],
      t1 = ts[ts.length - 1] || t0 + 1;
    const lo = Math.min(...vs, -(thr || 1000) * 1.3, -500);
    const hi = Math.max(...vs, 500);
    const pad = (hi - lo) * 0.08;
    const yMin = lo - pad,
      yMax = hi + pad;
    const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
    const xs = ts.map(x);
    const ys = vs.map(y);
    const line = xs.map((px, i) => `${i ? "L" : "M"}${px.toFixed(1)} ${ys[i].toFixed(1)}`).join(" ");
    const y0 = y(0);
    const area = `${line} L${xs[xs.length - 1].toFixed(1)} ${y0.toFixed(1)} L${xs[0].toFixed(1)} ${y0.toFixed(1)} Z`;
    const yt = niceTicks(yMin, yMax, 5).filter((v) => v >= yMin && v <= yMax);
    const nx = Math.min(5, points.length);
    const xt = Array.from({ length: nx }, (_, i) => t0 + ((t1 - t0) * i) / Math.max(nx - 1, 1));
    return { ts, vs, xs, ys, line, area, y0, y, x, yt, xt, yMin, yMax };
  }, [points, thr]);

  if (!geo) {
    return (
      <div className="chart-empty">
        <p>Collecting readings. The line draws itself as the agent polls Nansen every few minutes.</p>
      </div>
    );
  }

  const last = points.length - 1;
  const hi = hover ?? last;
  const hp = { x: geo.xs[hi], y: geo.ys[hi], v: geo.vs[hi], t: geo.ts[hi] };
  const tipLeft = (hp.x / W) * 100;

  const onMove = (e: MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0,
      bd = Infinity;
    geo.xs.forEach((x, i) => {
      const d = Math.abs(x - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  };

  const thrY = thr > 0 ? geo.y(-thr) : null;

  return (
    <div className="chart" ref={ref} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Net smart-money flow for WMON over the last ${tfWords}, sampled every few minutes`}>
        <defs>
          <linearGradient id="gNeg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--neg)" stopOpacity="0.06" />
            <stop offset="1" stopColor="var(--neg)" stopOpacity="0.26" />
          </linearGradient>
          <linearGradient id="gPos" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="var(--pos)" stopOpacity="0.06" />
            <stop offset="1" stopColor="var(--pos)" stopOpacity="0.24" />
          </linearGradient>
          <clipPath id="cAbove">
            <rect x="0" y="0" width={W} height={geo.y0} />
          </clipPath>
          <clipPath id="cBelow">
            <rect x="0" y={geo.y0} width={W} height={H - geo.y0} />
          </clipPath>
        </defs>

        {geo.yt.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={geo.y(v)} y2={geo.y(v)} className={v === 0 ? "grid zero" : "grid"} />
            <text x={L - 10} y={geo.y(v) + 4} className="tick" textAnchor="end">
              {v === 0 ? "$0" : compact(v)}
            </text>
          </g>
        ))}
        {geo.xt.map((t, i) => (
          <text key={i} x={geo.x(t)} y={H - 8} className="tick" textAnchor={i === 0 ? "start" : i === geo.xt.length - 1 ? "end" : "middle"}>
            {new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </text>
        ))}

        <path d={geo.area} fill="url(#gPos)" clipPath="url(#cAbove)" />
        <path d={geo.area} fill="url(#gNeg)" clipPath="url(#cBelow)" />

        {thrY !== null && (
          <g>
            <line x1={L} x2={W - R} y1={thrY} y2={thrY} className="thr-line" />
            <rect x={W - R - 148} y={thrY - 23} width="148" height="20" rx="10" className="thr-pill" />
            <text x={W - R - 74} y={thrY - 9} textAnchor="middle" className="thr-text">
              Your line {"\u2212"}{usd(thr)}
            </text>
          </g>
        )}

        <path d={geo.line} className="flow-line" />

        <line x1={hp.x} x2={hp.x} y1={T} y2={H - B} className="cross" opacity={hover === null ? 0 : 1} />
        <circle cx={hp.x} cy={hp.y} r="9" className="dot-halo" />
        <circle cx={hp.x} cy={hp.y} r="4.5" className="dot" />
      </svg>

      <div className="tip" style={{ left: `${Math.min(Math.max(tipLeft, 12), 88)}%` }}>
        <b className={hp.v < 0 ? "n-neg" : "n-pos"}>{usdSigned(hp.v)}</b>
        <span>{new Date(hp.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ watchlist */

function Watchlist({ tokens, minWallets }: { tokens: Tok[]; minWallets: number }) {
  const max = Math.max(1000, ...tokens.map((t) => Math.abs(t.netFlowUsd ?? 0)));
  return (
    <section className="panel watch" aria-labelledby="w-title">
      <div className="panel-head">
        <h2 id="w-title">Also watching</h2>
        <span className="muted">No position, never triggers</span>
      </div>
      <ul>
        {tokens.map((t) => {
          const n = t.netFlowUsd ?? 0;
          const w = t.walletCountSum ?? 0;
          return (
            <li key={t.symbol}>
              <div className="w-name">
                <b>{t.symbol}</b>
                <small>
                  {w} {w === 1 ? "wallet" : "wallets"}
                </small>
              </div>
              <DivBar value={n} scale={max} />
              <div className="w-val">
                <span className={n < 0 ? "n-neg" : n > 0 ? "n-pos" : ""}>{usdSigned(n)}</span>
                <small className={t.usable ? "ok" : "warnt"}>{t.usable ? "Counted" : `Needs ${minWallets}, has ${w}`}</small>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ app */

export default function App() {
  const { isConnected, address } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const now = useNow();

  const latest = usePoll<Latest>("/api/latest", 10000);
  const protections = usePoll<Prot[]>("/api/protections", 10000) ?? [];
  const hist = usePoll<{ series: Record<string, Pt[]> }>("/api/history", 30000);

  const vault = latest?.tokens.find((t) => t.canTrigger === true);
  const watch = (latest?.tokens ?? []).filter((t) => t.canTrigger !== true);

  const [state, setState] = useState<VaultState | null>(null);
  const [chainErr, setChainErr] = useState<string | null>(null);
  useEffect(() => {
    if (!vault) return;
    let alive = true;
    readVault(vault.token)
      .then((s) => {
        if (alive) {
          setState(s);
          setChainErr(null);
        }
      })
      .catch((e) => alive && setChainErr(e?.shortMessage ?? e?.message ?? "chain read failed"));
    return () => {
      alive = false;
    };
  }, [vault?.token, latest?.generatedAt]);

  // History: server series if available, else build it from this session's polls.
  const session = useRef<Pt[]>([]);
  useEffect(() => {
    if (!vault || !latest) return;
    const last = session.current[session.current.length - 1];
    if (!last || last.t !== latest.generatedAt) {
      session.current = [...session.current, { t: latest.generatedAt, netFlowUsd: vault.netFlowUsd ?? 0 }].slice(-200);
    }
  }, [latest?.generatedAt]);
  const series = (vault && hist?.series?.[vault.symbol]) || session.current;

  const ageMs = latest ? now - new Date(latest.generatedAt).getTime() : 0;
  const stale = !!latest && ageMs > 20 * 60000;
  const tfWords = TF_WORDS[latest?.timeframe ?? ""] ?? latest?.timeframe ?? "";

  const coolMin = state && state.policy.lastTrigger > 0
    ? Math.max(0, Math.ceil(((state.policy.lastTrigger + state.policy.cooldownSecs) * 1000 - now) / 60000))
    : 0;

  const maxMove = state ? (+formatUnits((state.deposit * BigInt(state.policy.maxBps)) / 10000n, 18)).toLocaleString("en-US", { maximumFractionDigits: 4 }) : null;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <Mark />
          <div>
            <h1>Nanpolis</h1>
            <p>Smart-money exit protection for your WMON</p>
          </div>
        </div>
        <div className="top-right">
          <span className="pill">
            <i className="dot-on" />
            {monad.name} mainnet
          </span>
          <span className={`pill ${stale ? "warn" : ""}`} title="The agent skips readings older than 20 minutes">
            <i className={stale ? "dot-warn" : "dot-live"} />
            {latest ? (stale ? `Nansen read ${ago(ageMs)} (stale)` : `Nansen read ${ago(ageMs)}`) : "Waiting for agent"}
          </span>
          {isConnected ? (
            <button className="btn" onClick={() => disconnect()}>
              {address?.slice(0, 6)}&hellip;{address?.slice(-4)}
            </button>
          ) : (
            <button className="btn ghost" onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {chainErr && <p className="banner">Could not read the contract: {chainErr}</p>}

      <main>
        <div className="row hero-row">
          <Tripwire vault={vault} state={state} latest={latest} maxMove={maxMove} coolMin={coolMin} />
          <VaultPanel vault={vault} state={state} protections={protections} now={now} />
        </div>

        <ProtectionLog protections={protections} decimals={18} />

        <div className="row lower-row">
          <section className="panel chart-panel" aria-labelledby="c-title">
            <div className="panel-head">
              <h2 id="c-title">Smart-money net flow in WMON</h2>
              <div className="legend">
                <span>
                  <i className="lg neg" />
                  Selling
                </span>
                <span>
                  <i className="lg pos" />
                  Buying
                </span>
                <span>
                  <i className="lg line" />
                  Your line
                </span>
              </div>
            </div>
            <p className="muted sub">
              Each point is one Nansen reading covering the previous {tfWords}. Below zero means smart wallets are net
              sellers.
            </p>
            <HistoryChart points={series} thr={state?.policy.thresholdUsd ?? 0} tfWords={tfWords} />
          </section>

          <Watchlist tokens={watch} minWallets={latest?.minWalletCount ?? 2} />
        </div>
      </main>

      <footer>
        <p>
          Signal: Nansen token flow intelligence, summing {latest?.signalFields.map((s) => SEG_NAMES[s] ?? s).join(", ") ?? "smart traders, top PnL wallets and whales"}.
          Nansen caches responses for 10 to 30 minutes, so this is a minutes-level signal. The contract cannot verify
          Nansen&rsquo;s number, so it limits what the agent can do instead: a capped share, a pause between triggers, and
          one fixed destination.
        </p>
      </footer>
    </div>
  );
}
