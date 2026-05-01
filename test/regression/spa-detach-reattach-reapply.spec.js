// Regression: spa-detach-reattach reapply
//
// Fixture: test/regression/fixtures/spa-detach-reattach.html
//
// Bug:框架(典型 YouTube yt-attributed-string)在 model 更新時把整個被翻譯的
// element detach 換上新 element(內含原文)。Content Guard 走 STATE.translatedHTML.keys()
// 比對 innerHTML 的設計遇到這 case 失效:舊 el !isConnected → continue,新 el
// 不在 translatedHTML → 認不出。譯文永久消失。
//
// 真實 reproduce:Joanna Stern 影片描述「The Chinese-made Unitree G1...」捲動到留言區
// 再捲回來時,observer 抓到 dt=261268 ms 一次 `removedNodes:1 / addedNodes:1` 的
// childList mutation,新 element 是 yt-attributed-string 重 render 出的英文版,
// 譯文不再回來。第一次 dt=48 ms guard 救回成功是因為框架那次只改 innerHTML
// (元素本體沒換),guard `el.innerHTML = savedHTML` 救得回。
//
// 修法:onSpaObserverMutations 入口加 reapplyOnDetachReattach,事件驅動掃 mutation
// 的 (removed, added) 對,用 STATE.originalText snapshot 比對找回新 element,
// reapply 譯文 + 把 STATE 的 key 從舊 element 轉到新 element。inject 路徑 snapshotOnce
// 同步寫 STATE.originalText 給此路徑用。
//
// SANITY 紀錄(已驗證):暫時把 SK._reapplyOnDetachReattach 改成 no-op 後此 spec fail
// (新 element 仍是英文,且 STATE.translatedHTML 仍 key 著舊 detached el),還原後 pass。
import { test, expect } from '../fixtures/extension.js';
import { loadFixtureResponse, getShinkansenEvaluator, runTestInject } from './helpers/run-inject.js';

const FIXTURE = 'spa-detach-reattach';
const TARGET_SELECTOR = 'p#target';
const PARENT_SELECTOR = 'div#parent';

test('spa-detach-reattach: 框架把譯後 element 換成原文新 element 後,reapply 應把譯文搬到新 element', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(TARGET_SELECTOR, { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);
  const translation = loadFixtureResponse(FIXTURE);

  // Step 1: 注入譯文(同時填 STATE.translatedHTML 與 STATE.originalText)
  await runTestInject(evaluate, TARGET_SELECTOR, translation);
  await evaluate(`window.__shinkansen.setTestState({ translated: true })`);

  const afterInject = await page.evaluate(
    (sel) => document.querySelector(sel).textContent,
    TARGET_SELECTOR,
  );
  expect(afterInject, '注入後應為中文譯文').toContain('棕色狐狸');

  // 驗證 originalText snapshot 已寫入(forcing function:snapshotOnce 沒寫
  // STATE.originalText 的話,後面 reapply 比對會 fallback 到 originalText.get → undefined)
  const originalTextSize = await evaluate(`window.__SK.STATE.originalText.size`);
  expect(originalTextSize, 'snapshotOnce 應同時寫入 STATE.originalText').toBeGreaterThanOrEqual(1);

  // Step 2: 模擬框架 detach + reattach —— removeChild 舊 P,appendChild 新 P 內含原文。
  // 這跟 innerHTML 覆寫(guard-content-overwrite)是不同的 mutation pattern:
  // 舊路徑 element 仍 connected, guard 能修;此路徑 element 整個被換掉,guard 失效。
  // 直接構造 fake mutation array 餵 SK._reapplyOnDetachReattach,跳過 MutationObserver
  // microtask timing。reapply 邏輯本身與 mutation 來源無關,純看 (removed, added)
  // 的文字配對。
  const result = await evaluate(`
    (() => {
      const SK = window.__SK;
      const STATE = SK.STATE;

      const parent = document.querySelector(${JSON.stringify(PARENT_SELECTOR)});
      const oldEl = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      const oldElRef = oldEl;

      // 確認 STATE 在 detach 前確實 key 著舊 el
      const hadKey = STATE.translatedHTML.has(oldEl);
      const savedOriginalText = STATE.originalText.get(oldEl);

      // 構造新 element:同樣 tag、同樣 id、同樣 textContent(原文,英文)
      const newEl = document.createElement('p');
      newEl.id = 'target';
      newEl.textContent = savedOriginalText;

      // detach 舊 + attach 新
      parent.removeChild(oldEl);
      parent.appendChild(newEl);

      // 直接餵 fake mutation array(reapply 函式只看 m.type / m.removedNodes / m.addedNodes)
      const fakeMutation = {
        type: 'childList',
        target: parent,
        removedNodes: [oldElRef],
        addedNodes: [newEl],
      };
      SK._reapplyOnDetachReattach([fakeMutation]);

      const newElInDom = document.querySelector(${JSON.stringify(TARGET_SELECTOR)});
      return {
        hadKey,
        savedOriginalText,
        oldElConnected: oldElRef.isConnected,
        newElText: newElInDom ? newElInDom.textContent : null,
        newElDataSk: newElInDom ? newElInDom.getAttribute('data-shinkansen-translated') : null,
        translatedHTMLHasNew: STATE.translatedHTML.has(newElInDom),
        translatedHTMLHasOld: STATE.translatedHTML.has(oldElRef),
        originalTextHasNew: STATE.originalText.has(newElInDom),
        originalTextHasOld: STATE.originalText.has(oldElRef),
      };
    })()
  `);

  // Pre-condition 斷言
  expect(result.hadKey, 'inject 後 STATE.translatedHTML 應 key 著舊 el').toBe(true);
  expect(result.savedOriginalText, 'STATE.originalText 應有原文 snapshot').toContain('quick brown fox');
  expect(result.oldElConnected, '舊 el 已 detach 應 isConnected=false').toBe(false);

  // 核心斷言:reapply 把譯文搬到新 el
  expect(
    result.newElText,
    `reapply 失敗:新 element textContent 應為中文譯文,實際=${JSON.stringify(result.newElText)}`,
  ).toContain('棕色狐狸');

  expect(
    result.newElDataSk,
    `reapply 後新 element 應有 data-shinkansen-translated 標記,實際=${JSON.stringify(result.newElDataSk)}`,
  ).toBe('1');

  // STATE 一致性:key 必須從舊 → 新
  expect(result.translatedHTMLHasOld, 'STATE.translatedHTML 不應再 key 著舊 el').toBe(false);
  expect(result.translatedHTMLHasNew, 'STATE.translatedHTML 應 key 著新 el').toBe(true);
  expect(result.originalTextHasOld, 'STATE.originalText 不應再 key 著舊 el').toBe(false);
  expect(result.originalTextHasNew, 'STATE.originalText 應 key 著新 el').toBe(true);

  await page.close();
});
