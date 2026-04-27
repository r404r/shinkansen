// Regression: v1.6.20 A 路徑 — 自動翻譯字幕 + CC 沒開 → 自動點 CC button
//
// 驗證:
//   1. CC 沒開(aria-pressed=false)→ forceSubtitleReload 主動點 button 開啟,
//      _autoCcToggled flag 設為 true。
//   2. CC 已開(aria-pressed=true)→ 維持原 toggle XHR 路徑(click 兩次:關 + 開)。
//
// SANITY CHECK 已完成:
//   把 forceSubtitleReload 內 `if (!isOn)` 分支的 `btn.click()` 註解掉
//   → test #1 fail(clickCount=0 而非 ≥1)→ 還原 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-auto-cc';

test('youtube-auto-cc: CC 沒開時 forceSubtitleReload 主動點 button 開啟 + 設 _autoCcToggled', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 攔 button click 計數
  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    const btn = document.querySelector('.ytp-subtitles-button');
    window.__ccClickCount = 0;
    btn.click = function() { window.__ccClickCount++; };
  `);

  // CC 預設 aria-pressed=false(fixture HTML 已設定),啟動翻譯後 1s setTimeout 跑 forceSubtitleReload
  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    clickCount: window.__ccClickCount,
    autoToggled: window.__SK.YT._autoCcToggled,
    active: window.__SK.YT.active,
  })`);

  expect(result.active, '翻譯流程應啟動').toBe(true);
  expect(
    result.clickCount,
    `CC 沒開時應主動點 button 開啟。實際 clickCount=${result.clickCount}`,
  ).toBeGreaterThanOrEqual(1);
  expect(
    result.autoToggled,
    'YT._autoCcToggled 應為 true(每 session 只自動開一次)',
  ).toBe(true);

  await page.close();
});

test('youtube-auto-cc: CC 已開時 forceSubtitleReload 走原 toggle XHR 路徑(click 2 次)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  await evaluate(`
    chrome.runtime.sendMessage = async function() { return { ok: true }; };
    const btn = document.querySelector('.ytp-subtitles-button');
    btn.setAttribute('aria-pressed', 'true');  // CC 已開
    window.__ccClickCount = 0;
    btn.click = function() { window.__ccClickCount++; };
  `);

  await evaluate(`(() => { window.__SK.translateYouTubeSubtitles(); })()`);
  await page.waitForTimeout(1500);

  const result = await evaluate(`({
    clickCount: window.__ccClickCount,
    autoToggled: window.__SK.YT._autoCcToggled,
  })`);

  // 原行為:CC 已開 → 關閉(click 1)→ 200ms 後若 active 仍開啟(click 2)
  expect(
    result.clickCount,
    `CC 已開時應走 toggle XHR 路徑(click 2 次)。實際 ${result.clickCount}`,
  ).toBe(2);
  expect(
    result.autoToggled,
    'CC 已開路徑不應 set _autoCcToggled',
  ).toBe(false);

  await page.close();
});
