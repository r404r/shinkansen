// Regression: inline-mixed-span (Case D — inline-style SPAN 容器直接含 text + inline element)
//
// Fixture: test/regression/fixtures/inline-mixed-span.html
//
// Bug：YouTube 留言含 timestamp 連結 / @mention / 自動連結 / emoji 圖示時,yt-attributed-string
// 把整段內容包在一個 SPAN(ytAttributedStringHost)裡,直接子混合 text + inline element:
//   <span class="ytAttributedStringHost">
//     <span><a>7:00</a></span>
//     " now we can see how unhinged Joanna is without corpo WSJ. "
//     <span><img></span> ...
//   </span>
// Case A 因 !containsBlockDescendant 失敗、Case B 因 !hasBrChild 失敗、
// Case C 因 SPAN 不在 CONTAINER_TAGS 失敗 → 過去整段被 walker FILTER_SKIP,
// leaf-content-span 路徑因 :not(:has(*)) 也抓不到。
// 真實 Chrome for Claude 抽樣 40 條留言:含 <a> 7/7=100% 失敗;不含 <a> 29/33=88% 成功。
//
// 修法（Case D）：在 acceptNode 的非 BLOCK 分支加第四條 else if,與 Case C 對稱但把
// 「容器是 CONTAINER_TAGS」換成「tag === SPAN + 有直接非 BR element 子」,並加
// hasAncestorExtracted 防巢狀 SPAN 重複抽(BLOCK 補抓的 Case A/B/C 因 CONTAINER_TAGS
// 限定 DIV/SECTION 等不嵌套 tag 沒踩到 dedup,Case D 必須補上)。
//
// stats.inlineMixedSpan 計數 forcing function：counter 名字綁定 Case D 語意,
// 實作若退回原 Case C 路徑或刪掉整條 else if 都會讓 counter 歸零。
//
// SANITY 紀錄（已驗證）：移除 content-detect.js 新增的 Case D else if 整段後,
// 第 1 條(hasYouTubeCommentFrag)與第 2 條(inlineMixedSpan >= 1)同時 fail；
// 還原後 pass。負向對照 short-inline-nav 在修法前後都 pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inline-mixed-span';

test('Case D: inline-style SPAN 含 text + inline element 應被偵測為 fragment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-d', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-d');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');

      const fragTexts = fragments.map(f => {
        let t = '';
        let n = f.startNode;
        while (n) {
          t += n.textContent || '';
          if (n === f.endNode) break;
          n = n.nextSibling;
        }
        return t.trim();
      });

      // 期望 fragment 文字至少涵蓋 timestamp 連結 + 直接 TEXT(留言內文)
      const hasYouTubeCommentFrag = fragTexts.some(t =>
        t.includes('7:00') &&
        t.includes('now we can see how unhinged Joanna')
      );

      return {
        fragmentCount: fragments.length,
        fragTexts,
        hasYouTubeCommentFrag,
        inlineMixedSpan: stats.inlineMixedSpan || 0,
        stats,
      };
    })()
  `);

  expect(
    result.hasYouTubeCommentFrag,
    `Case D: YouTube 留言 host SPAN 應被偵測為 fragment(涵蓋 timestamp 連結 + 留言文字),實際 fragmentCount=${result.fragmentCount}\nfragTexts=${JSON.stringify(result.fragTexts)}\nstats=${JSON.stringify(result.stats)}`,
  ).toBe(true);

  expect(
    result.inlineMixedSpan,
    `Case D: stats.inlineMixedSpan 應 >= 1,實際 ${result.inlineMixedSpan}\nstats=${JSON.stringify(result.stats)}`,
  ).toBeGreaterThanOrEqual(1);

  await page.close();
});

test('Case D 負向對照:inline 短連結 SPAN(directTextLength < 20)不應被誤抓', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-short-inline-nav', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-short-inline-nav');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      const hasShortFrag = fragments.some(f => {
        let t = '';
        let n = f.startNode;
        while (n) {
          t += n.textContent || '';
          if (n === f.endNode) break;
          n = n.nextSibling;
        }
        return /Home.*About/.test(t);
      });
      return {
        fragmentCount: fragments.length,
        hasShortFrag,
        inlineMixedSpan: stats.inlineMixedSpan || 0,
      };
    })()
  `);

  expect(
    result.hasShortFrag,
    `inline 短連結 SPAN 不應被 Case D 誤抓,fragmentCount=${result.fragmentCount} inlineMixedSpan=${result.inlineMixedSpan}`,
  ).toBe(false);

  await page.close();
});

test('Case D 負向對照:巢狀 SPAN(host > inner-mixed)不應雙重抽 fragment', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target-nested-span', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const root = document.querySelector('#target-nested-span');
      const stats = {};
      const units = window.__SK.collectParagraphs(root, stats);
      const fragments = units.filter(u => u.kind === 'fragment');
      return {
        fragmentCount: fragments.length,
        inlineMixedSpan: stats.inlineMixedSpan || 0,
      };
    })()
  `);

  // 父 host SPAN 抽完後,內層 inner-mixed SPAN 不應再抽一次。
  // 預期 Case D 命中次數 == 1(只有 outer host)
  expect(
    result.inlineMixedSpan,
    `巢狀 SPAN 應只觸發 Case D 一次(outer host),實際 inlineMixedSpan=${result.inlineMixedSpan}`,
  ).toBe(1);

  await page.close();
});
