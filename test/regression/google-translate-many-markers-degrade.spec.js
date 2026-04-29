// Regression: v1.8.13 Google Translate paired marker 過量降級
//
// 根因(以實 fetch translate.googleapis.com 真實資料為基石):
//   Google Translate 非官方端點對同段內「【N】xxx【/N】」配對標記超過 5 對時
//   會 hallucinate,把標記當 list 結構亂吐 garbage tokens。
//   實測閾值:3-5 對 OK、6 對開始壞、7 對亂、8 對完全爛。
//   觸發場景:Medium 作者 byline「socials: YouTube | TikTok | ...」這類大量
//   短 <a> 列表,序列化後 paired marker 數遠超 GMT 死穴。
//
// 修法:serializeForGoogleTranslate 計算 paired-eligible inline 元素數,
//   若 > 5 則降級——同段內 GT_INLINE_TAGS 元素改走「不加 paired 標記、
//   純取文字」路徑,slots 仍可含 atomic(【*N】不會壞)。
//
// 行為斷言(本 fixture 含 8 個 <a>):
//   1. text 不含任何「【N】」/「【/N】」paired 標記
//   2. slots 為空(無 paired,無 atomic)
//   3. 所有 8 個 <a> 的 anchor text 都進 text(內容沒丟)
//
// SANITY 紀錄(已驗證):
//   把 content-serialize.js 的 `const degrade = ...` 改寫死成 `const degrade = false;`
//   → text 內出現 8 對「【0】…【/7】」標記、slotCount=8,本 spec 的「降級後
//   無 paired 標記」斷言 fail。已驗證 → 還原。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'google-translate-many-markers-degrade';
const TARGET_SELECTOR = 'p#target';

test('paired marker 數 > 5 時降級為純文字模式(slots=[],無【N】標記)', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 注入前 sanity:DOM 真的含 8 個 <a>
  const before = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    return { aCount: p.querySelectorAll('a').length };
  })()`);
  expect(before.aCount, '注入前 fixture 應含 8 個 <a>').toBe(8);

  // 直接呼叫 serializeForGoogleTranslate,驗證降級行為
  const result = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const { text, slots } = window.__SK.serializeForGoogleTranslate(p);
    const openMarkers  = (text.match(/【\\d+】/g) || []).length;
    const closeMarkers = (text.match(/【\\/\\d+】/g) || []).length;
    return {
      text,
      slotCount: slots.length,
      openMarkers,
      closeMarkers,
      // 8 個品牌名都應出現在純文字 output 中(內容沒丟)
      hasYouTube:   text.includes('YouTube'),
      hasTikTok:    text.includes('TikTok'),
      hasSubstack:  text.includes('Substack'),
      hasBluesky:   text.includes('Bluesky'),
      hasLinkedIn:  text.includes('LinkedIn'),
      hasThreads:   text.includes('Threads'),
      hasPinterest: text.includes('Pinterest'),
    };
  })()`);

  // 核心斷言:降級後完全無 paired 標記
  expect(
    result.openMarkers,
    `paired【N】開標記應為 0(降級模式)\\ntext: ${result.text.slice(0, 300)}`,
  ).toBe(0);
  expect(
    result.closeMarkers,
    `paired【/N】閉標記應為 0(降級模式)\\ntext: ${result.text.slice(0, 300)}`,
  ).toBe(0);
  expect(
    result.slotCount,
    `slots 應為空(本 fixture 無 atomic 元素)\\ntext: ${result.text.slice(0, 300)}`,
  ).toBe(0);

  // 內容完整性:所有 anchor text 都進純文字 output
  expect(result.hasYouTube).toBe(true);
  expect(result.hasTikTok).toBe(true);
  expect(result.hasSubstack).toBe(true);
  expect(result.hasBluesky).toBe(true);
  expect(result.hasLinkedIn).toBe(true);
  expect(result.hasThreads).toBe(true);
  expect(result.hasPinterest).toBe(true);

  await page.close();
});

test('paired marker 數 ≤ 5 時維持原樣(回歸保護:不要誤殺 v1.4.2 行為)', async ({
  context,
  localServer,
}) => {
  // 直接用前一條 fixture(8 個 <a>),在 page evaluate 內把後 3 個 <a> 移除剩 5 個。
  // 驗證 5 對 paired 標記仍正常產生(GMT 安全閾值內)。
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 移除最後 3 個 <a>,剩 5 個(降級閾值內,應走原 paired 標記路徑)
  await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const links = Array.from(p.querySelectorAll('a'));
    for (let i = links.length - 1; i >= 5; i--) links[i].remove();
  })()`);

  const result = await evaluate(`(() => {
    const p = document.querySelector('${TARGET_SELECTOR}');
    const { text, slots } = window.__SK.serializeForGoogleTranslate(p);
    const openMarkers  = (text.match(/【\\d+】/g) || []).length;
    const closeMarkers = (text.match(/【\\/\\d+】/g) || []).length;
    return {
      slotCount: slots.length,
      openMarkers,
      closeMarkers,
      aCountAfter: p.querySelectorAll('a').length,
    };
  })()`);

  expect(result.aCountAfter, 'sanity:應剩 5 個 <a>').toBe(5);
  // 5 個是 GMT 安全閾值,應該維持 paired 標記模式
  expect(result.slotCount, '5 個 <a> 應產生 5 個 slot').toBe(5);
  expect(result.openMarkers, '5 個 <a> 應產生 5 個【N】開標記').toBe(5);
  expect(result.closeMarkers, '5 個 <a> 應產生 5 個【/N】閉標記').toBe(5);

  await page.close();
});
