// Regression: v1.5.2 iframe gate（all_frames + 尺寸/可見性過濾）
//
// 結構特徵：v1.5.2 起 manifest 開 `all_frames: true`，content script 也注入到
// iframe（為了能翻 BBC 等站點嵌入的 Flourish / Datawrapper 第三方圖表 iframe）。
// 但 0×0 廣告 iframe、reCAPTCHA、cookie consent、Cxense / DoubleClick 等技術性
// iframe 不該被翻——所以 content-ns.js 開頭加 gate 函式 _sk_shouldDisableInFrame()，
// 不合格的 iframe 設 SK.disabled = true，後續 7 個 IIFE 模組看到 disabled 就 return。
//
// 本 spec 直接驗 gate pure function 的判定邏輯（透過 SK.shouldDisableInFrame
// 暴露的 4-參數簽名：isFrame, width, height, visible）。
//
// SANITY 紀錄（已驗證）：把 _sk_shouldDisableInFrame 的判定全部改回
// `return false`（永遠啟動），spec 第 4 / 5 / 6 條斷言會 fail；還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('iframe-gate: shouldDisableInFrame 對主 frame / 不合格 / 合格 iframe 行為', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/dual.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#basic', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 主 frame 一定不被 gate 擋——SK 命名空間應該完整初始化
  const mainFrame = await evaluate(`(() => ({
    hasSK: !!window.__SK,
    disabled: !!window.__SK?.disabled,
    hasStateMap: window.__SK?.STATE instanceof Object,
    hasInjectDual: typeof window.__SK?.injectDual === 'function',
  }))()`);
  expect(mainFrame.hasSK, '主 frame SK 應存在').toBe(true);
  expect(mainFrame.disabled, '主 frame SK.disabled 應為 false').toBe(false);
  expect(mainFrame.hasStateMap, '主 frame SK.STATE 應已初始化').toBe(true);
  expect(mainFrame.hasInjectDual, '主 frame SK.injectDual 應已註冊').toBe(true);

  // gate function 判定邏輯（pure function 簽名：isFrame, width, height, visible）
  const judgments = await evaluate(`(() => {
    const fn = window.__SK.shouldDisableInFrame;
    return {
      mainFrame:           fn(false, 0,    0,    true),     // 不是 iframe → 永不擋
      iframeInvisible:     fn(true,  800,  600,  false),    // 不可見 → 擋
      iframeZeroSize:      fn(true,  0,    0,    true),     // 0×0 廣告 → 擋
      iframeOnePxAd:       fn(true,  1,    1,    true),     // 1×1 像素廣告 → 擋
      iframeTooNarrow:     fn(true,  100,  600,  true),     // 寬不足 200 → 擋
      iframeTooShort:      fn(true,  800,  50,   true),     // 高不足 100 → 擋
      iframeAtThreshold:   fn(true,  200,  100,  true),     // 剛達 200×100 → 啟動
      iframeFlourishChart: fn(true,  900,  600,  true),     // 典型嵌入圖表尺寸 → 啟動
    };
  })()`);

  expect(judgments.mainFrame,           '主 frame 永不擋').toBe(false);
  expect(judgments.iframeInvisible,     '不可見 iframe → 擋').toBe(true);
  expect(judgments.iframeZeroSize,      '0×0 iframe → 擋').toBe(true);
  expect(judgments.iframeOnePxAd,       '1×1 廣告 iframe → 擋').toBe(true);
  expect(judgments.iframeTooNarrow,     '寬不足 200 → 擋').toBe(true);
  expect(judgments.iframeTooShort,      '高不足 100 → 擋').toBe(true);
  expect(judgments.iframeAtThreshold,   '剛好 200×100 → 啟動').toBe(false);
  expect(judgments.iframeFlourishChart, '900×600 嵌入圖表 → 啟動').toBe(false);

  await page.close();
});
