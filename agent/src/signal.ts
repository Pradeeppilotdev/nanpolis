/** One fail-closed signal calculation shared by recording, replay and execution. */
export function decide(row: Record<string, unknown>, fields: string[], minWallets: number) {
  const segments: Record<string, { netFlowUsd: number; walletCount: number }> = {};
  let netFlowUsd = 0;
  let walletCountSum = 0;
  let valid = true;
  for (const field of fields) {
    const nf = row[`${field}_net_flow_usd`];
    const wc = row[`${field}_wallet_count`];
    const fieldValid = typeof nf === 'number' && Number.isFinite(nf) &&
      typeof wc === 'number' && Number.isSafeInteger(wc) && wc >= 0;
    valid &&= fieldValid;
    segments[field] = { netFlowUsd: fieldValid ? nf as number : 0, walletCount: fieldValid ? wc as number : 0 };
    netFlowUsd += segments[field].netFlowUsd;
    walletCountSum += segments[field].walletCount;
  }
  const distributionUsd = Math.floor(Math.max(0, -netFlowUsd));
  valid &&= Number.isSafeInteger(distributionUsd) && Number.isSafeInteger(walletCountSum);
  return { signalFields: fields, segments, netFlowUsd, distributionUsd, walletCountSum,
    minWalletCount: minWallets, usable: valid && walletCountSum >= minWallets,
    skipReason: !valid ? 'Missing or invalid signal fields' : walletCountSum < minWallets ? `walletCountSum ${walletCountSum} < minWalletCount ${minWallets}` : null };
}

export function validateFixture(meta: any, token: {token: string; signalChain: string}, windows: Record<string, number>, now: number, maxAge: number): string | null {
  if (meta?.ok !== true) return 'recording was unsuccessful';
  if (typeof meta.token !== 'string' || meta.token.toLowerCase() !== token.token.toLowerCase() || meta.chain !== token.signalChain) return 'fixture token or chain mismatch';
  if (!windows[meta.timeframe] || windows[meta.timeframe] !== meta.timeframeSeconds) return 'invalid timeframe binding';
  const recorded = Date.parse(meta.recordedAt);
  if (!Number.isFinite(recorded) || recorded > now + 60_000 || now - recorded > maxAge) return 'stale or invalid recording timestamp';
  return null;
}
