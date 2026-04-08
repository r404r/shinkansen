// Edo 偵測測試
//
// 目的：用 Shinkansen 的段落偵測邏輯掃 Wikipedia 的「Edo」條目，
// dump 一份結構化 JSON 報告到 test/reports/，方便後續分析
// 段落偵測抓到/漏抓/誤抓哪些東西。
//
// 注意：這份測試「不」實際呼叫 Gemini 翻譯，只跑偵測。
import { test, expect } from './fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EDO_URL = 'https://en.wikipedia.org/wiki/Edo';
const PROBE_PATH = path.resolve(__dirname, 'probe/detector-probe.js');
const REPORTS_DIR = path.resolve(__dirname, 'reports');

test('Wikipedia Edo 段落偵測', async ({ context }) => {
  // 確保 reports 資料夾存在
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const page = await context.newPage();
  await page.goto(EDO_URL, { waitUntil: 'domcontentloaded' });
  // Wikipedia 主內容載入後再等一下，讓 lazy 圖片與隱藏選單就位
  await page.waitForSelector('#mw-content-text', { timeout: 30_000 });
  await page.waitForTimeout(1000);

  // 注入 probe 腳本（在頁面 main world 內執行）
  const probeSource = fs.readFileSync(PROBE_PATH, 'utf8');
  await page.addScriptTag({ content: probeSource });

  // 跑 probe
  const report = await page.evaluate(() => window.__shinkansenProbe.run());

  // 基本驗證：至少要偵測到一些段落，否則表示 probe 出狀況
  expect(report.counts.total).toBeGreaterThan(10);

  // 寫檔
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(REPORTS_DIR, `edo-detection-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  // 在 test log 印摘要，方便 npm test 直接看
  console.log('\n──── Edo 偵測摘要 ────');
  console.log('URL          :', report.url);
  console.log('翻譯單位總數 :', report.counts.total);
  console.log('  TreeWalker :', report.counts.fromTreeWalker);
  console.log('  Selector補抓:', report.counts.fromIncludeBySelector);
  console.log('被跳過統計   :', JSON.stringify(report.skipped));
  console.log('耗時 (ms)    :', report.elapsedMs);
  console.log('報告寫入     :', path.relative(process.cwd(), outPath));
  console.log('────────────────────\n');

  await page.close();
});
