// Version drift forcing function (從 edo-detection.spec.js 搬過來,v0.59 起)
//
// 對應 CLAUDE.md 硬規則 1 第 4 點:每次 manifest version bump 都必須同步
// 更新本檔的 EXPECTED_VERSION 常數。這條測試的「fail」就是 forcing function——
// 刻意設計成 bump 後不改就 fail,用來提醒測試期望值需要跟著更新。
//
// 為什麼不直接動態讀 manifest:那樣 forcing function 就失效了。我們要的
// 就是「測試 expectations 必須有人手動點頭」的這個摩擦。
//
// 為什麼從 edo-detection.spec.js 搬出來:v0.59 起 regression suite 取代了
// edo-detection 的「真實 collectParagraphs 跑一次看看」用途,但 forcing
// function 還是需要一個家。獨立成單一檔最簡單,也最容易被新人看懂。
import { test, expect } from './fixtures/extension.js';
import { getShinkansenEvaluator } from './regression/helpers/run-inject.js';

const EXPECTED_VERSION = '1.4.13';

// 任意一個 regression fixture 就行,只是為了讓 content script load 進來、
// 拿到 isolated world。本測試本身不依賴頁面內容。
test('manifest version drift check', async ({ context, localServer }) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/br-paragraph.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const apiVersion = await evaluate('window.__shinkansen.version');
  expect(
    apiVersion,
    `[DRIFT] window.__shinkansen.version (${apiVersion}) ≠ EXPECTED_VERSION (${EXPECTED_VERSION})\n` +
    `提醒:每次 bump manifest version 時必須同步更新 test/version-check.spec.js 的 EXPECTED_VERSION 常數。`,
  ).toBe(EXPECTED_VERSION);

  await page.close();
});
