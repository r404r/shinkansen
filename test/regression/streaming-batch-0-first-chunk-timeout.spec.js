// Regression: v1.8.0 streaming first_chunk 1.5s timeout → fallback 走 non-streaming
//
// 鎖兩件事:
//   1. TRANSLATE_BATCH_STREAM 回 started:true 但 SW 從沒推 STREAMING_FIRST_CHUNK,
//      content.js 應在 1.5 秒後送 STREAMING_ABORT(中斷 SW 端 streaming)
//   2. timeout 後 fallback 走 v1.7.x 路徑:序列 batch 0(TRANSLATE_BATCH 25 texts)
//      + 並行 batch 1+(TRANSLATE_BATCH 10 texts)
//
// Mock 策略:
//   - TRANSLATE_BATCH_STREAM:回 started:true,完全不推任何 STREAMING_* 訊息(模擬 SW 卡死或遺漏 first_chunk)
//   - TRANSLATE_BATCH:記錄 texts.length + 呼叫時間
//   - 35 fake units → batch 0=25 + batch 1=10
//
// 預期(timeline):
//   - 0ms: TRANSLATE_BATCH_STREAM 送出
//   - 1500ms: first_chunk timeout → STREAMING_ABORT 送出 + fallback 進入序列路徑
//   - ~1500ms: TRANSLATE_BATCH(25 texts, batch 0)送出
//   - ~1550ms: batch 0 resolve → TRANSLATE_BATCH(10 texts, batch 1)送出
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js 的 firstChunkOrTimeout race 內 setTimeout 從 FIRST_CHUNK_TIMEOUT_MS 改成
//   1_000_000(永不 timeout)→ 主流程卡在 firstChunkOrTimeout,batch 0 fallback 不發 →
//   payloadSizes.length === 0 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('streaming-batch-0-first-chunk-timeout: 1.5s 沒 first_chunk → STREAMING_ABORT + fallback 走 non-streaming', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__streamCount = 0;
    window.__abortCount = 0;
    window.__batchPayloadSizes = [];
    window.__batchCallTimes = [];
    window.__startTime = 0;
    window.__doneResolved = false;

    window.__listeners = [];
    const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
    const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
    browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
    browser.runtime.onMessage.removeListener = (fn) => {
      const i = window.__listeners.indexOf(fn);
      if (i >= 0) window.__listeners.splice(i, 1);
      return origRemove(fn);
    };

    chrome.storage.sync.get = async function(keys) {
      return { maxConcurrentBatches: 5, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamCount += 1;
        // 故意完全不 fire 任何 STREAMING_* 訊息 → 觸發 1.5s timeout 路徑
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        window.__abortCount += 1;
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__batchPayloadSizes.push(texts.length);
        window.__batchCallTimes.push(performance.now() - window.__startTime);
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 35 units → batch 0=25 + batch 1=10
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 35; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      window.__SK.STATE.abortController = new AbortController();
      window.__startTime = performance.now();
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits, {
        signal: window.__SK.STATE.abortController.signal,
      }).then(() => { window.__doneResolved = true; }).catch(() => { window.__doneResolved = true; });
      return null;
    })()
  `);

  // 1s 內:streaming 還在等 first_chunk,batch 0 fallback 還沒進場
  await page.waitForTimeout(1000);
  const before = await evaluate(`({
    streamCount: window.__streamCount,
    batchCount: window.__batchPayloadSizes.length,
    abortCount: window.__abortCount,
  })`);
  expect(before.streamCount, 'batch 0 走 STREAM 1 次').toBe(1);
  expect(before.batchCount, 'timeout 前(1s),batch 0 fallback 還不該送').toBe(0);
  expect(before.abortCount, 'timeout 前 STREAMING_ABORT 還不該送').toBe(0);

  // 等到 1.8s:跨過 1.5s timeout + batch 0/1 dispatch + resolve(50ms each)+ 餘裕
  await page.waitForTimeout(1000);

  const after = await evaluate(`({
    abortCount: window.__abortCount,
    payloadSizes: window.__batchPayloadSizes,
    callTimes: window.__batchCallTimes,
    doneResolved: window.__doneResolved,
  })`);

  expect(after.abortCount, '1.5s timeout 後應送 STREAMING_ABORT').toBe(1);
  expect(
    after.payloadSizes.length,
    `fallback 應送 batch 0(25)+ batch 1(10)共 2 筆,實際 ${JSON.stringify(after.payloadSizes)}`,
  ).toBe(2);
  expect(after.payloadSizes.includes(25), 'fallback batch 0 25 texts').toBe(true);
  expect(after.payloadSizes.includes(10), 'fallback batch 1 10 texts').toBe(true);

  // batch 0 fallback 應在 timeout 後送(> 1500ms,< 1700ms)
  const batch0Time = after.callTimes[after.payloadSizes.indexOf(25)];
  expect(
    batch0Time,
    `batch 0 fallback 應在 1.5s timeout 後送(預期 > 1450ms,實際 ${batch0Time?.toFixed?.(1)}ms)`,
  ).toBeGreaterThan(1450);

  expect(after.doneResolved, 'translateUnits Promise 應解開').toBe(true);

  await page.close();
});
