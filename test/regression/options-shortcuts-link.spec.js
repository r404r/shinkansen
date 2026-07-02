// Regression: 「翻譯快速鍵」段落的「擴充功能快捷鍵設定」連結必須可點且跳轉
//
// 歷史:fork 在 d2a1d5c 以 id="open-shortcuts" 綁 click(三分支跳轉);
// upstream v1.8.22 改為 class=".open-shortcuts-link" + querySelectorAll 綁定。
// merge 0b0af57 時 options.js 採 upstream 的 class 綁定、options.html 卻保留
// fork 的無 class 錨點 → 連結死亡;之後 i18n 改造(924f1d7)又在外層 <p> 加
// data-i18n,applyLocale 的 textContent 覆寫把錨點整個抹掉,整句消失。
//
// 修法:錨點補回 class="open-shortcuts-link";連結句拆出 data-i18n 覆蓋範圍
// (獨立 <span id="hotkey-shortcuts-line">),applyRichTextLocale 用 replaceChildren
// 保留既有錨點節點(click listener 不丟)只更新前後文字。
//
// SANITY:把 options.html 錨點的 class="open-shortcuts-link" 拿掉 → 第三條
// (點擊開新分頁)fail;還原 → pass。

import { test, expect } from '../fixtures/extension.js';

test('連結存在、有綁定 class、i18n 套用後仍在 DOM', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#preset-key-1');

  const link = page.locator('#open-shortcuts');
  await expect(link).toBeVisible();
  await expect(link).toHaveClass(/open-shortcuts-link/);
  await expect(link).toHaveText('擴充功能快捷鍵設定');
  await expect(page.locator('#hotkey-shortcuts-line')).toContainText('鍵位可至');
});

test('切換 UI 語言後連結文字更新且節點仍在(listener 不丟)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#preset-key-1');

  await page.selectOption('#uiLocale', 'zh-CN');
  const link = page.locator('#open-shortcuts');
  await expect(link).toHaveText('扩展快捷键设置');
  await expect(link).toHaveClass(/open-shortcuts-link/);
  await expect(page.locator('#hotkey-shortcuts-line')).toContainText('键位可至');

  // 切回 zh-TW 再驗一次(applyRichTextLocale 重複執行不能弄丟錨點)
  await page.selectOption('#uiLocale', 'zh-TW');
  await expect(link).toHaveText('擴充功能快捷鍵設定');
});

test('點擊連結開新分頁到 chrome://extensions/shortcuts(語言切換後 listener 仍有效)', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/options.html`);
  await page.waitForSelector('#preset-key-1');

  // 先切一次語言,驗證 replaceChildren 重排後 click listener 沒被丟掉
  await page.selectOption('#uiLocale', 'zh-CN');
  await expect(page.locator('#open-shortcuts')).toHaveText('扩展快捷键设置');

  const [newPage] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#open-shortcuts'),
  ]);
  await newPage.waitForLoadState('domcontentloaded');
  expect(newPage.url()).toBe('chrome://extensions/shortcuts');
});
