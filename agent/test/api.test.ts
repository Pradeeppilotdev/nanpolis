import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiResponse, history } from '../src/api.ts';

test('API missing data, malformed files, methods and demo isolation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanpolis-api-'));
  try {
    fs.mkdirSync(path.join(root,'logs'));
    assert.equal(apiResponse('/api/latest','GET',root,false).status,503);
    assert.deepEqual(apiResponse('/api/protections','GET',root,false).body,[]);
    fs.writeFileSync(path.join(root,'logs/latest.json'),'{bad');
    fs.writeFileSync(path.join(root,'logs/protections.json'),'{}');
    assert.equal(apiResponse('/api/latest','GET',root,false).status,503);
    assert.equal(apiResponse('/api/protections','GET',root,false).status,503);
    assert.equal(apiResponse('/api/latest','POST',root,false).status,405);
    assert.equal(apiResponse('/api/latest-unexpected','GET',root,false).status,404);
    const replay = apiResponse('/api/latest?cache=1','GET',root,true);
    assert.equal(replay.status,200);
    assert.equal((replay.body as any).demo,true);
    assert.deepEqual(apiResponse('/api/protections','GET',root,true).body,[]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('history skips malformed metadata and invalid signal rows without crashing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanpolis-history-'));
  try {
    fs.mkdirSync(path.join(root,'agent')); fs.mkdirSync(path.join(root,'fixtures'));
    fs.writeFileSync(path.join(root,'agent/config.json'),JSON.stringify({signalFields:['whale'],tokens:[{symbol:'WMON',token:'0xabc',signalChain:'monad'}]}));
    const meta = {ok:true,symbol:'WMON',token:'0xabc',chain:'monad',timeframe:'6h',timeframeSeconds:21600,recordedAt:'2020-01-01T00:00:00Z'};
    const cases = [meta,{...meta,recordedAt:null},{...meta,symbol:null},{...meta,token:'0xdef'},{...meta,ok:false},{...meta,recordedAt:'bad'},meta];
    cases.forEach((m,i)=> {
      fs.writeFileSync(path.join(root,`fixtures/${i}.meta.json`),JSON.stringify(m));
      fs.writeFileSync(path.join(root,`fixtures/${i}.json`),JSON.stringify({data:[{whale_net_flow_usd:i===6?'bad':-12,whale_wallet_count:2}]}));
    });
    assert.deepEqual(history(root).series.WMON,[{t:'2020-01-01T00:00:00.000Z',netFlowUsd:-12,walletCountSum:2}]);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
