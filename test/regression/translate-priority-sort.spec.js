// Regression: v1.7.1 翻譯優先級排序 + batch 0 序列化
//
// Fixture: test/regression/fixtures/translate-priority-sort.html
// 結構特徵:同頁面有 main 內段落、main 外長段落、header 短段落、sidebar 純連結段落
//
// v1.7.0 以前的行為:collectParagraphs 走 TreeWalker DOM 順序,加上 4 條補抓
// 都 append 到 array 尾端;header / nav / sidebar 等 DOM 前段元素會優先進入
// batch 0,使用者翻譯啟動後最先看到的譯文是「導覽列變中文」而不是文章開頭。
// 同時 worker pool 並行 dispatch,batch 完成順序純粹 race,中段先翻完的情形
// 視覺上像「翻譯亂跳」。
//
// v1.7.1 修法:
//   1. SK.prioritizeUnits — collectParagraphs 後做 stable sort,把 main/article
//      後代(tier 0)、長段落(tier 1)推到前面,連結密集 / 短段落留在後面(tier 2)
//   2. translateUnits / translateUnitsGoogle — 序列跑 batch 0,完成後才用
//      worker pool 並行 batch 1+,確保使用者最快看到的譯文是文章開頭
//
// 兩個改動互補:排序解決「優先翻什麼」,序列 batch 0 解決「優先看到什麼」。
//
// Test 1 鎖排序行為(stable sort + tier 順序);
// Test 2 鎖 batch 0 序列、batch 1+ 並行的時序行為。
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   Test 1:把 prioritizeUnits 改成 return units(不排序)→ tier 0 元素未排到最前
//          → fail。還原後 pass。
//   Test 2:把 `await runBatch(jobs[0])` 後接的 if 拿掉,改成原本的
//          `await runWithConcurrency(jobs, ...)` → batch 1 / batch 2 在 batch 0
//          await 之前就被送出,t1 < 50ms → fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'translate-priority-sort';

test('translate-priority-sort: tier 0 (main 內) 必須排在 tier 1 / tier 2 之前', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 拿 collectParagraphs + prioritizeUnits 後的 array,讀回每個 unit 的 id
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const before = SK.collectParagraphs();
      const after = SK.prioritizeUnits(before);
      const idOf = (u) => (u.kind === 'fragment' ? u.el?.id : u.el?.id) || null;
      return JSON.stringify({
        before: before.map(idOf),
        after: after.map(idOf),
      });
    })()
  `);
  const { before, after } = JSON.parse(result);

  // 期望:tier 0 的 article-* 三個 id 應該在 array 最前面(同 tier 內維持 DOM 順序)
  const tier0Ids = ['article-title', 'article-first', 'article-second'];
  expect(
    after.slice(0, 3),
    `prioritizeUnits 後前 3 個應是 main 內 tier 0 段落(實際 before=${JSON.stringify(before)} / after=${JSON.stringify(after)})`,
  ).toEqual(tier0Ids);

  // outside-main-long(tier 1)應該在 tier 0 之後、tier 2 之前
  const outsideIdx = after.indexOf('outside-main-long');
  const taglineIdx = after.indexOf('header-tagline');
  expect(outsideIdx, 'outside-main-long 應出現在 array 中').toBeGreaterThanOrEqual(0);
  expect(taglineIdx, 'header-tagline 應出現在 array 中').toBeGreaterThanOrEqual(0);
  expect(
    outsideIdx,
    `outside-main-long(tier 1)應排在 header-tagline(tier 2)之前`,
  ).toBeLessThan(taglineIdx);

  // sidebar-link-dense(連結密度 100% → tier 2)應在 outside-main-long 之後
  const sidebarIdx = after.indexOf('sidebar-link-dense');
  if (sidebarIdx >= 0) {
    expect(
      sidebarIdx,
      'sidebar-link-dense(tier 2,連結密度高)應排在 outside-main-long(tier 1)之後',
    ).toBeGreaterThan(outsideIdx);
  }

  await page.close();
});

test('translate-priority-sort: streaming 失敗 fallback 後,batch 0 序列 + batch 1+ 並行的 v1.7.1 行為仍成立', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#content-main', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // Mock storage.sync.get → 回傳固定 batch 設定(maxUnitsPerBatch=10、並行 10)
  // 配合 30 個假 unit 切成 3 批
  // v1.8.0: TRANSLATE_BATCH_STREAM mock 回 { started: false } → 觸發 first_chunk failed
  //         → content.js 走 streaming fallback 路徑(等同 v1.7.1 序列 batch 0 + 並行)
  // Mock chrome.runtime.sendMessage:TRANSLATE_BATCH 延遲 100ms 記錄時間,
  //                                   TRANSLATE_BATCH_STREAM 立即回失敗(讓 streaming 不啟動)
  await evaluate(`
    window.__callTimes = [];
    window.__startTime = 0;
    chrome.storage.sync.get = async function(keys) {
      return {
        maxConcurrentBatches: 10,
        maxUnitsPerBatch: 10,
        maxCharsPerBatch: 100000,
      };
    };
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_BATCH_STREAM') {
        // v1.8.0: streaming 失敗 → fallback 走 v1.7.1 路徑
        return { ok: false, error: 'streaming disabled in test' };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        return { ok: true, aborted: false };
      }
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        window.__callTimes.push(performance.now() - window.__startTime);
        await new Promise(r => setTimeout(r, 100));
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: {
            inputTokens: 1, outputTokens: 1, cachedTokens: 0,
            costUSD: 0,
            billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0,
          },
        };
      }
      return { ok: true };
    };
  `);

  // 動態生成 45 個假 P element,構造 element-kind unit array
  // v1.8.0: BATCH0_UNITS=25 + maxUnitsPerBatch=10 → 切 3 批(batch 0=25 / batch 1=10 / batch 2=10),
  // 跟 v1.7.x 在 30 unit 時切 3 批的測試 invariant 維持「3 個 batch、batch 1+ 並行」一致。
  // 用 IIFE return null 避免 evaluate 的 awaitPromise: true 卡住等 translateUnits 跑完。
  await evaluate(`
    (() => {
      const root = document.createElement('div');
      root.id = '__fake-root';
      for (let i = 0; i < 45; i++) {
        const p = document.createElement('p');
        p.textContent = 'fake unit ' + i + ' here we have some text to translate';
        root.appendChild(p);
      }
      document.body.appendChild(root);
      window.__fakeUnits = Array.from(root.children).map(el => ({ kind: 'element', el }));
      window.__startTime = performance.now();
      // 不 await,讓 batch 在 background 跑,Node 端用 waitForTimeout 觀察進度
      window.__translatePromise = window.__SK.translateUnits(window.__fakeUnits).catch(e => null);
      return null;
    })()
  `);

  // 等 50ms:此時 batch 0 還在 100ms 延遲中,batch 1+ 不該被送出
  await page.waitForTimeout(50);
  const at50 = await evaluate(`window.__callTimes.length`);
  expect(
    at50,
    `batch 0 await 期間(50ms),sendMessage 呼叫數應 = 1(實際 ${at50})`,
  ).toBe(1);

  // 等到 batch 全部跑完(batch 0 100ms + batch 1/2 並行 100ms ≈ 200ms,留餘裕)
  await page.waitForTimeout(400);

  const result = await evaluate(`({
    callTimes: window.__callTimes,
    total: window.__callTimes.length,
  })`);

  // v1.8.0: 45 unit / BATCH0_UNITS=25 + maxUnitsPerBatch=10 → batch 0=25 / batch 1=10 / batch 2=10 = 3 批
  expect(result.total, '應送出 3 筆 TRANSLATE_BATCH(45 unit / batch 0=25 + batch 1+2=10 各)').toBe(3);

  const [t0, t1, t2] = result.callTimes;

  // batch 0 應立即送(< 30ms)
  expect(t0, `batch 0 應立即送(實際 ${t0.toFixed(1)}ms)`).toBeLessThan(30);

  // batch 1 應在 batch 0 resolve(~100ms)後才送 → > 80ms
  // 若退回原本的「全部丟 worker pool」,batch 1 / 2 會在開頭就被 worker 拿走 → t1 < 30ms,fail
  expect(
    t1,
    `batch 1 應在 batch 0 resolve 後才送(預期 > 80ms,實際 ${t1.toFixed(1)}ms)`,
  ).toBeGreaterThan(80);

  // batch 1 / batch 2 應並行送(差 < 50ms)
  const gap12 = t2 - t1;
  expect(
    gap12,
    `batch 1 / batch 2 應並行送出(差 < 50ms,實際 ${gap12.toFixed(1)}ms)`,
  ).toBeLessThan(50);

  await page.close();
});
