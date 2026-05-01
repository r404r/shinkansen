// Regression: SPA observer rescan 純 cache hit 場景應 silent 不顯示「已翻 N 段新內容」
//
// Bug:framework re-render 同一段譯後內容(典型 YouTube hover description)觸發 SPA
// rescan,走 cache 路徑 reapply 譯文(API 0 cost)。但仍跳出「已翻譯 N 段新內容」
// success toast,讓使用者誤以為又花了 token。
//
// 修法:抽 pickRescanToast helper,純 cache hit(pageUsage.cacheHits === done)→ 回
// 'silent',rescan callback 改用 hideToast 把 loading toast 藏掉、不顯示 success toast。
// 失敗或有 API call 的情境維持原 toast。
//
// SANITY 紀錄(已驗證):暫時把 isPureCacheHit 條件改成 false(永遠不 silent),
// test 1 (純 cache hit silent) fail;還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('純 cache hit(cacheHits === done)應 silent,不顯示 success toast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 1,
      failedCount: 0,
      pageUsage: { cacheHits: 1 },
      totalRequested: 1,
    }))
  `);

  expect(JSON.parse(result)).toEqual({ type: 'silent' });
  await page.close();
});

test('混合 cache + API(cacheHits < done)應顯示 success toast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 5,
      failedCount: 0,
      pageUsage: { cacheHits: 3 },
      totalRequested: 5,
    }))
  `);

  const decision = JSON.parse(result);
  expect(decision.type).toBe('success');
  expect(decision.msg).toContain('已翻譯 5 段');
  await page.close();
});

test('全部 API call(cacheHits=0)應顯示 success toast', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 3,
      failedCount: 0,
      pageUsage: { cacheHits: 0 },
      totalRequested: 3,
    }))
  `);

  expect(JSON.parse(result).type).toBe('success');
  await page.close();
});

test('部分失敗(failedCount > 0)應顯示 error toast,不論是否純 cache hit', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 3,
      failedCount: 2,
      pageUsage: { cacheHits: 3 },
      totalRequested: 5,
    }))
  `);

  const decision = JSON.parse(result);
  expect(decision.type).toBe('error');
  expect(decision.msg).toContain('2 / 5');
  await page.close();
});

test('pageUsage 為 null(極端情境)不應誤判為純 cache hit', async ({ context, localServer }) => {
  // forcing function:防將來 translateUnits 改 API 把 pageUsage 拿掉時,helper 不會
  // 沉默吞掉所有 toast。pageUsage=null → 預設走 success(保留通知,不靜音)
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/guard-overwrite.html`, { waitUntil: 'domcontentloaded' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__SK._pickRescanToast({
      done: 1,
      failedCount: 0,
      pageUsage: null,
      totalRequested: 1,
    }))
  `);

  expect(JSON.parse(result).type).toBe('success');
  await page.close();
});
