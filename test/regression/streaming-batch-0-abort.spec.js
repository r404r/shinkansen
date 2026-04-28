// Regression: v1.8.0 streaming abort 跨批傳播
//
// 鎖兩件事:
//   1. signal.abort() 在 streaming 進行中觸發 → STREAMING_ABORT 訊息送 SW
//   2. abort 後 runWithConcurrency 的 worker 在下次迴圈 check signal.aborted 退出,
//      不再 dispatch 後續 batch(已 in-flight 的 batch 不會被殺,但 queue 內的不會出發)
//
// Mock 策略:
//   - 收集 onMessage listener,讓 spec 端手動 fire STREAMING_FIRST_CHUNK(不 fire DONE,維持 streaming 中)
//   - TRANSLATE_BATCH 用 300ms 假延遲,讓 batch 1 in-flight 期間有空間觸發 abort
//   - maxConcurrentBatches=1,確保後續 batch 走 serial queue,abort 後不再 dispatch
//   - 60 fake units → batch 0=25 + batch 1=10 + batch 2=10 + batch 3=10 + batch 4=5
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 content.js runBatch0Streaming 的 abortHandler 整段改成 no-op
//   → STREAMING_ABORT count 變 0 + 主流程不會解開 await,abortCount 斷言 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('streaming-batch-0-abort: signal.abort() → STREAMING_ABORT 送出 + 後續 batch 不再 dispatch', async ({
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
    window.__batchCallTimes = [];
    window.__batchPayloadCount = 0;
    window.__startTime = 0;
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
      // maxConcurrentBatches=1 → 後續 batch 序列 dispatch,abort 才能觀察到「下一批不再 dispatch」
      return { maxConcurrentBatches: 1, maxUnitsPerBatch: 10, maxCharsPerBatch: 100000 };
    };

    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamId = msg.payload.streamId;
        // 100ms 後 fire STREAMING_FIRST_CHUNK,但故意不 fire DONE → streaming 持續中
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          }
        }, 100);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        window.__abortCount += 1;
        // SW 收到 abort 後通常會回 STREAMING_ABORTED 訊息,模擬此行為解開主流程 donePromise
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_ABORTED', payload: { streamId: window.__streamId } });
          }
        }, 5);
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__batchCallTimes.push(performance.now() - window.__startTime);
        window.__batchPayloadCount += 1;
        await new Promise(r => setTimeout(r, 300));
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUSD: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);

  // 60 units → batch 0=25 (streaming) + 35 in batches of 10 → 4 後續 batch
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 60; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      // 用 STATE.abortController 一致路徑(content.js 主流程慣例)
      window.__SK.STATE.abortController = new AbortController();
      window.__startTime = performance.now();
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits, {
        signal: window.__SK.STATE.abortController.signal,
      }).then(() => { window.__doneResolved = true; }).catch(() => { window.__doneResolved = true; });
      return null;
    })()
  `);

  // 等 200ms:first_chunk(100ms)已 fire → batch 1 已 dispatch + in-flight,batch 2 排隊
  await page.waitForTimeout(200);

  const beforeAbort = await evaluate(`({
    streamCount: window.__streamCount,
    batchCount: window.__batchPayloadCount,
    abortCount: window.__abortCount,
  })`);
  expect(beforeAbort.streamCount, 'batch 0 應走 STREAM').toBe(1);
  expect(beforeAbort.batchCount, 'first_chunk 後 batch 1 應 in-flight(maxConcurrent=1)').toBe(1);
  expect(beforeAbort.abortCount, 'abort 還沒觸發').toBe(0);

  // 觸發 abort(streaming + batch 1 都還在 in-flight)
  await evaluate(`window.__SK.STATE.abortController.abort()`);

  // 等 500ms:batch 1 的 300ms delay + 餘裕,讓 worker 下次迴圈 check signal.aborted 退出
  await page.waitForTimeout(500);

  const afterAbort = await evaluate(`({
    abortCount: window.__abortCount,
    batchCount: window.__batchPayloadCount,
    doneResolved: window.__doneResolved,
  })`);

  expect(afterAbort.abortCount, 'STREAMING_ABORT 應送 1 次').toBe(1);
  expect(
    afterAbort.batchCount,
    `abort 後 batch 2-4 不應再 dispatch(預期 1,實際 ${afterAbort.batchCount})`,
  ).toBe(1);
  expect(afterAbort.doneResolved, 'translateUnits Promise 應解開(主流程不卡)').toBe(true);

  await page.close();
});
