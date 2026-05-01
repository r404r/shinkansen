// Regression: 使用者按 CC 關閉 → 暫停送 API,CC 重開 → 自動續翻
//
// 背景:在 v1.x.x 之前,使用者按 YouTube CC 按鈕關閉字幕後,
// onVideoTimeUpdate / RateChange / Seeked 仍會繼續驅動 translateWindowFrom,
// 持續送 TRANSLATE_SUBTITLE_BATCH 燒 token。修正後新增 YT.ccPaused +
// _ccButtonObserver:
//   - aria-pressed: true → false  → ccPaused=true,timeupdate 等 driver 直接 return
//   - aria-pressed: false → true → ccPaused=false,translatedUpToMs 對齊當前
//     currentTime 視窗 + 立刻觸發 translateWindowFrom 補齊
//
// 測試 4 個 case:
//   1. baseline: CC on + rawSegments 已填 → 啟動翻譯後 batchCount ≥ 1
//   2. CC off → timeupdate 不再觸發 batch(計數凍結)
//   3. CC 重開 → 立刻觸發一次 batch,translatedUpToMs 對齊當下視窗
//   4. ccPaused 期間 seek → translatedUpToMs 不被改動(避免暫停期間拖進度條
//      汙染暫停前的記錄)
//
// SANITY CHECK 已完成(2026-04-30,Claude Code 端):
//   - 暫時把 onVideoTimeUpdate 內 `if (YT.ccPaused) return;` 註解掉
//     → case 2 fail(batchCount 持續累加)→ 還原 pass
//   - 暫時把 _observeCcButton 內 `YT.translatedUpToMs = newWindowStart;` 註解掉
//     → case 3 仍 pass(translateWindowFrom 還是會送 batch),但 case 3 的
//     translatedUpToMs 對齊斷言 fail → 還原 pass

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-cc-pause';

// 共用 setup:mock sendMessage 計數 + 設 YT.config + 塞 rawSegments(跨多個 window)
async function commonSetup(page) {
  const { evaluate } = await getShinkansenEvaluator(page);
  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(`
    window.__batchCount = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__batchCount++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: {
            inputTokens: 1, outputTokens: 1, cachedTokens: 0,
            billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0,
          },
        };
      }
      return { ok: true };
    };
  `);
  // 塞跨多個 window 的字幕(預設 windowSizeS=30 → window0=0~30s, window1=30~60s, window2=60~90s)
  await evaluate(`
    window.__SK.YT.rawSegments = [
      { startMs:  5000, endMs:  7000, text: 'a', normText: 'a', groupId: null },
      { startMs: 35000, endMs: 37000, text: 'b', normText: 'b', groupId: null },
      { startMs: 65000, endMs: 67000, text: 'c', normText: 'c', groupId: null },
    ];
  `);
  return evaluate;
}

test('youtube-cc-pause case 1 (baseline): CC 開 + rawSegments 已填 → 啟動翻譯後 batchCount ≥ 1', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  // CC 已開(fixture 預設 aria-pressed=true)→ 啟動翻譯立刻送 batch
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    active: window.__SK.YT.active,
    ccPaused: window.__SK.YT.ccPaused,
    batchCount: window.__batchCount,
  })`);

  expect(result.active, 'YT.active 應為 true').toBe(true);
  expect(result.ccPaused, 'CC 開 → ccPaused 應為 false').toBe(false);
  expect(
    result.batchCount,
    `baseline 應送 ≥ 1 筆 batch(實際 ${result.batchCount})`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('youtube-cc-pause case 2: CC 從開切到關 → 後續 timeupdate 不再觸發 batch', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  // 啟動翻譯(CC 已開)→ 第一次 batch 送出 → translatedUpToMs 推進到 window0 終點(30000)
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const baselineCount = await evaluate(`window.__batchCount`);
  expect(baselineCount, 'baseline 應送 ≥ 1 筆').toBeGreaterThanOrEqual(1);

  // 把 CC 切到 false → MutationObserver 觸發 ccPaused=true
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false');
  `);
  await page.waitForTimeout(100); // 給 MutationObserver 一點時間

  const afterCcOff = await evaluate(`window.__SK.YT.ccPaused`);
  expect(afterCcOff, 'CC 關 → ccPaused 應為 true').toBe(true);

  // 推進 currentTime 到下個 lookahead 範圍(>20000 ms)+ 觸發 timeupdate
  // 若 ccPaused guard 失效,會走 translateWindowFrom(window 30000)送新 batch
  await evaluate(`
    const video = document.querySelector('video');
    video.currentTime = 25;
    video.dispatchEvent(new Event('timeupdate'));
  `);
  await page.waitForTimeout(300);

  // 額外觸發一次 ratechange + seeked,各 driver 都應該被 ccPaused 擋掉
  // 用 try-catch 包住:即使 fixture 環境下 native 事件 dispatch 出錯,我們關心的
  // 是 batchCount 不增加,而不是 dispatch 本身。
  await evaluate(`
    (() => {
      try {
        const video = document.querySelector('video');
        video.dispatchEvent(new Event('ratechange'));
      } catch (e) { window.__rateErr = String(e); }
      try {
        const video = document.querySelector('video');
        video.currentTime = 28;
        video.dispatchEvent(new Event('seeked'));
      } catch (e) { window.__seekErr = String(e); }
    })()
  `);
  await page.waitForTimeout(300);

  const finalCount = await evaluate(`window.__batchCount`);
  expect(
    finalCount,
    `CC 關後 timeupdate/ratechange/seeked 不應觸發新 batch(baseline=${baselineCount}, after=${finalCount})`,
  ).toBe(baselineCount);

  await page.close();
});

test('youtube-cc-pause case 3: CC 重開 → translatedUpToMs 對齊當前 currentTime 視窗 + 立刻送 batch', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const baselineCount = await evaluate(`window.__batchCount`);

  // CC 關
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false');
  `);
  await page.waitForTimeout(100);
  expect(await evaluate(`window.__SK.YT.ccPaused`)).toBe(true);

  // 暫停期間使用者拖進度條到 70 秒(window2 起點 60000)
  await evaluate(`
    const video = document.querySelector('video');
    video.currentTime = 70;
  `);

  // CC 重開 → ccPaused 應變 false,translatedUpToMs 應重設到 60000(window2 起點),
  // 並立刻 translateWindowFrom(60000)→ batchCount +1
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'true');
  `);
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    ccPaused: window.__SK.YT.ccPaused,
    translatedUpToMs: window.__SK.YT.translatedUpToMs,
    batchCount: window.__batchCount,
  })`);

  expect(result.ccPaused, 'CC 重開 → ccPaused 應變 false').toBe(false);
  // _observeCcButton 重設 translatedUpToMs 到 newWindowStart(60000),translateWindowFrom
  // 內部一進入立刻把 translatedUpToMs 推到 windowEndMs(60000 + 30000 = 90000)。
  // 所以最終值 = 90000,代表「CC 重開後 translateWindowFrom(60000) 確實跑過」。
  // 若沒重設邏輯,translatedUpToMs 會卡在 case 2 留下的 30000。
  expect(
    result.translatedUpToMs,
    `CC 重開應重設 translatedUpToMs 到當前 currentTime(70s)的視窗(window2 起點 60000),translateWindowFrom 內部再推到 windowEndMs(90000)。實際 ${result.translatedUpToMs}`,
  ).toBe(90000);
  expect(
    result.batchCount,
    `CC 重開應立刻觸發一次 translateWindowFrom 補齊(baseline=${baselineCount}, after=${result.batchCount})`,
  ).toBeGreaterThan(baselineCount);

  await page.close();
});

test('youtube-cc-pause case 5: CC 關 → player root 加 shinkansen-cc-paused class 隱藏殘留 caption-window;CC 重開 → 移除 class', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  // baseline: CC 開 → root 不應有 shinkansen-cc-paused class
  const baseline = await evaluate(`
    document.querySelector('.html5-video-player').classList.contains('shinkansen-cc-paused')
  `);
  expect(baseline, 'baseline:CC 開時 player root 不應有 shinkansen-cc-paused class').toBe(false);

  // CC 關 → root 應加上 class(讓 stylesheet 隱藏 .caption-window)
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false');
  `);
  await page.waitForTimeout(100);

  const afterOff = await evaluate(`
    document.querySelector('.html5-video-player').classList.contains('shinkansen-cc-paused')
  `);
  expect(afterOff, 'CC 關 → player root 應加上 shinkansen-cc-paused class').toBe(true);

  // CC 重開 → root 應移除 class(原生 caption 恢復顯示)
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'true');
  `);
  await page.waitForTimeout(100);

  const afterOn = await evaluate(`
    document.querySelector('.html5-video-player').classList.contains('shinkansen-cc-paused')
  `);
  expect(afterOn, 'CC 重開 → player root 應移除 shinkansen-cc-paused class').toBe(false);

  await page.close();
});

test('youtube-cc-pause case 4: ccPaused 期間 seek 不應改動 translatedUpToMs', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const evaluate = await commonSetup(page);

  await evaluate(`window.__SK.translateYouTubeSubtitles()`);
  await page.waitForTimeout(500);

  const before = await evaluate(`window.__SK.YT.translatedUpToMs`);

  // CC 關 → 觸發 seeked(暫停前 onVideoSeeked 會重設 translatedUpToMs,暫停後不應動)
  await evaluate(`
    document.querySelector('.ytp-subtitles-button').setAttribute('aria-pressed', 'false');
  `);
  await page.waitForTimeout(100);

  await evaluate(`
    const video = document.querySelector('video');
    video.currentTime = 50;  // 落在 window1(30~60s)
    video.dispatchEvent(new Event('seeked'));
  `);
  await page.waitForTimeout(200);

  const after = await evaluate(`window.__SK.YT.translatedUpToMs`);
  expect(
    after,
    `ccPaused 期間 seeked 不應改動 translatedUpToMs(before=${before}, after=${after})`,
  ).toBe(before);

  await page.close();
});
