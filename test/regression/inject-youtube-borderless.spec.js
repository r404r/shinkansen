// Regression: YouTube 無邊模式 toggle 行為（v1.8.22 新增）
//
// 結構特徵:SK.YT.Borderless.toggle() 在 watch 頁時 inject CSS、強制 theatre、
// 寫 video inline style;再 toggle 時撤除全部變更。SPA 切影片透過
// reapplyOnNavigation 重套(本 spec 同時驗 active flag persist + 切非 watch 頁
// CSS 撤掉但 active=true 保留)。
//
// 不在本 spec 驗的範圍:
//   - chrome.windows.update 真實 resize(無真視窗,sendMessage 在 fixture 內無接收端)
//   - YouTube player JS 對 dispatchEvent('resize') 的反應
//   這兩件由 Jimmy 在實機 Chrome / install-as-app 視窗手動驗收
//
// SANITY 紀錄(已驗證,2026-04-30):
//   把 SK.YT.Borderless.apply() 內 injectStyle() 註解掉 → test #1 fail(找不到
//   <style id="sk-yt-borderless">)。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-borderless';

test('youtube-borderless: toggle ON → inject CSS + 強制 theater + video inline style', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // toggle ON
  await evaluate(`window.__SK.YT.Borderless.toggle()`);

  const after = await page.evaluate(() => ({
    hasStyleEl: !!document.getElementById('sk-yt-borderless'),
    theaterAttr: document.querySelector('ytd-watch-flexy')?.hasAttribute('theater'),
    videoInline: document.querySelector('video.html5-main-video')?.getAttribute('style') || '',
  }));

  expect(after.hasStyleEl, '<style id="sk-yt-borderless"> 應插入 head').toBe(true);
  expect(after.theaterAttr, 'ytd-watch-flexy 應有 theater attribute').toBe(true);
  expect(after.videoInline, 'video 應寫 inline width:100vw').toContain('100vw');
  expect(after.videoInline, 'video 應寫 inline object-fit:contain').toContain('contain');

  const isActive = await evaluate(`window.__SK.YT.Borderless.isActive()`);
  expect(isActive, 'active flag 應為 true').toBe(true);

  await page.close();
});

test('youtube-borderless: toggle OFF → 撤除 CSS + 還原 theater + 清 video inline', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 先確認 fixture 起始無 theater attribute(snapshot 應記錄為 false)
  const before = await page.evaluate(() => ({
    theaterAttr: document.querySelector('ytd-watch-flexy')?.hasAttribute('theater'),
  }));
  expect(before.theaterAttr, 'fixture 應從非 theatre 狀態開始').toBe(false);

  // toggle ON 再 OFF
  await evaluate(`window.__SK.YT.Borderless.toggle()`);
  await evaluate(`window.__SK.YT.Borderless.toggle()`);

  const after = await page.evaluate(() => ({
    hasStyleEl: !!document.getElementById('sk-yt-borderless'),
    theaterAttr: document.querySelector('ytd-watch-flexy')?.hasAttribute('theater'),
    videoInline: document.querySelector('video.html5-main-video')?.getAttribute('style') || '',
  }));

  expect(after.hasStyleEl, '<style id="sk-yt-borderless"> 應移除').toBe(false);
  expect(after.theaterAttr, 'theater attribute 應還原為原狀(無)').toBe(false);
  expect(after.videoInline.includes('100vw'), 'video inline style 應清除').toBe(false);

  const isActive = await evaluate(`window.__SK.YT.Borderless.isActive()`);
  expect(isActive, 'active flag 應為 false').toBe(false);

  await page.close();
});

test('youtube-borderless: 預先有 theater 的話,toggle off 不可誤關', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 模擬使用者已自行進入劇院模式
  await page.evaluate(() => {
    document.querySelector('ytd-watch-flexy').setAttribute('theater', '');
  });

  // toggle ON 再 OFF
  await evaluate(`window.__SK.YT.Borderless.toggle()`);
  await evaluate(`window.__SK.YT.Borderless.toggle()`);

  const theaterAfter = await page.evaluate(
    () => document.querySelector('ytd-watch-flexy').hasAttribute('theater'),
  );
  expect(
    theaterAfter,
    '使用者本來就在劇院模式,toggle off 後應保留 theater(snapshot 記得是 true)',
  ).toBe(true);

  await page.close();
});

test('youtube-borderless: 非 watch 頁 toggle 應沉默 no-op', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  // 不 override isYouTubePage,讓它走預設(localhost → false)

  await evaluate(`window.__SK.YT.Borderless.toggle()`);

  const hasStyleEl = await page.evaluate(() => !!document.getElementById('sk-yt-borderless'));
  expect(hasStyleEl, '非 watch 頁應 no-op,不該注入 CSS').toBe(false);

  const isActive = await evaluate(`window.__SK.YT.Borderless.isActive()`);
  expect(isActive, 'active flag 應維持 false').toBe(false);

  await page.close();
});

test('youtube-borderless: reapplyOnNavigation 切到非 watch 頁 → 撤 CSS 但保留 active', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 先進入無邊模式
  await evaluate(`window.__SK.YT.Borderless.toggle()`);
  expect(await evaluate(`window.__SK.YT.Borderless.isActive()`)).toBe(true);

  // 模擬 SPA 切到非 watch 頁(例如首頁)
  await evaluate(`window.__SK.isYouTubePage = () => false`);
  await evaluate(`window.__SK.YT.Borderless.reapplyOnNavigation()`);

  const after = await page.evaluate(() => ({
    hasStyleEl: !!document.getElementById('sk-yt-borderless'),
    videoInline: document.querySelector('video.html5-main-video')?.getAttribute('style') || '',
  }));

  expect(after.hasStyleEl, '非 watch 頁 reapply 應撤 CSS').toBe(false);
  expect(after.videoInline.includes('100vw'), 'video inline 應清除').toBe(false);

  // active flag 應保留(等切回 watch 頁自動重套)
  const isActive = await evaluate(`window.__SK.YT.Borderless.isActive()`);
  expect(isActive, '非 watch 頁時 active 應保留 true').toBe(true);

  await page.close();
});

test('youtube-borderless: _calcTargetWindowHeight 純函式驗算', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#page-loaded-sentinel', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // ── 中間範圍(不觸發 min/max clamp)
  // 16:9 影片(1920×1080),innerW=400,outerH=300,innerH=270 → chromeH=30
  // targetInner = 400×9/16 = 225,raw = 255。
  // 200 < 255 < 0.8×720 = 576,不被 clamp,預期回 255
  const target16x9 = await evaluate(`
    window.__SK.YT.Borderless._calcTargetWindowHeight(1920, 1080, 400, 300, 270)
  `);
  expect(target16x9, '16:9 影片中等尺寸應算出 225+30=255').toBe(255);

  // 2:1 影片(3840×1920),innerW=400,outerH=300,innerH=270 → chromeH=30
  // targetInner = 400/2 = 200,raw = 230。預期回 230
  const target2x1 = await evaluate(`
    window.__SK.YT.Borderless._calcTargetWindowHeight(3840, 1920, 400, 300, 270)
  `);
  expect(target2x1, '2:1 影片中等尺寸應算出 200+30=230').toBe(230);

  // ── minOuter clamp:極小 inputs 應被拉回 200
  // video 1:1, innerW=10, outerH=10, innerH=10 → targetInner=10, chromeH=0, raw=10
  // 10 < 200 = minOuter → clamp 200
  const tiny = await evaluate(`
    window.__SK.YT.Borderless._calcTargetWindowHeight(1, 1, 10, 10, 10)
  `);
  expect(tiny, '極小 target 應 clamp 至 minOuter=200').toBe(200);

  // ── maxOuter clamp:極大 inputs 應被 clamp 至 0.8 × screen.availHeight
  // 抓 runtime 的 availHeight 算 expected,讓斷言在任意 headless screen 都成立
  const expectedMax = await evaluate(`Math.round((screen.availHeight || 1080) * 0.8)`);
  const huge = await evaluate(`
    window.__SK.YT.Borderless._calcTargetWindowHeight(1, 1, 100000, 100000, 0)
  `);
  expect(huge, '極大 target 應 clamp 至 maxOuter').toBe(expectedMax);

  await page.close();
});
