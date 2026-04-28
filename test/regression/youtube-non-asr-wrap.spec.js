// Regression: v1.8.9 非 ASR 字幕長譯文也要走 _wrapTargetText 切點 + <br>
//
// 背景:ASR 路徑(_setOverlayContent)早就有依長度切點 + <br> 的邏輯,
// 但非 ASR 路徑(replaceSegmentEl + flushOnTheFly)直接 el.textContent = trans,
// 加上 expandCaptionLine 又給 segment 設 white-space: nowrap,
// 中文譯文比英文長 1.3-1.8 倍時整句沖出 video 寬。
//
// 修法:抽 _setSegmentText helper,過長譯文用 _wrapTargetText 計切點後
// innerHTML + <br> 注入;短譯文走 textContent 維持原 fast path。
//
// 驗證(三個 case):
//   1. 直接呼叫 SK._setSegmentText 灌長中文 → innerHTML 含 <br>、textContent 拼接無 \n
//   2. 短中文(< maxLine)→ textContent 路徑,innerHTML 不含 <br>
//   3. e2e 走 replaceSegmentEl(captionMap 預先放長譯文)→ innerHTML 含 <br>
//
// SANITY CHECK:把 _setSegmentText 改回 `el.textContent = str`(直接覆蓋整段函式)
// → case 1 / case 3 fail(innerHTML 無 <br>、textContent 仍是長串無 wrap)、case 2 仍 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-non-asr-wrap';

// 故意設超過 _calcMaxLineChars clamp 上限(35)的長度,
// 不論 video offsetWidth / fontSize 怎麼浮動都會觸發 wrap
const LONG_ZH = '這是一段刻意做得很長的中文譯文,包含逗號跟句號可以當切點,' +
                '希望可以驗證 wrap 邏輯確實會把它切成多行而不是一整串沖出畫面。';

const SHORT_ZH = '這是短譯文。';

test('youtube-non-asr-wrap (case 1): _setSegmentText 對過長譯文走 innerHTML + <br>', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const container = document.querySelector('.ytp-caption-window-container');
    const span = document.createElement('span');
    span.className = 'ytp-caption-segment';
    span.id = 'long-seg';
    span.textContent = 'placeholder';
    container.appendChild(span);
    window.__SK._setSegmentText(span, ${JSON.stringify(LONG_ZH)});
  `);

  const result = await evaluate(`({
    innerHTML: document.getElementById('long-seg').innerHTML,
    textContent: document.getElementById('long-seg').textContent,
    brCount: document.getElementById('long-seg').querySelectorAll('br').length,
  })`);

  expect(result.brCount, '長譯文應拆出至少 1 個 <br>').toBeGreaterThanOrEqual(1);
  expect(result.innerHTML, 'innerHTML 應含 <br> 標籤').toContain('<br>');
  expect(result.textContent.indexOf('\n'), 'textContent 不應殘留字面 \\n').toBe(-1);
  // 移除 <br> 後文字應跟原譯文等長(<br> 不是字元,textContent 自動拼回)
  expect(result.textContent.length, 'textContent 應跟原譯文等長(<br> 不算字元)').toBe(LONG_ZH.length);

  await page.close();
});

test('youtube-non-asr-wrap (case 2): _setSegmentText 對短譯文走 textContent fast path', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`
    const container = document.querySelector('.ytp-caption-window-container');
    const span = document.createElement('span');
    span.className = 'ytp-caption-segment';
    span.id = 'short-seg';
    span.textContent = 'hello';
    container.appendChild(span);
    window.__SK._setSegmentText(span, ${JSON.stringify(SHORT_ZH)});
  `);

  const result = await evaluate(`({
    innerHTML: document.getElementById('short-seg').innerHTML,
    textContent: document.getElementById('short-seg').textContent,
    brCount: document.getElementById('short-seg').querySelectorAll('br').length,
  })`);

  expect(result.brCount, '短譯文不應有 <br>').toBe(0);
  expect(result.innerHTML.includes('<br>'), 'innerHTML 不應含 <br>').toBe(false);
  expect(result.textContent, '短譯文 textContent 應等於原譯文').toBe(SHORT_ZH);

  await page.close();
});

test('youtube-non-asr-wrap (case 3): replaceSegmentEl 命中快取時走 wrap 路徑', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 讓內部 isYouTubePage guard 通過
  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // 模擬 translateYouTubeSubtitles 已啟動的狀態(不真的發請求,只設旗標)
  await evaluate(`
    window.__SK.YT.active = true;
    window.__SK.YT.captionMap.set('long english source', ${JSON.stringify(LONG_ZH)});
  `);

  // 建一個 .ytp-caption-segment,textContent = 對應快取 key 的英文,呼叫 replaceSegmentEl
  await evaluate(`
    const container = document.querySelector('.ytp-caption-window-container');
    const span = document.createElement('span');
    span.className = 'ytp-caption-segment';
    span.id = 'cached-seg';
    span.textContent = 'long english source';
    container.appendChild(span);
    window.__SK._replaceSegmentEl(span);
  `);

  const result = await evaluate(`({
    innerHTML: document.getElementById('cached-seg').innerHTML,
    textContent: document.getElementById('cached-seg').textContent,
    brCount: document.getElementById('cached-seg').querySelectorAll('br').length,
  })`);

  expect(result.brCount, 'replaceSegmentEl 命中快取後長譯文應拆出 <br>').toBeGreaterThanOrEqual(1);
  expect(result.innerHTML, 'innerHTML 應含 <br>').toContain('<br>');
  expect(result.textContent.length, 'textContent 應跟原譯文等長').toBe(LONG_ZH.length);

  await page.close();
});
