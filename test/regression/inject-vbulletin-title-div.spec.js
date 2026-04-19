// Regression: vbulletin-title-div（對應 v1.4.14 修的「vBulletin td.alt1 翻譯後標題 div 消失」bug）
//
// Fixture: test/regression/fixtures/vbulletin-title-div.html
// 結構: <td id="td_post_test">
//         <div class="smallfont hideonmobile"><strong>標題</strong></div>
//         <hr>
//         <div class="postbitcontrol2">內文 ... <img class="inlineimg"></div>
//       </td>
//
// Bug 根因（v1.4.13 以前）:
//   第一段：collectParagraphs walker 碰到 <td>，containsBlockDescendant(td) = false
//           （DIV 不在 BLOCK_TAGS_SET），→ td 通過所有檢查 → FILTER_ACCEPT →
//           整個 td（標題 + 內文混在一起）被當成一個翻譯單元。
//   第二段：injectIntoTarget(td, frag) 偵測到 td 內有 <img>，走 media-preserving path。
//           empty-parent cleanup 把 smallfont 移除（STRONG text 清空 → STRONG 移除 →
//           smallfont 沒 media → smallfont 移除）。譯文掉到 postbitcontrol2 內部。
//
// v1.4.14 修法（只改 content-detect.js，injection path 不動）:
//   (1) collectParagraphs 的 BLOCK_TAGS_SET 分支新增 guard：
//       若該 block 有直接 CONTAINER_TAGS 子元素且有候選文字 → FILTER_SKIP 讓 walker 下探。
//   (2) 在非 block 分支新增 Case C：wrapper div 只含 preservable inline（STRONG 等
//       非 <a>）、沒有 BR、沒有 direct text、沒有 block 後代 → 整體當 element 單元。
//   結果：標題 div 與 postbitcontrol2 div 分別被收集，td 不被收集，
//         標題 div 的 injection 不再與 postbitcontrol2 的 img 互相干擾。
//
// SANITY 紀錄（已驗證）：把「`directTextLength(el) < 2 && hasContainerChildWithCandidateText(el)`
// → FILTER_SKIP」guard 整段註解掉後，td 被整個收集成一個 unit，斷言 2（tag=TD 不存在）
// fail；後續若跑完 injection，media-preserving path 也會清掉 smallfont。還原後 spec pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'vbulletin-title-div';

test('vbulletin-title-div: td.alt1 內含 <div class="smallfont"> 標題 + <img> 內文時，翻譯後標題 div 應保留在原位', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('td#td_post_test', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  // 斷言 1：collectParagraphs 應把 div.smallfont 收成一個 element unit
  // 斷言 2：collectParagraphs 不應把 td 當作翻譯單元（td 應被 skip 讓 walker 下探）
  // 直接走 isolated world 的 SK.collectParagraphs（會回傳 DOM 參考），
  // 只抽需要的 tag / class 字串出來以便跨界比較。
  const detect = await evaluate(`
    JSON.stringify((() => {
      const units = window.__SK.collectParagraphs();
      const summary = units.map(u => {
        if (u.kind === 'fragment') {
          return { kind: 'fragment', parentTag: u.el?.tagName, parentClass: u.el?.className || '' };
        }
        return { kind: 'element', tag: u.el.tagName, className: u.el.className || '' };
      });
      return { count: units.length, summary };
    })())
  `);
  const { count, summary } = JSON.parse(detect);

  const tdUnits = summary.filter(s => s.kind === 'element' && s.tag === 'TD');
  expect(
    tdUnits.length,
    `collectParagraphs 不應收集整個 <td>，實際 summary=${JSON.stringify(summary)}`,
  ).toBe(0);

  const smallfontUnit = summary.find(s =>
    s.kind === 'element' && s.tag === 'DIV' && /smallfont/.test(s.className || '')
  );
  expect(
    smallfontUnit,
    `應收集 div.smallfont 為獨立 element unit，實際 summary=${JSON.stringify(summary)}`,
  ).toBeTruthy();

  // mock chrome.runtime.sendMessage 攔截 TRANSLATE_BATCH，回傳對應中文譯文。
  // 依 slot 樣式判斷是標題還是內文：含 ⟦0⟧…⟦/0⟧（STRONG slot）→ 標題；否則 → 內文
  await evaluate(`
    window.__sentMessages = [];
    chrome.runtime.sendMessage = async function(msg) {
      window.__sentMessages.push(msg);
      if (msg && msg.type === 'TRANSLATE_BATCH') {
        const texts = msg.payload?.texts || [];
        const result = texts.map(t => {
          // 標題 slot（STRONG 在 smallfont 內） → 換成中文譯文，保留 ⟦0⟧…⟦/0⟧ 結構
          if (/\\u27E60\\u27E7[\\s\\S]*?\\u27E6\\/0\\u27E7/.test(t)) {
            return t.replace(/\\u27E60\\u27E7[\\s\\S]*?\\u27E6\\/0\\u27E7/, '\\u27E60\\u27E7測試標題中文譯文\\u27E6/0\\u27E7');
          }
          // 內文（postbitcontrol2，slots=[]，含 \\n 與 img 在原位）
          return '這是貼文內文的中文譯文。需要足夠長度才能通過偵測。\\n\\n第三段內容給 inline image 測試使用。';
        });
        return { ok: true, result, usage: { inputTokens: 10, outputTokens: 10 } };
      }
      if (msg && msg.type === 'LOG') return;
      if (msg && msg.type === 'STICKY_QUERY') return { ok: true, shouldTranslate: false };
      return { ok: true };
    };
  `);

  // 抓段落並呼叫 translateUnits（走完整 serialize → inject 路徑）
  await evaluate(`(async () => {
    const units = window.__SK.collectParagraphs();
    await window.__SK.translateUnits(units);
  })()`);

  // 注入後 DOM 狀態
  const translated = await page.evaluate(() => {
    const td = document.querySelector('td#td_post_test');
    if (!td) return null;
    const smallfonts = td.querySelectorAll('.smallfont');
    const strong = td.querySelector('.smallfont strong');
    const postbit = td.querySelector('.postbitcontrol2');
    const img = td.querySelector('img.inlineimg');
    return {
      smallfontCount: smallfonts.length,
      strongText: strong ? strong.textContent.trim() : null,
      postbitExists: !!postbit,
      imgExists: !!img,
      tdInnerHTMLPreview: td.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
    };
  });

  expect(translated, 'td#td_post_test 應存在').not.toBeNull();

  // 斷言 3（核心）：smallfont div 不應消失
  expect(
    translated.smallfontCount,
    `td 內 .smallfont 數量應 = 1（核心 bug：標題 div 被 injection 清掉）\nDOM: ${translated.tdInnerHTMLPreview}`,
  ).toBe(1);

  // 斷言 4：標題原位注入的中文譯文（<strong> 外殼保留，textContent 含中文）
  expect(
    translated.strongText,
    `.smallfont strong 應有中文譯文，實際="${translated.strongText}"\nDOM: ${translated.tdInnerHTMLPreview}`,
  ).toBe('測試標題中文譯文');

  // 斷言 5：postbitcontrol2 內文 div 與原本 inline image 應保留（非回歸項驗證）
  expect(translated.postbitExists).toBe(true);
  expect(translated.imgExists).toBe(true);

  expect(count).toBeGreaterThanOrEqual(2);

  await page.close();
});
