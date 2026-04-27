// Regression: v1.6.19 — translateWindowFrom 的後續批次用 allSettled,單一批失敗不拖累其他
//
// 修法位置:shinkansen/content-youtube.js translateWindowFrom() 內
//   舊: await Promise.all(batches.slice(1).map(...))
//   新: await Promise.allSettled(batches.slice(1).map(...))
//
// 觸發場景:Gemini API 對某一批回 rate limit / network error → reject。
// 舊版 Promise.all 一個 reject 整個拒絕,外層 catch 跳過 `YT.batchApiMs = _batchApiMs`,
// 後續視窗追趕邏輯也被跳。雖然成功批次的 captionMap.set 在 _runBatch 的 .then 內
// 已經自己寫過,但若 batch 1 失敗、batch 2 還在跑 → batch 2 結束時 .then 仍會寫
// captionMap,可是外層 `YT.batchApiMs = _batchApiMs` 那行始終跳過 → debug 面板某些
// batch 顯示「…」永遠不變;且後續視窗對齊邏輯被跳過。
//
// 結構通則 / 測法:
//   - 17 rawSegments → 3 批 [1, 8, 8]
//   - Mock sendMessage:batch 0 成功、batch 1 reject、batch 2 成功
//   - 等所有批次都 settle 後檢查:
//       (a) batch 0 + batch 2 的 captionMap entries 都應寫進(總數 = 1 + 8 = 9)
//       (b) YT.batchApiMs[2] 應 > 0(batch 2 的耗時有同步出去)
//
// SANITY 紀錄(已驗證,2026-04-27 Claude Code 端):
//   把 translateWindowFrom 的 Promise.allSettled 改回 Promise.all 後,
//   batch 1 reject 立刻讓 await 拋 → outer catch 接住 → YT.batchApiMs 賦值跳過 →
//   YT.batchApiMs[2] 仍為 0,測試 fail。還原後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'youtube-streaming-inject';

test('youtube-batch-allsettled: 後續批次某批 reject 不應拖累其他批的 captionMap 與 batchApiMs', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  await evaluate(`window.__SK.isYouTubePage = () => true`);

  // Mock:batch 0 (seq=0) 成功、batch 1 (seq=1) reject、batch 2 (seq=2) 成功
  await evaluate(`
    window.__batchCallSeq = 0;
    chrome.runtime.sendMessage = async function(msg) {
      if (msg && msg.type === 'TRANSLATE_SUBTITLE_BATCH') {
        const texts = (msg.payload && msg.payload.texts) || [];
        const seq = window.__batchCallSeq++;
        await new Promise(r => setTimeout(r, 30));
        if (seq === 1) {
          throw new Error('mock batch 1 fail');
        }
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

  // 17 條 rawSegments → 切成 3 批 [1, 8, 8]
  await evaluate(`
    const segs = [];
    for (let i = 0; i < 17; i++) {
      segs.push({
        startMs: i * 1000,
        endMs: (i * 1000) + 800,
        text: 'line ' + i,
        normText: 'line ' + i,
        groupId: null,
      });
    }
    window.__SK.YT.rawSegments = segs;
  `);

  // 等 translateYouTubeSubtitles 整段跑完(含 await Promise.allSettled)
  await evaluate(`window.__SK.translateYouTubeSubtitles();`);

  // 等所有批次 settle:30ms × 3 + buffer
  await page.waitForTimeout(500);

  const result = await evaluate(`({
    captionMapSize: window.__SK.YT.captionMap.size,
    batchCalls: window.__batchCallSeq,
    batchApiMs: Array.from(window.__SK.YT.batchApiMs || []),
  })`);

  // batch 0 (1 條) + batch 2 (8 條) = 9 條應有 captionMap entries
  expect(
    result.captionMapSize,
    `成功的 batch 0+2 共 9 條應寫入 captionMap(實際:${result.captionMapSize})。若 < 9 代表 batch 2 也被 batch 1 reject 拖累。`,
  ).toBeGreaterThanOrEqual(9);

  // batch 2 耗時應已同步至 YT.batchApiMs(若用舊版 Promise.all,reject 直接讓 try 中段,
  // YT.batchApiMs = _batchApiMs 那行會被跳,batchApiMs[2] 仍為 0)
  expect(
    result.batchApiMs[2],
    `batch 2 耗時應同步至 YT.batchApiMs(allSettled 行為);實際:${JSON.stringify(result.batchApiMs)}`,
  ).toBeGreaterThan(0);

  // 三批都應有 sendMessage 被呼叫過
  expect(result.batchCalls, `三批 sendMessage 都應被呼叫(實際:${result.batchCalls})`).toBe(3);

  await page.close();
});
