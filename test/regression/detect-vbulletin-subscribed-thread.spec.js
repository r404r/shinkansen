// Regression: vbulletin-subscribed-thread (對應 v1.8.33 修的「vBulletin forumdisplay
// 訂閱中的 thread title 沒被翻譯」bug,真實案例 forum.miata.net)
//
// Fixture: test/regression/fixtures/vbulletin-subscribed-thread.html
// 結構特徵 (sanitized vBulletin forumdisplay,使用者已訂閱該 thread 時):
//   <td id="target-subscribed">
//     <div>
//       <span style="float:right">[RF]</span>
//       <a id="thread_gotonew_X" rel="nofollow"><img alt="跳到新帖"></a>  ← textLen=0 圖示連結
//       <a id="thread_title_X" style="font-weight:bold">英文標題</a>      ← 真正要翻的標題
//     </div>
//     <div class="smallfont"><span>作者</span></div>
//   </td>
//
// 對照 (一般未訂閱 thread):td 直接子 [A, SPAN] (沒有外包 DIV,也沒有 prefix img)
//
// Bug 根因 (v1.8.32 以前的 collectParagraphs):
//   acceptNode 內 mediaCardSkip (v1.4.20,line 387) 在 skipBlockWithContainer (v1.4.17,
//   line 420) 之前。TD 同時:
//     (a) 含 img (thread_gotonew 內的「跳到新帖」16px 圖示) → mediaCardSkip 條件 (1) 滿足
//     (b) 直屬子有 DIV (CONTAINER_TAGS) → mediaCardSkip 條件 (2) 滿足
//   → mediaCardSkip 先命中 → 整個 TD FILTER_SKIP。
//   接下來 walker 往內走想找葉節點,但 A#thread_title 是 inline 直接含 text node,
//   Case A-D 補抓邏輯都不抓這種結構 (Case A 要 hasDirectText+block descendant;
//   Case B 要 BR + CONTAINER_TAGS;Case C 要 CONTAINER_TAGS;Case D 要 SPAN)。
//   → 整個 TD 內 0 個 unit 進 results,thread title 完全沒翻。
//
// 對照 detect-media-card-attachment.spec.js 寫的「v1.4.17 跟 v1.4.20 互不重疊」假設
// 在這個 fixture 上失效:vBulletin 訂閱中 thread 同時觸發兩個條件,順序決定誰先命中。
//
// v1.8.33 修法 (content-detect.js → collectParagraphs acceptNode):
//   把 v1.4.17 的 block-with-container A capture 區塊提到 mediaCardSkip 之前。
//   命中時 SKIP + skipBlockWithContainer 計數;沒 A 可抓時 fallthrough 到 mediaCardSkip,
//   既有 XenForo 附件 LI 行為不變 (file-name 是 SPAN 沒 A,v1.4.17 不命中 → fallthrough)。
//
// 結構性通則 (描述 DOM 不綁站點/class):
//   block element 含 CONTAINER_TAGS 直屬子 + 容器內有可翻 <A> 連結 →
//   只翻 A,block 本體 SKIP。即使 block 含媒體,因為 v1.4.17 邏輯不 clean-slate block,
//   媒體不會被誤清,無需走 mediaCardSkip 多此一舉。
//
// 斷言走結構 (不綁 class / id / site):
//   (1) A#thread_title_799932 (bold) 被偵測為翻譯單元
//   (2) TD#target-subscribed 不被偵測為 element 單元 (核心 regression)
//   (3) skipStats.skipBlockWithContainer >= 1 + blockContainerLink >= 1
//   (4) skipStats.mediaCardSkip == 0 (因為 v1.4.17 先接走了)
//   (5) 既有對照 td#target-normal (一般 thread,無 wrapper DIV) 仍當 element unit 翻
//
// SANITY 紀錄 (已驗證):把 content-detect.js v1.8.33 的「提前 v1.4.17」改回原順序
// (mediaCardSkip 在前) 後,本 spec 第 (1) 條 fail (A#thread_title 沒進 units)、
// 第 (2)(3) 條也連動 fail (TD 走 mediaCardSkip,skipBlockWithContainer=0)。
// 還原修法後 spec pass。
import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'vbulletin-subscribed-thread';

test('vbulletin-subscribed-thread: bold A 被偵測為翻譯單元,TD 本身 SKIP 不走 mediaCardSkip', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('td#target-subscribed', { timeout: 10_000 });
  await page.waitForSelector('a#thread_title_799932', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    JSON.stringify(window.__shinkansen.collectParagraphsWithStats())
  `);
  const { units, skipStats } = JSON.parse(result);

  const unitsPreview = JSON.stringify(
    units.map((u) => ({ kind: u.kind, tag: u.tag, id: u.id, preview: (u.textPreview || '').slice(0, 60) })),
    null,
    2,
  );
  const statsPreview = JSON.stringify(skipStats);

  // 斷言 1 (核心):bold A 被偵測為翻譯單元
  const titleUnit = units.find(
    (u) => u.kind === 'element' && u.tag === 'A' && u.id === 'thread_title_799932',
  );
  expect(
    titleUnit,
    `A#thread_title_799932 (font-weight:bold) 應被偵測為翻譯單元\nunits=\n${unitsPreview}\nstats=${statsPreview}`,
  ).toBeDefined();

  // 斷言 2 (核心):TD#target-subscribed 不被偵測為 element 單元
  const tdUnit = units.find(
    (u) => u.kind === 'element' && u.tag === 'TD' && u.id === 'target-subscribed',
  );
  expect(
    tdUnit,
    `TD#target-subscribed 不應被偵測為 element 單元 (核心 regression)\nunits=\n${unitsPreview}\nstats=${statsPreview}`,
  ).toBeUndefined();

  // 斷言 3:v1.4.17 計數器命中
  expect(
    skipStats.skipBlockWithContainer || 0,
    `skipBlockWithContainer 應 >= 1,實際 ${skipStats.skipBlockWithContainer || 0}\nstats=${statsPreview}`,
  ).toBeGreaterThanOrEqual(1);
  expect(
    skipStats.blockContainerLink || 0,
    `blockContainerLink 應 >= 1,實際 ${skipStats.blockContainerLink || 0}\nstats=${statsPreview}`,
  ).toBeGreaterThanOrEqual(1);

  // 斷言 4:mediaCardSkip 不該命中 (v1.4.17 先接走)
  expect(
    skipStats.mediaCardSkip || 0,
    `mediaCardSkip 不該被觸發 (v1.4.17 應先接走),實際 ${skipStats.mediaCardSkip || 0}\nstats=${statsPreview}`,
  ).toBe(0);

  // 斷言 5:對照組 td#target-normal (一般 thread) 仍當 element unit 翻 (不被新規則誤殺)
  const normalUnit = units.find(
    (u) => u.kind === 'element' && u.tag === 'TD' && u.id === 'target-normal',
  );
  expect(
    normalUnit,
    `td#target-normal 應仍被偵測為 element 單元 (對照組,不該被誤攔)\nunits=\n${unitsPreview}`,
  ).toBeDefined();

  await page.close();
});
