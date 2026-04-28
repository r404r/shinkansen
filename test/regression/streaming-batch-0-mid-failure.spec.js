// Regression: v1.8.0 streaming mid-failure → batch 0 整批 non-streaming retry
//
// 鎖兩件事:
//   1. STREAMING_FIRST_CHUNK 已到 + 部分 STREAMING_SEGMENT 已 inject 後,
//      若 STREAMING_ERROR 發生,content.js 應 fallback 對 batch 0 重送整批 non-streaming(TRANSLATE_BATCH)
//   2. 已並行 dispatch 的 batch 1+ 不受影響(維持原 in-flight 不重送)
//
// Mock 策略:
//   - TRANSLATE_BATCH_STREAM:回 started:true,100ms fire FIRST_CHUNK + 立刻 emit 3 個 SEGMENT(idx 0/1/2),
//     200ms fire STREAMING_ERROR(尚有 22 段未 emit → 觸發 fallback)
//   - TRANSLATE_BATCH:記錄 texts.length + payload count
//   - 35 fake units → batch 0=25 + batch 1=10
//
// 預期:
//   - batchCount === 2(batch 0 retry 25 texts + batch 1 已並行 10 texts)
//   - 其中一筆 payload texts.length === 25(batch 0 整批 retry,不是只重翻未 emit 的 22)
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js 的 catch (streamErr) 區塊改成 no-op(不呼叫 runBatch(jobs[0]))→
//   batch 0 retry 不送,batchCount 變 1 + 25-text 斷言 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('streaming-batch-0-mid-failure: first_chunk + 部分 segment 後 STREAMING_ERROR → batch 0 整批 retry', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    window.__streamCount = 0;
    window.__batchPayloadSizes = [];
    window.__streamId = null;
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
        window.__streamId = msg.payload.streamId;
        // 100ms: fire FIRST_CHUNK + 3 個 SEGMENT(idx 0/1/2)
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          }
          for (let i = 0; i < 3; i++) {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_SEGMENT', payload: { streamId: window.__streamId, segmentIdx: i, translation: '[STREAM] seg ' + i } });
            }
          }
        }, 100);
        // 200ms: fire STREAMING_ERROR(尚有 22 段未 emit)
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_ERROR', payload: { streamId: window.__streamId, error: 'mid-stream API 5xx' } });
          }
        }, 200);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__batchPayloadSizes.push(texts.length);
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
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits, {
        signal: window.__SK.STATE.abortController.signal,
      }).then(() => { window.__doneResolved = true; }).catch(() => { window.__doneResolved = true; });
      return null;
    })()
  `);

  // 等 600ms:first_chunk(100ms)+ ERROR(200ms)+ batch 0 retry & batch 1 dispatch & resolve(50ms each)+ 餘裕
  await page.waitForTimeout(600);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    payloadSizes: window.__batchPayloadSizes,
    doneResolved: window.__doneResolved,
  })`);

  expect(result.streamCount, 'batch 0 應走 STREAM 1 次(retry 用 TRANSLATE_BATCH 不算 stream)').toBe(1);
  expect(
    result.payloadSizes.length,
    `應送 2 筆 TRANSLATE_BATCH(batch 0 retry 25 + batch 1 並行 10),實際 ${JSON.stringify(result.payloadSizes)}`,
  ).toBe(2);

  // 必須有一筆 25 texts(batch 0 整批 retry,而非只重翻未 emit 的 22)
  expect(
    result.payloadSizes.includes(25),
    `batch 0 應「整批」retry(25 texts),實際 payload sizes: ${JSON.stringify(result.payloadSizes)}`,
  ).toBe(true);
  // 還有一筆 10 texts(batch 1 並行)
  expect(
    result.payloadSizes.includes(10),
    `batch 1 應已並行 dispatch(10 texts),實際: ${JSON.stringify(result.payloadSizes)}`,
  ).toBe(true);
  expect(result.doneResolved, 'translateUnits Promise 應解開').toBe(true);

  await page.close();
});
