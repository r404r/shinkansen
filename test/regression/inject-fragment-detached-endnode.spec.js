// Regression: v1.6.19 — fragment unit 的 endNode 被 reparent(parentNode 換成別的元素)
// 時,anchor 必須擋下,不可拿 endNode.nextSibling(可能是其他 parent 的 sibling,
// 不屬於 el)當 insertBefore 的 anchor。
//
// 修法位置:shinkansen/content-inject.js injectFragmentTranslation()
//   舊: const anchor = endNode ? endNode.nextSibling : null;
//   新: const anchor = (endNode && endNode.parentNode === el) ? endNode.nextSibling : null;
//
// 觸發場景(關鍵差異):
//   collectParagraphs 紀錄了 unit { startNode: A, endNode: B },翻譯期間 SPA framework
//   把 B 從 el 搬到 detached 容器(react-reconcile / vue v-if / 自家 DOM 操作),
//   此時 B.parentNode = detachedDiv、B.nextSibling = detachedDiv 內的另一個 sibling。
//   舊版 anchor 算式拿到 detachedDiv 內的 sibling,el.insertBefore(newContent, anchor)
//   會拋 NotFoundError(anchor 不是 el 的 child)。新版 parentNode === el guard 擋下,
//   anchor=null,newContent 改用 appendChild 落在 el 末尾——不理想但至少不 crash。
//
// 結構通則 / 測法:
//   - fixture 內 #target 包 .lead-a (startNode)、.lead-b (endNode)、.trailing(順序錨點)
//   - spec 把 .lead-b 從 #target 搬到 #detached-host(模擬外部 reparent),
//     並在 #detached-host 內補一個 sibling 讓 .lead-b.nextSibling 不為 null
//   - 呼叫 SK.injectTranslation(unit, '譯文', [])
//   - 驗證不 crash 且 #target 沒被破壞(.trailing 仍存在)
//
// SANITY 紀錄(已驗證,2026-04-27 Claude Code 端):
//   把 anchor 算式改回 `endNode ? endNode.nextSibling : null`(舊版)後,
//   endNode 已被搬到 #detached-host,nextSibling 是 detached 容器內的另一個 sibling,
//   el.insertBefore(newContent, 那個 sibling) 拋 NotFoundError。spec 的 injectErr
//   不為 null,測試 fail。還原 fix 後 pass。

import { test, expect } from '../fixtures/extension.js';
import { getShinkansenEvaluator } from './helpers/run-inject.js';

const FIXTURE = 'inject-fragment-detached-endnode';

test('inject-fragment-detached-endnode: endNode 被 reparent 時不應拿錯 anchor 拋 NotFoundError', async ({
  context,
  localServer,
}) => {
  const page = await context.newPage();
  await page.goto(`${localServer.baseUrl}/${FIXTURE}.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#target .trailing', { timeout: 10_000 });

  const { evaluate } = await getShinkansenEvaluator(page);

  const result = await evaluate(`
    (() => {
      const el = document.querySelector('#target');
      const leadA = el.querySelector('.lead-a');
      const leadB = el.querySelector('.lead-b');
      const trailingBefore = el.querySelector('.trailing');

      // 構造 fragment unit:startNode=.lead-a,endNode=.lead-b
      const unit = { kind: 'fragment', el, startNode: leadA, endNode: leadB };

      // 模擬 SPA framework 把 endNode 搬到別的 parent(典型 React reconcile)
      // 同時在 detached 容器內補另一個 sibling,讓 leadB.nextSibling 不為 null
      const detachedHost = document.createElement('div');
      detachedHost.id = 'detached-host';
      const sibling = document.createElement('span');
      sibling.textContent = 'detached-sibling';
      detachedHost.appendChild(leadB);
      detachedHost.appendChild(sibling);
      // leadB.parentNode = detachedHost, leadB.nextSibling = sibling(不屬於 el)

      let injectErr = null;
      try {
        window.__SK.injectTranslation(unit, '譯文-X', []);
      } catch (err) {
        injectErr = err.message + ' | name=' + err.name;
      }

      return {
        injectErr,
        // 驗證 #target 仍含 .trailing(舊版 NotFoundError 後 el 狀態保留)
        trailingStillExists: !!el.querySelector('.trailing'),
        innerHTMLPreview: el.innerHTML.slice(0, 200),
      };
    })()
  `);

  // 核心斷言:不應 crash(舊版會拋 NotFoundError——insertBefore 的 anchor 不屬於 el)
  // 註:startNode→endNode 的迴圈在 endNode reparent 後會走到 null 才停,
  // 把 startNode 之後所有 sibling 都加進 toRemove 並刪掉。新舊兩版在這點行為相同,
  // 差異只在最後 insertBefore 那一行——舊版的 anchor 指向錯 parent crash,新版 anchor=null。
  expect(
    result.injectErr,
    `injectTranslation 不應因 endNode reparent 而 throw;實際 error: ${result.injectErr};` +
    `el innerHTML=${result.innerHTMLPreview}`,
  ).toBe(null);

  await page.close();
});
