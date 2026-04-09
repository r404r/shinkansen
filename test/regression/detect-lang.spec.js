// Regression: lang-detect (對應 v0.76 自動語言偵測 — 繁體中文跳過、簡體照翻)
//
// Fixture: test/regression/fixtures/lang-detect.html
// 結構: 多個 <p>，分別是繁體中文、簡體中文、英文、中英混合、純數字、日文、
//       含年份數字的繁體中文、含繁簡共用字「准」的繁體中文
//
// 結構通則 (不綁站名):
//   - CJK 字元佔「字母字元」(剝除數字/標點後) > 50% 且無簡體特徵字 → 繁體中文 → 跳過
//   - CJK 字元佔多數但含簡體特徵字 → 簡體中文 → 收為候選（送 Gemini 轉繁體）
//   - CJK 佔比 < 50% 且含字母 → 外文 → 收為候選
//   - 無任何字母或 CJK → 跳過（純數字/符號）
//   - 數字/標點不參與比例計算，避免「清領時期 (1683-1895)」被誤判
//   - 繁簡共用字（准、几、干、里）不在特徵字集中，避免繁體被誤判為簡體

// <!-- SANITY-PENDING: 將 isTraditionalChinese 的 CJK 門檻從 0.5 改成 0.0，
//      應導致繁體段落也被收進來，斷言 1、5、8、9 會 fail -->

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'lang-detect';

test('lang-detect: 繁體中文段落被跳過、簡體中文與外文被收為候選', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div#target', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphs())
  `);
  const units = JSON.parse(result);

  // 收集所有被偵測到的段落的 id
  const collectedIds = units
    .filter((u) => u.id)
    .map((u) => u.id);

  // 斷言 1: 繁體中文段落不在候選中
  expect(
    collectedIds,
    '繁體中文段落 #trad-chinese 應被跳過',
  ).not.toContain('trad-chinese');

  // 斷言 2: 簡體中文段落在候選中（需要翻譯成繁體）
  expect(
    collectedIds,
    '簡體中文段落 #simplified-chinese 應被收為候選',
  ).toContain('simplified-chinese');

  // 斷言 3: 英文段落在候選中
  expect(
    collectedIds,
    '英文段落 #english 應被收為候選',
  ).toContain('english');

  // 斷言 4: 中英混合（英文為主）在候選中
  expect(
    collectedIds,
    '英文為主的混合段落 #mixed-en-dominant 應被收為候選',
  ).toContain('mixed-en-dominant');

  // 斷言 5: 繁體中文為主（夾少量英文）應被跳過
  expect(
    collectedIds,
    '繁體中文為主的混合段落 #mixed-zh-dominant 應被跳過',
  ).not.toContain('mixed-zh-dominant');

  // 斷言 6: 純數字不在候選中
  expect(
    collectedIds,
    '純數字段落 #pure-numbers 應被跳過',
  ).not.toContain('pure-numbers');

  // 斷言 7: 日文段落在候選中（日文含平假名/片假名，CJK 佔比可能 >50%
  // 但平假名不在 CJK Unified Ideographs 範圍內，所以 CJK 漢字佔比會 <50%，
  // 即使佔比 >50%，日文漢字多與繁體相同但會夾雜假名，不會被誤判為繁體中文）
  expect(
    collectedIds,
    '日文段落 #japanese 應被收為候選',
  ).toContain('japanese');

  // 斷言 8: 繁體中文夾年份數字應被跳過（數字不參與比例計算）
  expect(
    collectedIds,
    '含年份數字的繁體段落 #trad-with-dates 應被跳過',
  ).not.toContain('trad-with-dates');

  // 斷言 9: 含繁簡共用字「准」的繁體段落應被跳過（准不在簡體特徵字集中）
  expect(
    collectedIds,
    '含「核准/批准」的繁體段落 #trad-with-zhun 應被跳過',
  ).not.toContain('trad-with-zhun');

  await page.close();
});
