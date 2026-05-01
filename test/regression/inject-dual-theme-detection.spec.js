// Regression: v1.8.31 dual-mode 依頁面實際背景亮度切 dark/light 配色
//
// 結構特徵:injectDual 注入時呼叫 detectThemeForElement(original),從 original
// 往上 walk 抓第一層 alpha > 0.5 的背景色,算 luma 後決定 wrapper 的 data-sk-theme。
// CSS 用 [data-sk-mark="tint"][data-sk-theme="dark"] 變體覆蓋米色底為半透明白。
//
// 為什麼用實際背景色而非 prefers-color-scheme:後者反映 OS 偏好,不反映「這個頁面
// 實際是不是 dark」(OS dark + 站點亮色 是常見混合,prefers 會誤判)。
//
// SANITY 紀錄(已驗證):
//   1. 把 detectThemeForElement 內 `luma < 128 ? 'dark' : 'light'` 翻轉成
//      `luma < 128 ? 'light' : 'dark'`,黑底 case data-sk-theme 變 'light',
//      computed bg 變米色 rgb(255, 248, 225),spec fail;還原後 pass。
//   2. 把 ensureDualWrapperStyle 的 dark 變體那三行刪掉,黑底 case computed bg
//      仍是米色,spec fail;還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('dual-theme: 黑底 body → wrapper data-sk-theme="dark" + tint 改半透明白', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-tint', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 把 body 背景改成黑色,模擬 dark mode 頁面
  await evaluate(`document.body.style.backgroundColor = 'rgb(0, 0, 0)'`);

  await evaluate(`(() => {
    const el = document.querySelector('#mark-tint');
    window.__shinkansen.testInjectDual(el, '譯文', { markStyle: 'tint' });
  })()`);

  const after = await page.evaluate(() => {
    const wrapper = document.querySelector('#mark-tint').nextElementSibling;
    if (!wrapper) return null;
    const cs = window.getComputedStyle(wrapper);
    return {
      theme: wrapper.getAttribute('data-sk-theme'),
      mark: wrapper.getAttribute('data-sk-mark'),
      bgColor: cs.backgroundColor,
    };
  });

  expect(after).not.toBeNull();
  expect(after.mark).toBe('tint');
  expect(after.theme).toBe('dark');
  // tint dark = rgba(255, 255, 255, 0.08) — 不同瀏覽器可能 round 成 0.08 / 0.0784...
  expect(after.bgColor).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.0[78]\d*\)/);

  await page.close();
});

test('dual-theme: 白底 body → wrapper data-sk-theme="light" + tint 維持米色', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-tint', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // explicit 設白底,排除 fixture default 的不確定性
  await evaluate(`document.body.style.backgroundColor = 'rgb(255, 255, 255)'`);

  await evaluate(`(() => {
    const el = document.querySelector('#mark-tint');
    window.__shinkansen.testInjectDual(el, '譯文', { markStyle: 'tint' });
  })()`);

  const after = await page.evaluate(() => {
    const wrapper = document.querySelector('#mark-tint').nextElementSibling;
    if (!wrapper) return null;
    const cs = window.getComputedStyle(wrapper);
    return {
      theme: wrapper.getAttribute('data-sk-theme'),
      mark: wrapper.getAttribute('data-sk-mark'),
      bgColor: cs.backgroundColor,
    };
  });

  expect(after).not.toBeNull();
  expect(after.mark).toBe('tint');
  expect(after.theme).toBe('light');
  // tint light = #FFF8E1 = rgb(255, 248, 225)
  expect(after.bgColor).toBe('rgb(255, 248, 225)');

  await page.close();
});

test('dual-theme: 透明 body 追到 html 仍透明 → fallback "light"', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mark-tint', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 不設背景色,讓 body / html 都透明(瀏覽器預設)
  await evaluate(`(() => {
    const el = document.querySelector('#mark-tint');
    window.__shinkansen.testInjectDual(el, '譯文', { markStyle: 'tint' });
  })()`);

  const theme = await page.evaluate(() => {
    const wrapper = document.querySelector('#mark-tint').nextElementSibling;
    return wrapper?.getAttribute('data-sk-theme');
  });

  // 透明追到根仍透明 → 走 'light' fallback
  expect(theme).toBe('light');

  await page.close();
});
