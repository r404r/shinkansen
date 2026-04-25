// Regression: v1.5.0 dual-mode dispatcher 路由
//
// 結構特徵：SK.injectTranslation 入口依 STATE.translatedMode 分派——
//   translatedMode === 'dual' && unit.kind !== 'fragment' && SK.injectDual
//     → 走 SK.injectDual（雙語 wrapper 注入，原段落不動）
//   其他情況 → 走原本的 single-mode 路徑（覆蓋 element 內容）
// 這條測試確保「同一個 testInject 入口」會依當前 STATE.translatedMode 走出
// 兩種完全不同的行為——是 v1.5.0 dispatch head 的核心保證。
//
// SANITY 紀錄（已驗證）：把 SK.injectTranslation 內的 dispatch 條件
// `STATE.translatedMode === 'dual'` 改為 `false`，dual 段也走 single 路徑：
// 預期 dual 段的 #restore-source 文字被覆蓋成「把我還原。」、不應該有 wrapper，
// 但 spec 斷言「文字未動 + wrapper afterend」會 fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('mode-switch: 同一 testInject 入口在 single/dual 模式下走出兩種注入路徑', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 路徑 A：single 模式（預設 translatedMode 為 null/single） ──
  // 確認 dispatcher 走原路徑 → 元素內容被覆蓋
  await evaluate(`(() => {
    const el = document.querySelector('#basic');
    return window.__shinkansen.testInject(el, '你好世界。');
  })()`);

  const afterSingle = await page.evaluate(() => {
    const el = document.querySelector('#basic');
    return {
      text: el.textContent,
      hasNextWrapper: el.nextElementSibling?.tagName?.toLowerCase() === 'shinkansen-translation',
      hasDualSourceAttr: el.hasAttribute('data-shinkansen-dual-source'),
    };
  });
  expect(afterSingle.text, 'single 模式下元素應被覆蓋').toBe('你好世界。');
  expect(afterSingle.hasNextWrapper, 'single 模式不應該產生 wrapper').toBe(false);
  expect(afterSingle.hasDualSourceAttr, 'single 模式不應掛 dual-source attribute').toBe(false);

  // ── 路徑 B：切到 dual 模式 ──
  await evaluate(`window.__shinkansen.setTestState({ translatedMode: 'dual' })`);

  // 用一個還沒被動過的 target
  await evaluate(`(() => {
    const el = document.querySelector('#restore-source');
    return window.__shinkansen.testInject(el, '把我還原。');
  })()`);

  const afterDual = await page.evaluate(() => {
    const el = document.querySelector('#restore-source');
    const next = el.nextElementSibling;
    return {
      originalText: el.textContent,
      hasDualSourceAttr: el.hasAttribute('data-shinkansen-dual-source'),
      nextWrapperTag: next?.tagName?.toLowerCase(),
      innerText: next?.firstElementChild?.textContent,
    };
  });
  expect(afterDual.originalText, 'dual 模式下原文不應被改動').toBe('Restore me.');
  expect(afterDual.hasDualSourceAttr, 'dual 模式應掛 dual-source attribute').toBe(true);
  expect(afterDual.nextWrapperTag, 'dual 模式應產生 wrapper').toBe('shinkansen-translation');
  expect(afterDual.innerText, 'wrapper 內譯文').toBe('把我還原。');

  await page.close();
});
