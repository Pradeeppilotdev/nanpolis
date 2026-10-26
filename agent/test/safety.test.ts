import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, validateFixture } from '../src/signal.ts';
import { simulateProtect, sendProtect } from '../src/guard.ts';
import { parseFlowIntelligence } from '../src/nansen.ts';
import { sampleSnapshot } from '../src/replay.ts';
const fields = ['smart_trader', 'top_pnl', 'whale'];
const row = Object.fromEntries(fields.flatMap(f => [[`${f}_net_flow_usd`, -100.5], [`${f}_wallet_count`, 1]]));
test('signal excludes unrelated fields and floors distribution', () => {
  assert.equal(decide({...row, exchange_net_flow_usd: -999999}, fields, 2).distributionUsd, 301);
  assert.equal(decide(row, fields, 2).usable, true);
});
test('malformed and incomplete data fails closed', () => {
  for (const bad of [NaN, Infinity, '100', undefined]) assert.equal(decide({...row, whale_net_flow_usd: bad}, fields, 2).usable, false);
  assert.equal(decide({...row, whale_wallet_count: -1}, fields, 2).usable, false);
  assert.equal(parseFlowIntelligence('{"success":false,"data":{"data":[{}]}}'), null);
});
test('fixture binds successful response, identity, window and actual recording time', () => {
  const token = { token: '0xABC', signalChain: 'monad' };
  const meta = {ok:true, token:'0xabc', chain:'monad', timeframe:'6h', timeframeSeconds:21600, recordedAt:'2026-10-26T12:00:00Z'};
  const now = Date.parse(meta.recordedAt);
  assert.equal(validateFixture(meta, token, {'6h':21600}, now, 1200000), null);
  for (const change of [{ok:false},{token:'0xdef'},{chain:'ethereum'},{timeframeSeconds:3600},{recordedAt:'invalid'},{recordedAt:'2020-01-01'}]) assert.ok(validateFixture({...meta,...change},token,{'6h':21600},now,1200000));
});
const address = '0x1111111111111111111111111111111111111111' as const;
const policy = {guard:address,safeAddr:address,thresholdUsd:100n,windowSecs:21600,maxBps:2500,cooldownSecs:3600,lastTrigger:0n};
const opts = {distributionUsd:200,windowSecs:21600,configuredBps:5000,now:10000,balance:100n};
test('policy caps movement and rejects invalid, cooldown and dust', () => {
  assert.deepEqual(simulateProtect(policy,address,address,opts),{ok:true,bps:2500});
  for (const change of [{distributionUsd:NaN},{distributionUsd:99},{configuredBps:1.5},{balance:1n},{windowSecs:3600}]) assert.equal(simulateProtect(policy,address,address,{...opts,...change}).ok,false);
  assert.equal(simulateProtect({...policy,lastTrigger:9000n},address,address,opts).ok,false);
});
test('reverted receipt never reports protection success', async () => {
  await assert.rejects(sendProtect({wallet:{account:{address},writeContract:async()=> '0x123'} as any,client:{simulateContract:async()=>({}),waitForTransactionReceipt:async()=>({status:'reverted',blockNumber:1n})} as any,exitGuard:address,owner:address,token:address,bps:100,distributionUsd:100,windowSecs:21600,evidenceHash:`0x${'0'.repeat(64)}`} ),/reverted/);
});
test('offline replay preserves historical timestamps and cannot trigger',()=> {
  const snapshot=sampleSnapshot();
  assert.equal(snapshot.demo,true);
  assert.equal(snapshot.timeframeSeconds,null);
  assert.ok(snapshot.tokens.every((t:any)=> !t.canTrigger));
  assert.ok(snapshot.generatedAt.startsWith('2026-10-12'));
});
