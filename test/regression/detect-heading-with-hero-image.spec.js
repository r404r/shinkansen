// Regression: v1.5.7 mediaCardSkip 排除 H1–H6
//
// Bug（v1.4.20–v1.5.6）：WordPress 主題（如 nippper.com）把 hero 封面圖塞進
// <h1> 內，與 <div><span>標題</span></div> 並列：
//   <h1><img class="wp-post-image"><div><span>標題</span></div></h1>
// 這結構直屬子節點是 [IMG, DIV]，命中 mediaCardSkip 規則
//   （querySelector('img,picture,video') && children.some(CONTAINER_TAG)）
// → 整個 H1 被 FILTER_SKIP，從未進翻譯流程，使用者看到的標題保持日文 / 英文原文。
//
// Fix：mediaCardSkip 條件加 `!/^H[1-6]$/.test(el.tagName)`，HTML5 語意上 heading
// 永遠是「標題」、不會是 grid item / 附件清單卡片。屬結構性通則（CLAUDE.md §8）。
//
// 驗證方法：直接呼叫 collectParagraphs，檢查 H1 有被收為 element unit、
// stats.mediaCardSkip 不再對 H1 命中。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

test('heading-with-hero-image: H1 含 IMG + DIV 子容器仍被偵測為 element unit (v1.5.7)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/heading-with-hero-image.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1.article_ttl', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`(() => {
    const stats = {};
    const units = window.__SK.collectParagraphs(document.body, stats);
    const h1 = document.querySelector('h1.article_ttl');
    const h1Unit = units.find(u => u.kind === 'element' && u.el === h1);
    return {
      stats,
      h1FoundAsUnit: !!h1Unit,
      h1UnitText: h1Unit ? (h1Unit.el.innerText || '').trim().slice(0, 60) : null,
      mediaCardSkip: stats.mediaCardSkip || 0,
      pUnitsFound: units.filter(u => u.el && u.el.tagName === 'P').length,
      allTagsCollected: units.map(u => u.el?.tagName || u.kind).slice(0, 10),
    };
  })()`);

  // 核心斷言：H1 應被收為 element unit
  expect(
    result.h1FoundAsUnit,
    `H1 含 IMG + DIV 子容器仍應被偵測為段落 unit。\n` +
    `實際 stats: ${JSON.stringify(result.stats)}\n` +
    `units: ${JSON.stringify(result.allTagsCollected)}`,
  ).toBe(true);

  // H1 unit 的文字應含原文標題
  expect(result.h1UnitText).toContain('近藤版ギラ');

  // mediaCardSkip 對 H1 不該命中（fixture 沒有其他 media card 元素，所以應為 0）
  expect(
    result.mediaCardSkip,
    `mediaCardSkip 不該命中 heading；實際 ${result.mediaCardSkip}\n` +
    `stats=${JSON.stringify(result.stats)}`,
  ).toBe(0);

  // sanity：兩個 <p> body 段落也都被收
  expect(result.pUnitsFound).toBe(2);

  await page.close();
});

test('heading-with-hero-image: 注入譯文後 hero IMG 仍保留 (v1.5.7)', async ({
  context, localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/heading-with-hero-image.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1.article_ttl img', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`(() => {
    const h1 = document.querySelector('h1.article_ttl');
    const before = {
      imgCount: h1.querySelectorAll('img').length,
      imgSrc: h1.querySelector('img')?.src || null,
      textPreview: h1.innerText.trim().slice(0, 30),
    };
    // 直接走 testInject 模擬注入流程（純文字譯文，與 path B replaceTextInPlace 同路徑）
    window.__shinkansen.testInject(h1, '被近藤版基拉．多迦的迷彩塗裝瞬間擊中，買下田宮 Panther G 的那天');
    const after = {
      imgCount: h1.querySelectorAll('img').length,
      imgSrc: h1.querySelector('img')?.src || null,
      textPreview: h1.innerText.trim().slice(0, 50),
      innerHTMLPreview: h1.innerHTML.replace(/\\s+/g, ' ').slice(0, 200),
    };
    return { before, after };
  })()`);

  // 注入前 sanity
  expect(result.before.imgCount).toBe(1);
  expect(result.before.imgSrc).toContain('cover.jpg');

  // 核心斷言：注入後 IMG 仍在
  expect(
    result.after.imgCount,
    `注入後 H1 內 <img> 應保留。innerHTML: ${result.after.innerHTMLPreview}`,
  ).toBe(1);
  expect(result.after.imgSrc).toContain('cover.jpg');

  // 譯文有寫入（最長文字節點被替換）
  expect(result.after.textPreview).toContain('近藤版基拉');

  await page.close();
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/content-detect.js 第 273 行 mediaCardSkip 條件中的
//     `!/^H[1-6]$/.test(el.tagName) &&`
//   這行刪除（還原成 v1.5.6 行為）→ h1FoundAsUnit=false / mediaCardSkip=1，
//   兩條核心斷言 fail。還原後全 pass。
