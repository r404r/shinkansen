// Edo 偵測測試（v0.29 改版）
//
// 目的：用 Shinkansen 真實的段落偵測邏輯（content.js 內的 collectParagraphs）
// 掃 Wikipedia 的「Edo」條目，dump 一份結構化 JSON 報告。
//
// 與前一版（v0.28 detector-probe 鏡像）的差異：
//   v0.28：注入 detector-probe.js 到 main world，跑「鏡像版」collectParagraphs
//          —— 風險是 content.js 改了之後 probe 會 drift。
//   v0.29：透過 CDP 在 content script isolated world 直接呼叫真實
//          window.__shinkansen.collectParagraphs()，不再有鏡像，無 drift 風險。
//
// 為什麼非 CDP 不可（重要技術筆記）：
//   - Playwright 的 page.evaluate(fn) 一律跑在頁面的 main world，看不到
//     content script isolated world 的 window.__shinkansen。
//   - Playwright 沒有原生公開的「指定 isolated world」API。
//     （Puppeteer 有 ExecutionContext 可選；Playwright 沒有對應公開 API。）
//   - 唯一穩定可行的路：透過 Chrome DevTools Protocol 監聽
//     Runtime.executionContextCreated 事件，撈到 Shinkansen 對應的
//     isolated world contextId，然後用 Runtime.evaluate 指定 contextId 跑。
//
// 也不會將 debug API 注入 main world：SPEC §16.5 設計原則 4 明確要求
// debug API 留在 isolated world，不污染 page 全域。
//
// 注意：這份測試「不」實際呼叫 Gemini 翻譯，只跑偵測。
import { test, expect } from './fixtures/extension.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EDO_URL = 'https://en.wikipedia.org/wiki/Edo';
const REPORTS_DIR = path.resolve(__dirname, 'reports');

/**
 * 取得指定 page 上 Shinkansen content script 的 isolated world execution
 * context ID，並回傳一個可重複呼叫的 evaluator。
 *
 * 實作細節：
 *   1. 對 page 開一個新的 CDP session
 *   2. 監聽 Runtime.executionContextCreated（要在 Runtime.enable 之前掛，
 *      避免漏掉早於 enable 的事件 —— enable 本身會 replay 現存 contexts）
 *   3. Runtime.enable 讓現有 contexts 全部 replay 出來
 *   4. 從候選裡找 auxData.type === 'isolated' 且 name === 'Shinkansen'
 *      的 context（name 來自 extension manifest 的 name 欄位）
 *   5. 萬一找不到，把所有 isolated world 候選印出來方便診斷
 */
async function getShinkansenEvaluator(page) {
  const cdp = await page.context().newCDPSession(page);

  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (event) => {
    contexts.push(event.context);
  });
  cdp.on('Runtime.executionContextDestroyed', (event) => {
    const idx = contexts.findIndex((c) => c.id === event.executionContextId);
    if (idx >= 0) contexts.splice(idx, 1);
  });

  await cdp.send('Runtime.enable');

  // content script 走 document_idle，給它一點時間就位
  // （call site 也已經 waitForSelector + waitForTimeout，這裡是雙保險）
  await page.waitForTimeout(500);

  const isolated = contexts.filter((c) => c?.auxData?.type === 'isolated');
  let shinkansen = isolated.find((c) => c.name === 'Shinkansen');

  if (!shinkansen) {
    // 第二層 fallback：name 不嚴格相等，含 'Shinkansen' 子字串也算
    shinkansen = isolated.find((c) => /Shinkansen/i.test(c.name || ''));
  }

  if (!shinkansen) {
    const dump = isolated.map((c) => ({
      id: c.id,
      name: c.name,
      origin: c.origin,
      auxData: c.auxData,
    }));
    throw new Error(
      `找不到 Shinkansen 的 isolated world execution context。` +
      `\n候選 isolated worlds：${JSON.stringify(dump, null, 2)}`,
    );
  }

  /**
   * 在 Shinkansen isolated world 內 evaluate 一段表達式，回傳 plain JS value。
   * 用 returnByValue: true 跨 boundary 序列化。
   */
  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      contextId: shinkansen.id,
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Runtime.evaluate 失敗：${result.exceptionDetails.text}` +
        `\nexpression: ${expression}`,
      );
    }
    return result.result.value;
  }

  return { cdp, contextId: shinkansen.id, contextName: shinkansen.name, evaluate };
}

test('Wikipedia Edo 段落偵測（透過 window.__shinkansen debug API）', async ({ context }) => {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const page = await context.newPage();
  await page.goto(EDO_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#mw-content-text', { timeout: 30_000 });
  await page.waitForTimeout(1000);

  const { evaluate, contextId, contextName } = await getShinkansenEvaluator(page);
  console.log(`[CDP] Shinkansen isolated world: name="${contextName}", contextId=${contextId}`);

  // ── 1. 版本 drift assertion ──────────────────────────────
  // 每次 shinkansen bump 版本號時，必須同步更新這個常數。
  // 這是一個 forcing function，刻意設計成 bump 後不改就 fail，
  // 用來提醒測試期望值需要跟著更新。
  const EXPECTED_VERSION = '0.55';
  const apiVersion = await evaluate('window.__shinkansen.version');
  if (apiVersion !== EXPECTED_VERSION) {
    throw new Error(
      `[DRIFT] window.__shinkansen.version (${apiVersion}) ≠ EXPECTED_VERSION (${EXPECTED_VERSION})`,
    );
  }

  // ── 2. 真實偵測結果（v0.30：含 walker 跳過統計） ─────────
  const t0 = Date.now();
  const raw = await evaluate('JSON.stringify(window.__shinkansen.collectParagraphsWithStats())');
  const elapsedMs = Date.now() - t0;
  const { units, skipStats } = JSON.parse(raw);

  expect(units.length).toBeGreaterThan(10);
  expect(skipStats).toBeTruthy();

  // 行為鎖定：ambox 家族（Wikipedia 維護模板）從 v0.31 起必須被視為
  // 可翻譯單位，不可再走 selector 排除。若未來有人重新加回內容性的
  // EXCLUDE_BY_SELECTOR 或類似邏輯，本斷言會 fail。
  // 對應硬規則：CLAUDE.md §6「翻譯範圍由 system prompt 決定，不由 selector 決定」
  const amboxUnits = units.filter((u) =>
    /\.ambox|\.box-AI-generated|\.box-More_footnotes_needed/.test(u.selectorPath || ''),
  );
  expect(amboxUnits.length).toBeGreaterThan(0);

  // 額外抓 state 留紀錄
  const state = await evaluate('JSON.stringify(window.__shinkansen.getState())');

  // ── 3. 統計 ──────────────────────────────────────────────
  const tagCounts = {};
  for (const u of units) tagCounts[u.tag] = (tagCounts[u.tag] || 0) + 1;
  const withMedia = units.filter((u) => u.hasMedia).length;

  // ── 4. 寫報告 ────────────────────────────────────────────
  const report = {
    source: 'window.__shinkansen.collectParagraphsWithStats (real content.js)',
    extensionVersion: apiVersion,
    url: page.url(),
    title: await page.title(),
    timestamp: new Date().toISOString(),
    elapsedMs,
    counts: {
      total: units.length,
      withMedia,
      tagDistribution: tagCounts,
    },
    skipStats,
    state: JSON.parse(state),
    units,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(REPORTS_DIR, `edo-detection-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  // ── 5. log 摘要 ──────────────────────────────────────────
  console.log('\n──── Edo 偵測摘要（真實 content.js） ────');
  console.log('Extension 版本 :', apiVersion);
  console.log('URL            :', report.url);
  console.log('翻譯單位總數   :', units.length);
  console.log('Tag 分佈       :', JSON.stringify(tagCounts));
  console.log('含媒體單位     :', withMedia);
  console.log('被跳過統計     :', JSON.stringify(skipStats));
  console.log('耗時 (ms)      :', elapsedMs);
  console.log('報告寫入       :', path.relative(process.cwd(), outPath));
  console.log('──────────────────────────────────────────\n');

  await page.close();
});
