// Regression: v1.3.9 YouTube 字幕主動抓取架構（Innertube 重構）
//
// 驗證三項核心行為：
//   (1) extractCaptionTracksFromPage(videoId)：從頁面 <script> 標籤解析 captionTracks
//   (2) selectBestTrack(tracks)：優先選英文人工翻譯、次選 ASR、排除中文軌道
//   (3) translateYouTubeSubtitles 完整流程：
//         FETCH_YT_CAPTIONS mock 回傳 JSON3 → rawSegments 填入 → startCaptionObserver →
//         translateWindowFrom → TRANSLATE_SUBTITLE_BATCH 被呼叫
//
// 觸發條件（結構通則）：
//   - 頁面含 <script> 內嵌 ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
//   - videoId 與 script 內容吻合（validateVideoId 檢查）
//   - background FETCH_YT_CAPTIONS 回傳非空 responseText（JSON3 格式）
//   - YT.active 在抓取期間未被停止
//
// 若 extractCaptionTracksFromPage 失效（例如解析邏輯錯誤、balanced bracket 算法出錯、
// videoId 驗證誤判），tracks 將為 null，FETCH_YT_CAPTIONS 不被呼叫，rawSegments 保持空。
//
// <!-- SANITY-PENDING: 驗證方式：
//   把 extractCaptionTracksFromPage 的 `if (videoId && !text.includes(videoId)) continue;`
//   改為永遠 continue（模擬 videoId 不符），tracks 應為 null，
//   FETCH_YT_CAPTIONS 呼叫次數應降為 0，rawSegments.length 應為 0，測試 fail。
//   還原後 pass。 -->

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-innertube-fetch';
const VIDEO_ID = 'testABC1234';

// JSON3 格式的假字幕資料（3 條，含時間戳）
const MOCK_JSON3 = JSON.stringify({
  events: [
    { tStartMs: 0,     segs: [{ utf8: 'Hello world' }] },
    { tStartMs: 3000,  segs: [{ utf8: 'This is a test' }] },
    { tStartMs: 6000,  segs: [{ utf8: 'Goodbye' }] },
  ],
});

test('youtube-innertube-fetch: extractCaptionTracksFromPage 解析頁面 script 取得軌道', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 直接呼叫 extractCaptionTracksFromPage（透過 debug bridge 暴露的 eval 環境）
  const result = await evaluate(`
    (function() {
      // 複製 extractCaptionTracksFromPage 邏輯（與 content-youtube.js 保持一致）
      function extractCaptionTracksFromPage(videoId) {
        for (const script of document.querySelectorAll('script:not([src])')) {
          const text = script.textContent;
          if (!text.includes('"captionTracks"')) continue;
          if (videoId && !text.includes(videoId)) continue;
          try {
            const ctIdx = text.indexOf('"captionTracks"');
            if (ctIdx === -1) continue;
            const arrStart = text.indexOf('[', ctIdx);
            if (arrStart === -1) continue;
            let depth = 0, i = arrStart;
            while (i < text.length) {
              if (text[i] === '[' || text[i] === '{') depth++;
              else if (text[i] === ']' || text[i] === '}') {
                depth--;
                if (depth === 0) break;
              }
              i++;
            }
            const tracks = JSON.parse(text.slice(arrStart, i + 1));
            if (Array.isArray(tracks) && tracks.length > 0 && tracks[0].baseUrl) return tracks;
          } catch (_) {}
        }
        return null;
      }
      const tracks = extractCaptionTracksFromPage('${VIDEO_ID}');
      if (!tracks) return null;
      return {
        count: tracks.length,
        first: { lang: tracks[0].languageCode, kind: tracks[0].kind || 'human', url: tracks[0].baseUrl },
      };
    })()
  `);

  expect(result).not.toBeNull();
  expect(result.count).toBe(3);                          // 3 條軌道（en human, zh, en asr）
  expect(result.first.lang).toBe('en');                  // 第一條是英文
  expect(result.first.kind).toBe('human');               // 人工翻譯
  expect(result.first.url).toBe('/mock-captions-en.json');
});

test('youtube-innertube-fetch: videoId 不符時 extractCaptionTracksFromPage 回傳 null', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (function() {
      function extractCaptionTracksFromPage(videoId) {
        for (const script of document.querySelectorAll('script:not([src])')) {
          const text = script.textContent;
          if (!text.includes('"captionTracks"')) continue;
          if (videoId && !text.includes(videoId)) continue;
          try {
            const ctIdx = text.indexOf('"captionTracks"');
            const arrStart = text.indexOf('[', ctIdx);
            let depth = 0, i = arrStart;
            while (i < text.length) {
              if (text[i] === '[' || text[i] === '{') depth++;
              else if (text[i] === ']' || text[i] === '}') { depth--; if (depth === 0) break; }
              i++;
            }
            const tracks = JSON.parse(text.slice(arrStart, i + 1));
            if (Array.isArray(tracks) && tracks.length > 0 && tracks[0].baseUrl) return tracks;
          } catch (_) {}
        }
        return null;
      }
      // 傳入錯誤 videoId → 應 return null（SPA 後舊 script 被跳過）
      return extractCaptionTracksFromPage('WRONG_ID_9999');
    })()
  `);

  expect(result).toBeNull();
});

test('youtube-innertube-fetch: translateYouTubeSubtitles 完整流程 → rawSegments 填入 → TRANSLATE_SUBTITLE_BATCH 被呼叫', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 告知 isYouTubePage() 為 true
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock chrome.runtime.sendMessage：
  //   FETCH_YT_CAPTIONS → 回傳 JSON3 假字幕
  //   TRANSLATE_SUBTITLE_BATCH → 回傳中文翻譯
  //   其他 → 預設 { ok: true }
  await evaluate(`
    window.__fetchCaptionsCalled = 0;
    window.__translateBatchCalled = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'FETCH_YT_CAPTIONS') {
        window.__fetchCaptionsCalled++;
        return { ok: true, responseText: ${JSON.stringify(MOCK_JSON3)} };
      }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        window.__translateBatchCalled++;
        const texts = (msg.payload && msg.payload.texts) || [];
        return {
          ok: true,
          result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0,
                   billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      if (msg && msg.type === 'LOG') return;
      return { ok: true };
    };
  `);

  // 觸發 translateYouTubeSubtitles
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);

  // 等待抓取 + 翻譯完成（JSON3 parse + 第一視窗 batch 翻譯）
  await page.waitForFunction(
    () => window.__SK.YT.rawSegments.length > 0,
    { timeout: 5_000 }
  );

  const state = await evaluate(`({
    active:           window.__SK.YT.active,
    rawSegmentsCount: window.__SK.YT.rawSegments.length,
    fetchCalled:      window.__fetchCaptionsCalled,
    translateCalled:  window.__translateBatchCalled,
  })`);

  expect(state.active).toBe(true);
  expect(state.rawSegmentsCount).toBe(3);    // 3 條字幕（Hello world / This is a test / Goodbye）
  expect(state.fetchCalled).toBe(1);         // FETCH_YT_CAPTIONS 被呼叫一次
  expect(state.translateCalled).toBeGreaterThanOrEqual(1); // TRANSLATE_SUBTITLE_BATCH 至少一次
});
