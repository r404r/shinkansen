// Regression: wiki-edo-lead-slot-dup (對應 v0.57 修的 slot dup graceful degradation)
//
// Fixture: test/regression/fixtures/wiki-edo-lead.html
// 結構: <p> 含 8 個 slot
//   slot 0  = <b>Edo</b>
//   slot 1  = <a>Japanese</a>
//   slot 2  = <sup class="reference"><a>[1]</a></sup>  (atomic, ⟦*2⟧)
//   slot 3  = <a>Yedo</a>
//   slot 4  = <a>former name</a>     ← canned response 故意 dup 這個
//   slot 5  = <a>Tokyo</a>
//   slot 6  = <a>Japan</a>
//   slot 7  = <a>Tokugawa shogunate</a>
//
// Canned response (見 wiki-edo-lead.response.txt) 模仿 v0.57 真實踩到的
// LLM 失誤:把 slot 4 同時用在「⟦4⟧現今日本首都⟦/4⟧」與「⟦4⟧舊稱⟦/4⟧」兩處,
// 兩個 occurrence 都是非空,winner 應為第一個 (現今日本首都),loser
// (舊稱) 應降級為純文字。
//
// v0.52 的 bug 政策:任何 dup → ok=false → plainTextFallback → <p>
// clean-slate → 7 個 <a> 全部消失,代價巨大。
// v0.57 的 graceful policy:首次非空 occurrence 當 winner 保留 shell,
// 其他 occurrence 拆殼降級為純文字。最終 <p> 仍有 7 個 <a>
// (6 paired + 1 inside atomic sup),只有 1 個 dup loser 變成純文字。
//
// 斷言全部基於結構特徵 (CLAUDE.md 硬規則 8):
//   - <p> 內 <a> 總數
//   - <b> / <sup.reference> 結構保留
//   - winner 文字確實在 <a> 內、loser 文字確實不在任何 <a> 內
import { test, expect } from '../fixtures/extension.js';
import {
  loadFixtureResponse,
  getShinkansenEvaluator,
  runTestInject,
} from './helpers/run-inject.js';

const FIXTURE = 'wiki-edo-lead';
const TARGET_SELECTOR = 'p#target';

test('wiki-edo-lead-slot-dup: 重複的 slot 不應拖累其他 slot 一起陪葬', async ({
  context,
  localServer,
}) => {
  const translation = loadFixtureResponse(FIXTURE);
  // sanity: canned response 確實含 dup slot 4
  const slot4Open = '\u27E64\u27E7';
  const occurrences = (translation.match(new RegExp(slot4Open, 'g')) || []).length;
  expect(occurrences, 'canned response 必須含 2 個 ⟦4⟧ 開頭標記才能觸發 dup').toBe(2);

  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const injectResult = await runTestInject(evaluate, TARGET_SELECTOR, translation);
  // 序列化階段應該抽出 8 個 slot (含 1 個 atomic)
  expect(injectResult.slotCount).toBe(8);

  const after = await page.evaluate((sel) => {
    const p = document.querySelector(sel);
    if (!p) return null;
    const allAnchors = Array.from(p.querySelectorAll('a'));
    const allBolds = Array.from(p.querySelectorAll('b'));
    const allSupRefs = Array.from(p.querySelectorAll('sup.reference'));
    const supInnerAnchors = allSupRefs.flatMap(s => Array.from(s.querySelectorAll('a')));
    const anchorTexts = allAnchors.map(a => a.textContent.trim());
    return {
      anchorCount: allAnchors.length,
      boldCount: allBolds.length,
      boldText: allBolds[0] ? allBolds[0].textContent.trim() : null,
      supRefCount: allSupRefs.length,
      supInnerAnchorCount: supInnerAnchors.length,
      supInnerText: allSupRefs[0] ? allSupRefs[0].textContent.trim() : null,
      anchorTexts,
      pTextContent: p.textContent,
      pInnerHTMLPreview: p.innerHTML.replace(/\s+/g, ' ').slice(0, 300),
    };
  }, TARGET_SELECTOR);

  expect(after, 'p#target 應該存在').not.toBeNull();

  // 斷言 1: <p> 底下的 <a> 總數 = 7
  //   組成:6 個 paired slot 的 <a> shell (slot 1, 3, 4-winner, 5, 6, 7)
  //         + 1 個 atomic SUP 內的 <a> (slot 2 deep clone)
  //   loser (slot 4 第二次 occurrence) 拆殼後文字保留但不在 <a> 內,所以
  //   不貢獻 <a> count。
  expect(
    after.anchorCount,
    `<p> 底下 <a> 總數應為 7,實際 ${after.anchorCount}\nDOM: ${after.pInnerHTMLPreview}`,
  ).toBe(7);

  // 斷言 2: <b> 結構保留 (slot 0)
  expect(after.boldCount).toBe(1);
  expect(after.boldText).toBe('江戶');

  // 斷言 3: <sup class="reference"> atomic 整段保留 (含內部 <a> 與 [1] 文字)
  // atomic 不會被翻譯,文字應為原文 [1]
  expect(after.supRefCount).toBe(1);
  expect(after.supInnerAnchorCount).toBe(1);
  expect(after.supInnerText).toBe('[1]');

  // 斷言 4: dup winner (現今日本首都) 確實在 <a> 內 (slot 4 shell 保留)
  expect(
    after.anchorTexts,
    `winner「現今日本首都」應出現在某個 <a>。實際 anchor texts: ${JSON.stringify(after.anchorTexts)}`,
  ).toContain('現今日本首都');

  // 斷言 5: dup loser (舊稱) 不應在任何 <a> 內 (loser 拆殼降級為純文字)
  expect(
    after.anchorTexts.includes('舊稱'),
    `loser「舊稱」不應出現在 <a> 內,但實際出現了。anchor texts: ${JSON.stringify(after.anchorTexts)}`,
  ).toBe(false);

  // 斷言 6: 但 loser 的文字內容仍然存在 <p> 裡 (只是降級為純文字,不是消失)
  expect(after.pTextContent).toContain('舊稱');

  await page.close();
});
