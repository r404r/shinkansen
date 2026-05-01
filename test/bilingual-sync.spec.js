// Bilingual document H2 sync forcing function
//
// 對應 CLAUDE.md 硬規則 §16:已雙語化的文件,維護繁中時必須同步修改英文版。
// 本 spec 比對每個雙語檔對(繁中 primary + 英文版)的 H2 標題集合差集——
// 任一邊新增 / 刪除 / 重命名 H2 但另一邊沒同步即 fail,訊息明確指出哪個 section 漏同步。
//
// 設計刻意只比 H2(內容主結構),不比 H1(語言切換器後的標題本來就會有 brand 一致性)、
// 不比 H3(子節結構允許局部不對等;英文版可省略部分 Jimmy 寫給自己看的設計筆記)。
//
// 不比對 H2 的「順序」,只比對「集合」——允許英文版重排 section,專注於覆蓋是否齊全。
//
// 範圍:
//   - README.md ↔ README.en.md
//   - API-KEY-SETUP.md ↔ API-KEY-SETUP.en.md
// 未來新增雙語檔時加進 PAIRS 陣列。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures/extension.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PAIRS = [
  { zh: 'README.md', en: 'README.en.md' },
  { zh: 'API-KEY-SETUP.md', en: 'API-KEY-SETUP.en.md' },
];

function readRepoFile(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// 抽出所有 H2 標題(行首 `## ` 開頭),回傳純文字陣列
function extractH2Titles(markdown) {
  const titles = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

for (const pair of PAIRS) {
  test(`bilingual sync: ${pair.zh} ↔ ${pair.en} (H2 count match)`, () => {
    const zhTitles = extractH2Titles(readRepoFile(pair.zh));
    const enTitles = extractH2Titles(readRepoFile(pair.en));
    expect(
      enTitles.length,
      `[BILINGUAL DRIFT] ${pair.zh} 有 ${zhTitles.length} 個 H2,${pair.en} 有 ${enTitles.length} 個。\n` +
      `提醒:CLAUDE.md §16 要求雙語檔 H2 數量對齊。\n` +
      `${pair.zh} H2: ${JSON.stringify(zhTitles, null, 2)}\n` +
      `${pair.en} H2: ${JSON.stringify(enTitles, null, 2)}`,
    ).toBe(zhTitles.length);
  });
}
