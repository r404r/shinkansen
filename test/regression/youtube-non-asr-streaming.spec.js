// Regression: v1.8.9 人工字幕(非 ASR)batch 0 streaming
//
// 鎖五件事:
//   1. batch 0 走 TRANSLATE_SUBTITLE_BATCH_STREAM(不是 TRANSLATE_SUBTITLE_BATCH)
//   2. STREAMING_SEGMENT 抵達時立刻寫 captionMap(逐條注入,不等整批 done)
//   3. STREAMING_FIRST_CHUNK 抵達後 batch 1+ 同步並行 dispatch
//   4. mid-failure(STREAMING_ERROR after first_chunk)→ batch 0 整批 retry via TRANSLATE_SUBTITLE_BATCH
//   5. first_chunk 1.5s timeout → STREAMING_ABORT + fallback 走 non-streaming
//
// SANITY CHECK 紀錄(已驗證,2026-04-28):
//   把 _streamSubtitleEnabled 改成 false → batch 0 走 TRANSLATE_SUBTITLE_BATCH 而非 STREAM,
//   case 1 streamCount=0 fail。還原後 pass。
//   把 SEGMENT 處理拿掉 _injectBatchResult 那行 → captionMap 在 SEGMENT 之後不增,case 2 fail。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

// 共用 mock setup helper
const setupListenerCollector = `
  window.__streamCount = 0;
  window.__abortCount = 0;
  window.__batchPayloadSizes = [];
  window.__batchCallTimes = [];
  window.__startTime = 0;
  window.__streamId = null;

  window.__listeners = [];
  const origAdd = browser.runtime.onMessage.addListener.bind(browser.runtime.onMessage);
  const origRemove = browser.runtime.onMessage.removeListener.bind(browser.runtime.onMessage);
  browser.runtime.onMessage.addListener = (fn) => { window.__listeners.push(fn); return origAdd(fn); };
  browser.runtime.onMessage.removeListener = (fn) => {
    const i = window.__listeners.indexOf(fn);
    if (i >= 0) window.__listeners.splice(i, 1);
    return origRemove(fn);
  };
`;

const fakeRawSegments = (n) => `
  const segs = [];
  for (let i = 0; i < ${n}; i++) {
    segs.push({
      startMs: i * 1000,
      endMs: (i * 1000) + 800,
      text: 'line ' + i,
      normText: 'line ' + i,
      groupId: null,
    });
  }
  window.__SK.YT.rawSegments = segs;
`;

test('youtube-non-asr-streaming (case 1): batch 0 走 STREAM,STREAMING_SEGMENT 立刻寫 captionMap', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupListenerCollector);

  // 17 條 → batch 0=1, batch 1=8, batch 2=8(沿用 streaming-inject fixture 的切批配置)
  // batch 0 走 STREAM,SEGMENT 應 1 條陸續送(這裡只 1 條,測 idx=0 即可)
  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamId = msg.payload.streamId;
        const texts = msg.payload.texts || [];
        // 50ms 後 fire FIRST_CHUNK + 同時 emit batch 0 的 SEGMENT 們
        setTimeout(() => {
          for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          for (let i = 0; i < texts.length; i++) {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_SEGMENT', payload: { streamId: window.__streamId, segmentIdx: i, translation: '[STREAM] ' + texts[i] } });
            }
          }
          // 100ms 後 DONE,讓 batch 1+ 可同步並行
          setTimeout(() => {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_DONE', payload: { streamId: window.__streamId, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 }, totalSegments: texts.length, hadMismatch: false, finishReason: 'STOP' } });
            }
          }, 100);
        }, 50);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') { window.__abortCount += 1; return { ok: true }; }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__batchPayloadSizes.push(texts.length);
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true, result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
  await evaluate(fakeRawSegments(17));
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 80ms:streaming first_chunk(50ms)已 fire + batch 0 segment 已注入,batch 1+ 還在並行中
  await page.waitForTimeout(80);
  const mid = await evaluate(`({
    streamCount: window.__streamCount,
    captionMapSize: window.__SK.YT.captionMap.size,
  })`);
  expect(mid.streamCount, 'batch 0 應走 STREAM(streamCount=1)').toBe(1);
  expect(mid.captionMapSize, '50ms 時 batch 0 streaming 已寫 1 條').toBeGreaterThanOrEqual(1);

  // 全部完成
  await page.waitForTimeout(300);
  const final = await evaluate(`window.__SK.YT.captionMap.size`);
  expect(final, 'batch 0 streaming(1)+ batch 1+(16)合計 17').toBe(17);

  await page.close();
});

test('youtube-non-asr-streaming (case 2): first_chunk 後 batch 1+ 同步並行 dispatch', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupListenerCollector);

  // 用 events log 而非絕對 wallclock 判定:抓「first_chunk 觸發時刻」與「batch 1+ 送出時刻」的相對差
  await evaluate(`
    window.__events = [];
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamId = msg.payload.streamId;
        // 200ms first_chunk,500ms DONE(故意拉開讓 batch 1+ 在 streaming 中並行 dispatch)
        setTimeout(() => {
          window.__events.push({ t: performance.now(), type: 'first_chunk_fired' });
          for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
          setTimeout(() => {
            for (const fn of window.__listeners) {
              fn({ type: 'STREAMING_DONE', payload: { streamId: window.__streamId, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0 }, totalSegments: 1, hadMismatch: false, finishReason: 'STOP' } });
            }
          }, 300);
        }, 200);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') { return { ok: true }; }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const t = performance.now();
        window.__events.push({ t, type: 'batch_sent', size: msg.payload.texts.length });
        await new Promise(r => setTimeout(r, 100));
        const texts = msg.payload.texts || [];
        return {
          ok: true, result: texts.map(t2 => '[ZH] ' + t2),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
  await evaluate(fakeRawSegments(17));
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 等到 first_chunk(200ms)+ batch 1+ 並行(50ms)+ 餘裕 = 600ms
  await page.waitForTimeout(600);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    events: window.__events,
  })`);

  expect(result.streamCount, 'batch 0 走 STREAM 1 次').toBe(1);

  const firstChunkEvent = result.events.find(e => e.type === 'first_chunk_fired');
  const batchEvents = result.events.filter(e => e.type === 'batch_sent');

  expect(firstChunkEvent, 'first_chunk 應該已 fire').toBeTruthy();
  expect(batchEvents.length, '應送 2 筆 BATCH(batch 1 + batch 2)').toBe(2);

  // batch 1+ 必須在 first_chunk 之後送出(streaming 觸發了並行 dispatch)
  for (const be of batchEvents) {
    expect(
      be.t,
      `batch 必須在 first_chunk 之後送出(first_chunk@${firstChunkEvent.t.toFixed(1)},batch@${be.t.toFixed(1)})`,
    ).toBeGreaterThanOrEqual(firstChunkEvent.t);
  }
  // batch 1 / 2 之間差距 < 50ms(同步並行 dispatch)
  const gap = batchEvents[1].t - batchEvents[0].t;
  expect(gap, `batch 1/2 應同步並行(差 < 50ms,實際 ${gap.toFixed(1)}ms)`).toBeLessThan(50);

  await page.close();
});

test('youtube-non-asr-streaming (case 3): mid-failure → batch 0 整批 retry via TRANSLATE_SUBTITLE_BATCH', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupListenerCollector);

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamId = msg.payload.streamId;
        // 50ms FIRST_CHUNK,150ms STREAMING_ERROR(故意中途失敗,觸發 fallback)
        setTimeout(() => {
          for (const fn of window.__listeners) fn({ type: 'STREAMING_FIRST_CHUNK', payload: { streamId: window.__streamId } });
        }, 50);
        setTimeout(() => {
          for (const fn of window.__listeners) {
            fn({ type: 'STREAMING_ERROR', payload: { streamId: window.__streamId, error: 'mid-stream API 5xx' } });
          }
        }, 150);
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') { return { ok: true }; }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__batchPayloadSizes.push(texts.length);
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true, result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
  // 9 條 → batch 0=1, batch 1=8(只一批 1+,簡化)
  await evaluate(fakeRawSegments(9));
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 等 500ms:streaming first_chunk(50ms)+ ERROR(150ms)+ batch 0 retry(1 text)+ batch 1 並行(8 text)
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    payloadSizes: window.__batchPayloadSizes,
  })`);

  expect(result.streamCount, 'batch 0 走 STREAM 1 次').toBe(1);
  expect(
    result.payloadSizes.includes(1),
    `mid-failure 後 batch 0 應整批 retry(1 text),實際 ${JSON.stringify(result.payloadSizes)}`,
  ).toBe(true);
  expect(
    result.payloadSizes.includes(8),
    `batch 1 應已並行 dispatch(8 text),實際 ${JSON.stringify(result.payloadSizes)}`,
  ).toBe(true);

  await page.close();
});

test('youtube-non-asr-streaming (case 4): first_chunk 1.5s timeout → STREAMING_ABORT + fallback', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupListenerCollector);

  // 用 events log 抓「stream sent → abort sent」的相對時間,驗證 abort 在 ~1500ms 後才送(不早不晚)
  await evaluate(`
    window.__streamSentT = null;
    window.__abortSentT = null;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        window.__streamSentT = performance.now();
        // 完全不 fire 任何 STREAMING_* → 觸發 1.5s timeout
        return { ok: true, started: true };
      }
      if (msg && msg.type === 'STREAMING_ABORT') {
        window.__abortCount += 1;
        if (window.__abortSentT === null) window.__abortSentT = performance.now();
        return { ok: true };
      }
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = msg.payload.texts || [];
        window.__batchPayloadSizes.push(texts.length);
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true, result: texts.map(t => '[ZH] ' + t),
          usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, billedInputTokens: 1, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
  await evaluate(fakeRawSegments(9));
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 等 2.2s:涵蓋 1.5s timeout + fallback batch 0/1 的 50ms each + Playwright evaluate 餘裕
  await page.waitForTimeout(2200);

  const result = await evaluate(`({
    streamCount: window.__streamCount,
    abortCount: window.__abortCount,
    streamSentT: window.__streamSentT,
    abortSentT: window.__abortSentT,
    payloadSizes: window.__batchPayloadSizes,
  })`);

  expect(result.streamCount, 'batch 0 走 STREAM 1 次').toBe(1);
  expect(result.abortCount, 'STREAMING_ABORT 應送 1 次').toBe(1);
  expect(result.streamSentT, 'streamSentT 應 truthy').toBeTruthy();
  expect(result.abortSentT, 'abortSentT 應 truthy').toBeTruthy();
  // abort 應該在 stream 送出後 1400-1700ms 之間(timeout=1500ms,容忍 ±200ms 抖動)
  const delta = result.abortSentT - result.streamSentT;
  expect(
    delta,
    `STREAMING_ABORT 應在 stream 送出後 ~1500ms 觸發(實際 ${delta.toFixed(0)}ms)`,
  ).toBeGreaterThan(1400);
  expect(
    delta,
    `STREAMING_ABORT 不該太晚(實際 ${delta.toFixed(0)}ms,預期 < 1700ms)`,
  ).toBeLessThan(1700);
  expect(result.payloadSizes.includes(1), `fallback batch 0(1 text)應被送`).toBe(true);
  expect(result.payloadSizes.includes(8), `fallback batch 1(8 text)應被送`).toBe(true);

  await page.close();
});

test('youtube-non-asr-streaming (case 5): engine=google 不走 streaming', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });
  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);
  await evaluate(setupListenerCollector);

  await evaluate(`
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_STREAM') {
        window.__streamCount += 1;
        return { ok: true, started: true };
      }
      // engine=google 走 TRANSLATE_SUBTITLE_BATCH_GOOGLE
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH_GOOGLE') {
        const texts = (msg.payload && msg.payload.texts) || [];
        window.__batchPayloadSizes.push(texts.length);
        await new Promise(r => setTimeout(r, 50));
        return {
          ok: true, result: texts.map(t => '[GT] ' + t),
          usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, cacheHits: 0 },
        };
      }
      return { ok: true };
    };
  `);
  await evaluate(fakeRawSegments(9));
  // 走 storage.sync mock 注入 engine=google,讓 getYtConfig 真的讀到該值(translateYouTubeSubtitles 會 reset YT.config)
  await evaluate(`
    chrome.storage.sync.get = async function(keys) {
      return { ytSubtitle: { engine: 'google', windowSizeS: 30, onTheFly: false } };
    };
  `);
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  await page.waitForTimeout(500);
  const result = await evaluate(`({
    streamCount: window.__streamCount,
    payloadSizes: window.__batchPayloadSizes,
  })`);

  expect(result.streamCount, 'engine=google 不走 STREAM').toBe(0);
  expect(
    result.payloadSizes.length,
    `engine=google 走 TRANSLATE_SUBTITLE_BATCH_GOOGLE(預期 2 批,實際 ${JSON.stringify(result.payloadSizes)})`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});
