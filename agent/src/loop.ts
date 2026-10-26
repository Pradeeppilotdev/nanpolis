import fs from "node:fs";
import { decide, validateFixture } from "./signal.ts";
import { TIMEFRAME_SECONDS, parseFlowIntelligence } from "./nansen.ts";
import path from "node:path";
import { parseEventLogs, type Address } from "viem";
import {
  EXITGUARD_ABI,
  publicClient,
  agentWallet,
  getPolicy,
  simulateProtect,
  evidenceHashFor,
  sendProtect,
} from "./guard.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "agent", "config.json"), "utf8"));
const DEP = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments.json"), "utf8"));

const MODE = (process.env.MODE ?? "DRY_RUN").toUpperCase(); // LIVE | DRY_RUN | REPLAY
if (!["LIVE", "DRY_RUN", "REPLAY"].includes(MODE)) throw new Error(`Invalid MODE: ${MODE}`);
const ONE_SHOT = process.env.ONE_SHOT === "1";
const INTERVAL = Number(process.env.POLL_INTERVAL_SECONDS ?? 300);
const MAX_FIXTURE_AGE_MS = Number(process.env.MAX_FIXTURE_AGE_MINUTES ?? 20) * 60_000;
if (!Number.isFinite(INTERVAL) || INTERVAL < 1 || !Number.isFinite(MAX_FIXTURE_AGE_MS) || MAX_FIXTURE_AGE_MS <= 0) throw new Error("Invalid polling interval or fixture age");
const SIGNAL_FIELDS: string[] = CFG.signalFields;
const MIN_WALLETS: number = CFG.decision.minWalletCount;

const EXITGUARD = DEP.exitGuard as Address;
const OWNER = DEP.wallets.deployer as Address;
const AGENT = DEP.wallets.agent as Address;

function ensureDirLocal(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function log(line: string) {
  const tag = MODE === "REPLAY" ? "[REPLAY] " : "";
  const s = `${new Date().toISOString()} ${tag}${line}`;
  console.log(s);
  fs.appendFileSync(path.join(ROOT, "logs", "decision.log"), s + "\n");
}

function logFile(line: string) {
  const tag = MODE === "REPLAY" ? "[REPLAY] " : "";
  fs.appendFileSync(path.join(ROOT, "logs", "decision.log"), `${new Date().toISOString()} ${tag}${line}\n`);
}

async function runOnce() {
  const client = publicClient();
  const block = await client.getBlock();
  if (await client.getChainId() !== DEP.chainId) throw new Error("RPC chain does not match deployment");

  for (const t of CFG.tokens) {
    const vaultOnly = t.canTrigger === true;

    const label = `${t.symbol} [signal=${t.signalChain} exec=${t.executionChain}]`;

    if (!vaultOnly) {
      log(
        `${label} OBSERVATIONAL ONLY - flow data recorded, never drives a trigger on the WMON position (role=${t.role})`,
      );
      continue;
    }

    // Pick the newest recorded raw response for this token.
    const dir = path.join(ROOT, "fixtures");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(`_${t.symbol}.json`) && !f.endsWith(".meta.json"))
      .filter((f) => fs.existsSync(path.join(dir, f.replace(/\.json$/, ".meta.json"))))
      .sort();
    if (!files.length) {
      log(`${label} no recorded response yet - skipping`);
      continue;
    }
    const rawFile = path.join("fixtures", files[files.length - 1]);
    const rawAbs = path.join(ROOT, rawFile);

    // Window binding: the timeframe must come from the exact fixture being used,
    // recorded in its .meta.json sidecar - never from the policy.
    const metaFile = rawAbs.replace(/\.json$/, ".meta.json");
    if (!fs.existsSync(metaFile)) {
      log(`${label} SKIP: no .meta.json sidecar for ${rawFile} - cannot bind timeframe, never guessed`);
      continue;
    }
    let meta: any;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    } catch {
      log(`${label} SKIP: unreadable .meta.json sidecar (${path.basename(metaFile)})`);
      continue;
    }
    const invalid = validateFixture(meta, t, TIMEFRAME_SECONDS, Date.now(), MAX_FIXTURE_AGE_MS);
    if (invalid) { log(`${label} SKIP: ${invalid}`); continue; }
    const fixtureTimeframe: string = meta.timeframe;
    const fixtureWindowSecs: number = meta.timeframeSeconds;
    if (typeof fixtureWindowSecs !== "number") {
      log(`${label} SKIP: sidecar has no timeframeSeconds (${path.basename(metaFile)})`);
      continue;
    }

    // Staleness guard: never act on an old reading. Applies in EVERY mode,
    // including DRY_RUN and REPLAY-with-live-files, and is required for LIVE.
    const ageMs = Date.now() - Date.parse(meta.recordedAt);
    const ageMin = ageMs / 60_000;
    if (ageMs > MAX_FIXTURE_AGE_MS) {
      log(
        `${label} SKIP: STALE FIXTURE age=${ageMin.toFixed(1)}min > max=${(MAX_FIXTURE_AGE_MS / 60_000).toFixed(0)}min (${rawFile})`,
      );
      continue;
    }

    const raw = fs.readFileSync(rawAbs, "utf8");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log(`${label} unparseable raw response - skipped, never faked`);
      continue;
    }
    // REST shape is { data: [row] }; older CLI fixtures are { data: { data: [row] } }.
    const row = parseFlowIntelligence(raw);
    if (!row) {
      log(`${label} empty Nansen row - skipped, never faked`);
      continue;
    }

    const bucket = files[files.length - 1].slice(0, 8);
    const d = { ...decide(row, SIGNAL_FIELDS, MIN_WALLETS), bucketDateUtc: bucket };

    const segStr = SIGNAL_FIELDS.map(
      (f) => `${f}=${d.segments[f].netFlowUsd.toFixed(2)}/${d.segments[f].walletCount}w`,
    ).join(" ");
    log(
      `${label} bucket=${d.bucketDateUtc} age=${ageMin.toFixed(1)}min ${segStr} | netFlowSum=${d.netFlowUsd.toFixed(2)} distributionUsd=${d.distributionUsd} wallets=${d.walletCountSum}/${MIN_WALLETS} usable=${d.usable}`,
    );

    if (!d.usable) {
      log(`${label} SKIP: ${d.skipReason}`);
      continue;
    }

    const policy = await getPolicy(client, EXITGUARD, OWNER, t.token as Address);

    // Explicit window binding check before anything else can fire.
    if (fixtureWindowSecs !== policy.windowSecs) {
      log(
        `${label} SKIP: WindowMismatch fixture timeframe=${fixtureTimeframe} (${fixtureWindowSecs}s) != policy.windowSecs ${policy.windowSecs}s`,
      );
      continue;
    }
    const rpc = client as unknown as { readContract: (a: Record<string, unknown>) => Promise<unknown> };
    const balance = (await rpc.readContract({
      address: EXITGUARD,
      abi: EXITGUARD_ABI,
      functionName: "deposits",
      args: [OWNER, t.token as Address],
    })) as bigint;
    const now = Number(block.timestamp);

    log(
      `${label} POLICY guard=${policy.guard} safe=${policy.safeAddr} threshold=${policy.thresholdUsd} window=${policy.windowSecs}s maxBps=${policy.maxBps} cooldown=${policy.cooldownSecs}s lastTrigger=${policy.lastTrigger} | deposit=${balance}`,
    );

    const verdict = simulateProtect(policy, AGENT, t.token as Address, {
      distributionUsd: d.distributionUsd,
      windowSecs: fixtureWindowSecs,
      configuredBps: 2500,
      now,
      balance,
    });

    if (!verdict.ok) {
      log(`${label} NO TRIGGER: ${verdict.reason}`);
      continue;
    }

    const bps = verdict.bps!;
    const { hash: evidenceHash, file } = evidenceHashFor(rawFile);
    const amount = (balance * BigInt(bps)) / 10000n;

    log(
      `${label} TRIGGER ELIGIBLE bps=${bps} (min(config 2500, policy maxBps ${policy.maxBps})) distributionUsd=${d.distributionUsd} amountWouldMove=${amount} evidenceHash=${evidenceHash} evidenceFile=${file}`,
    );

    if (MODE === "LIVE") {
      const wallet = agentWallet();
      if (wallet.account?.address.toLowerCase() !== AGENT.toLowerCase()) throw new Error("Signing account does not match configured guard");
      // Persist the evidence file alongside the tx that consumed it, and record
      // the protection so the UI never has to scan chain history.
      const evidenceDir = path.join(ROOT, "fixtures", "_evidence");
      ensureDirLocal(evidenceDir);
      const evidenceCopy = path.join("fixtures", "_evidence", path.basename(rawFile));
      fs.copyFileSync(path.join(ROOT, rawFile), path.join(ROOT, evidenceCopy));
      const metaCopy = path.join("fixtures", "_evidence", path.basename(metaFile));
      fs.copyFileSync(metaFile, path.join(ROOT, metaCopy));

      const { txHash, blockNumber } = await sendProtect({
        wallet,
        client,
        exitGuard: EXITGUARD,
        owner: OWNER,
        token: t.token as Address,
        bps,
        distributionUsd: d.distributionUsd,
        windowSecs: fixtureWindowSecs,
        evidenceHash,
      });
      const receipt: any = await client.getTransactionReceipt({ hash: txHash });

      // Decode the Protected event from this tx's receipt (no block-range scan).
      const evs = parseEventLogs({
        abi: EXITGUARD_ABI,
        eventName: "Protected",
        logs: receipt.logs as any,
        strict: false,
      }) as any[];

      for (const ev of evs) {
        const a = ev.args as any;
        log(
          `${label} PROTECTED event amountMoved=${a.amountMoved} bps=${a.bps} distributionUsd=${a.distributionUsd} windowSecs=${a.windowSecs} evidenceHash=${a.evidenceHash}`,
        );
      }

      const protectionsFile = path.join(ROOT, "logs", "protections.json");
      let protections: any[] = [];
      if (fs.existsSync(protectionsFile)) {
        try {
          protections = JSON.parse(fs.readFileSync(protectionsFile, "utf8"));
        } catch {}
      }
      protections.push({
        txHash,
        blockNumber: blockNumber.toString(),
        symbol: t.symbol,
        token: t.token,
        owner: OWNER,
        guard: AGENT,
        safeAddr: policy.safeAddr,
        bps,
        amountMoved: evs[0]?.args?.amountMoved?.toString() ?? null,
        distributionUsd: d.distributionUsd,
        windowSecs: policy.windowSecs,
        signalChain: t.signalChain,
        executionChain: t.executionChain,
        evidenceHash,
        evidenceFile: evidenceCopy,
        evidenceMetaFile: metaCopy,
        timeframe: fixtureTimeframe,
        nansenRawFile: rawFile,
        explorer: `https://monadvision.com/tx/${txHash}`,
        at: new Date().toISOString(),
        mode: MODE,
      });
      fs.writeFileSync(protectionsFile + ".tmp", JSON.stringify(protections, null, 2));
      fs.renameSync(protectionsFile + ".tmp", protectionsFile);
      log(
        `${label} recorded -> logs/protections.json ; evidence copied -> ${evidenceCopy} + ${path.basename(metaCopy)}`,
      );
    } else {
      const modeNote =
        MODE === "REPLAY"
          ? "REPLAY: no transaction sent; this decision was computed from a recorded real Nansen response"
          : "DRY_RUN: no transaction sent";
      log(
        `${label} ${modeNote} | would call protect(owner=${OWNER}, token=${t.token}, bps=${bps}, distributionUsd=${d.distributionUsd}, windowSecs=${fixtureWindowSecs}, evidenceHash=${evidenceHash})`,
      );
    }
  }
  void block;
}

log(
  `decision loop start MODE=${MODE} interval=${INTERVAL}s exitGuard=${EXITGUARD} owner=${OWNER} agent=${AGENT} fields=${SIGNAL_FIELDS.join("+")} minWalletCount=${MIN_WALLETS}`,
);
await runOnce();
if (ONE_SHOT) {
  log("ONE_SHOT done");
  process.exit(0);
}
while (true) {
  await new Promise(resolve => setTimeout(resolve, INTERVAL * 1000));
  try { await runOnce(); } catch (e: any) { log(`loop error: ${e?.message ?? e}`); }
}
