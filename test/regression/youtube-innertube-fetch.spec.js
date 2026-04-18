// Regression: v1.3.12 YouTube 字幕 XHR 攔截架構
// 根本問題（v1.3.9–v1.3.11 的教訓）：
//   YouTube /api/timedtext URL 含 exp=xpv 旗標，所有主動 fetch（包含 MAIN world same-origin）
//   都回傳 HTTP 200 但 body 為空。唯一正確解法：等播放器自己帶 POT 發出 XHR，攔截 response。
//
// 驗證三項核心行為：
//   (1) captionTracks 解析邏輯：從頁面 <script> 標籤解析 captionTracks（fixture 資料驗證）
//       注意：v1.3.13 起 extractCaptionTracksFromPage() 已從 extension 移除（不再需要），
//       本測試在 test 內自定義相同邏輯以驗證 fixture HTML 的資料格式仍正確。
//   (2) videoId 不符時解析應回傳 null（fixture 邊界條件驗證）
//   (3) translateYouTubeSubtitles 完整流程（v1.3.12）：
//         shinkansen-yt-captions CustomEvent（模擬 content-youtube-main.js 的 XHR 攔截結果）
//         → rawSegments 填入 → startCaptionObserver → translateWindowFrom →
//         TRANSLATE_SUBTITLE_BATCH 被呼叫
//
// 觸發條件（結構通則）：
//   - 頁面發出 shinkansen-yt-captions CustomEvent（模擬 MAIN world monkey-patch 攔截到的 XHR response）
//   - event.detail.responseText 為非空 JSON3 格式字幕資料
//   - YT.active 在事件到來時為 true
//
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

test('youtube-innertube-fetch: translateYouTubeSubtitles 完整流程（v1.3.12）→ shinkansen-yt-captions 事件 → rawSegments 填入 → 翻譯觸發', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ytp-caption-window-container', { timeout: 10_000, state: 'attached' });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 告知 isYouTubePage() 為 true
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock chrome.runtime.sendMessage（v1.3.12 流程）：
  //   FETCH_YT_CAPTIONS 不再被呼叫（已移除）
  //   TRANSLATE_SUBTITLE_BATCH → 回傳中文翻譯
  await evaluate(`
    window.__fetchCaptionsCalled = 0;
    window.__translateBatchCalled = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'FETCH_YT_CAPTIONS') {
        // 不應該被呼叫（v1.3.12 已移除 FETCH_YT_CAPTIONS 路徑）
        window.__fetchCaptionsCalled++;
        return { ok: false, error: 'FETCH_YT_CAPTIONS should not be called in v1.3.12' };
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

  // 觸發 translateYouTubeSubtitles（進入「等待字幕資料」狀態）
  await evaluate(`window.__SK.translateYouTubeSubtitles()`);

  // 模擬 content-youtube-main.js 攔截到 YouTube 播放器的 XHR response：
  // 發出 shinkansen-yt-captions CustomEvent（與 MAIN world monkey-patch 相同的協定）
  await evaluate(`
    window.dispatchEvent(new CustomEvent('shinkansen-yt-captions', {
      detail: { url: 'https://www.youtube.com/api/timedtext?v=${VIDEO_ID}', responseText: ${JSON.stringify(MOCK_JSON3)} }
    }));
  `);

  // 等待 rawSegments 填入（由 shinkansen-yt-captions handler 完成）
  // 注意：必須在 isolated world 輪詢——window.__SK 是 content script 的物件，
  // page.waitForFunction 跑在 main world 看不到，會丟 "Cannot read properties of undefined (reading 'YT')"。
  const pollStart = Date.now();
  while (Date.now() - pollStart < 5_000) {
    const count = await evaluate(`window.__SK.YT.rawSegments.length`);
    if (count > 0) break;
    await page.waitForTimeout(50);
  }

  const state = await evaluate(`({
    active:             window.__SK.YT.active,
    rawSegmentsCount:   window.__SK.YT.rawSegments.length,
    fetchCaptionsCalled: window.__fetchCaptionsCalled,
    translateCalled:    window.__translateBatchCalled,
  })`);

  expect(state.active).toBe(true);
  expect(state.rawSegmentsCount).toBe(3);           // 3 條字幕（Hello world / This is a test / Goodbye）
  expect(state.fetchCaptionsCalled).toBe(0);         // v1.3.12：FETCH_YT_CAPTIONS 不再被呼叫
  expect(state.translateCalled).toBeGreaterThanOrEqual(1); // TRANSLATE_SUBTITLE_BATCH 至少一次
});
