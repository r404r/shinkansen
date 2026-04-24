// content-inject.js — Shinkansen DOM 注入
// 負責把翻譯結果注入回 DOM：resolveWriteTarget、injectIntoTarget、
// replaceNodeInPlace、replaceTextInPlace、plainTextFallback、fragment 注入。

(function(SK) {

  const STATE = SK.STATE;

  /**
   * 保證同一個 element 只快照一次原始子節點。
   */
  SK.snapshotOnce = function snapshotOnce(el) {
    if (!STATE.originalHTML.has(el)) {
      STATE.originalHTML.set(el, SK.cloneChildSnapshot(el));
    }
  };

  /**
   * 「注入目標解析」——回答「要把譯文寫到哪個元素?」
   * 預設值是 el 本身。唯一例外：el 自己 computed font-size 趨近 0（MJML 模板）。
   */
  function resolveWriteTarget(el) {
    const win = el.ownerDocument?.defaultView;
    const cs = win?.getComputedStyle?.(el);
    const px = cs ? parseFloat(cs.fontSize) : NaN;
    if (Number.isFinite(px) && px < 1) {
      const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node === el) return NodeFilter.FILTER_SKIP;
            if (SK.isPreservableInline(node) || SK.isAtomicPreserve(node)) {
              return NodeFilter.FILTER_REJECT;
            }
            const dcs = win?.getComputedStyle?.(node);
            const dpx = dcs ? parseFloat(dcs.fontSize) : NaN;
            if (Number.isFinite(dpx) && dpx >= 1) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          },
        }
      );
      const found = walker.nextNode();
      if (found) return found;
    }
    return el;
  }

  /**
   * 「注入」helper——回答「要怎麼把譯文寫進 target?」
   * (A) Clean slate 預設：清空 target 後 append content。
   * (B) Media-preserving 例外：target 含媒體元素，且無 CONTAINER_TAGS 直屬子元素時，
   *     就地替換最長文字節點（保留媒體位置）。
   *     若 target 有 DIV/SECTION 等容器直屬子元素（如 vBulletin TD > DIV+HR+DIV），
   *     文字節點分散於不同結構子容器，media-preserving 路徑會把譯文塞進最長文字
   *     所在的子容器，導致其他結構元素（HR、標題 DIV）殘留在錯誤位置（HR 跑到標題上面）。
   *     這種情況改走 clean-slate，讓 deserialize 後的 fragment 依正確順序填入 target。
   *     （v1.4.14 修正 vBulletin 論壇貼文標題翻譯後分隔線位置顛倒）
   */
  function injectIntoTarget(target, content) {
    const isString = typeof content === 'string';

    // (B) 條件：含媒體 && target 無 CONTAINER_TAGS 直屬子元素
    const hasContainerChild = Array.from(target.children).some(c =>
      SK.CONTAINER_TAGS.has(c.tagName));
    if (SK.containsMedia(target) && !hasContainerChild) {
      // (B) media-preserving path
      if (!isString) {
        let fragHasBr = false;
        const fw = document.createTreeWalker(content, NodeFilter.SHOW_ELEMENT);
        let fn;
        while ((fn = fw.nextNode())) {
          if (fn.tagName === 'BR') { fragHasBr = true; break; }
        }
        if (fragHasBr) {
          const oldBrs = target.querySelectorAll('br');
          for (const br of oldBrs) if (br.parentNode) br.parentNode.removeChild(br);
        }
      }
      const node = isString ? target.ownerDocument.createTextNode(content) : content;
      const textNodes = SK.collectVisibleTextNodes(target);
      if (textNodes.length === 0) {
        target.appendChild(node);
        return;
      }
      const main = SK.findLongestTextNode(textNodes);
      for (const t of textNodes) {
        if (t === main) continue;
        t.nodeValue = '';
        // v1.2.2: 清空文字後，若父 inline 元素（如 <a>）因此變成空殼，向上逐層移除，
        // 避免留下看不見的空連結殼（Gmail Team Picks 連結消失 bug 的根因）
        let p = t.parentNode;
        while (p && p !== target) {
          if (p.textContent.trim() === '' && !SK.containsMedia(p)) {
            const gp = p.parentNode;
            if (!gp) break;
            gp.removeChild(p);
            p = gp;
          } else {
            break;
          }
        }
      }
      const parent = main.parentNode;
      if (parent) {
        parent.insertBefore(node, main);
        parent.removeChild(main);
      } else {
        target.appendChild(node);
      }
      return;
    }

    // (A) clean slate path
    while (target.firstChild) target.removeChild(target.firstChild);
    if (isString) {
      target.textContent = content;
    } else {
      target.appendChild(content);
    }
  }

  /**
   * 把含 \n 的純文字譯文做成 DocumentFragment。
   */
  function buildFragmentFromTextWithBr(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
    }
    return frag;
  }

  /**
   * slot 配對失敗 fallback 用的純文字注入。
   */
  function plainTextFallback(el, cleaned) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, cleaned);
  }

  /**
   * 無 slots 路徑的純文字注入。
   */
  function replaceTextInPlace(el, translation) {
    if (translation && translation.includes('\n')) {
      const frag = buildFragmentFromTextWithBr(translation);
      replaceNodeInPlace(el, frag);
      return;
    }
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, translation);
  }

  /**
   * slots 路徑的 fragment 注入。
   */
  function replaceNodeInPlace(el, frag) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, frag);
  }

  // ─── 主注入函式 ───────────────────────────────────────

  /**
   * ok=false fallback: LLM 丟掉佔位符時，嘗試從原始 DOM 找回 <a> slot 的文字，
   * 在譯文中重新定位並包回 <a> 標籤，還原連結結構。
   * 僅處理 <a> slot；slot 文字必須完整出現在譯文中才做，否則 return null。
   *
   * 範例（Dhruv Team Picks）：
   *   原文: "Dhruv's been having fun with this little ⟦0⟧Kodak Charmera⟦/0⟧ keychain."
   *   LLM 回: "Dhruv 最近都在玩這個超可愛的 Kodak Charmera 鑰匙圈。"  (slot 丟掉)
   *   → 找到 "Kodak Charmera" → frag: TEXT + A("Kodak Charmera") + TEXT
   */
  function tryRecoverLinkSlots(el, text, slots) {
    // 找出所有 <a> slot 的 index
    const linkSlotIdxs = [];
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s && s.nodeType === Node.ELEMENT_NODE && s.tagName === 'A') {
        linkSlotIdxs.push(i);
      }
    }
    if (linkSlotIdxs.length === 0) return null;

    // 從原始 DOM 取得每個 <a> 的原始文字（按 DOM 順序）
    const originalAnchors = Array.from(el.querySelectorAll('a'));

    let remaining = text;
    const parts = [];
    let anyFound = false;
    let slotPtr = 0;

    for (const anchor of originalAnchors) {
      const linkText = (anchor.textContent || '').trim();
      if (linkText.length < 2) continue; // 太短容易誤判
      const pos = remaining.indexOf(linkText);
      if (pos === -1) continue; // 找不到則跳過，不強行猜位置

      const matchIdx = linkSlotIdxs[slotPtr];
      if (matchIdx === undefined) continue;

      if (pos > 0) parts.push({ type: 'text', content: remaining.slice(0, pos) });
      parts.push({ type: 'link', content: linkText, slotIdx: matchIdx });
      remaining = remaining.slice(pos + linkText.length);
      anyFound = true;
      slotPtr++;
    }

    if (!anyFound) return null;
    if (remaining) parts.push({ type: 'text', content: remaining });

    // 建立 DocumentFragment
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (part.type === 'text') {
        if (part.content) frag.appendChild(document.createTextNode(part.content));
      } else {
        const shell = slots[part.slotIdx].cloneNode(false);
        shell.appendChild(document.createTextNode(part.content));
        frag.appendChild(shell);
      }
    }
    return frag;
  }

  SK.injectTranslation = function injectTranslation(unit, translation, slots) {
    if (!translation) return;
    // v1.4.8: 統一在注入入口規範化字面 \n（反斜線+n，兩字元）→ 真正換行符（U+000A）。
    // v1.4.6 在 deserializeWithPlaceholders（有 slots 路徑）加了同樣的規範化，
    // 但 fragment no-slots / element no-slots 路徑完全繞過 deserializeWithPlaceholders，
    // 導致字面 \n 殘留可見 DOM 字元。在此入口統一處理，覆蓋所有後續路徑。
    if (translation.includes('\\n')) translation = translation.replace(/\\n/g, '\n');
    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const el = unit.el;
    SK.snapshotOnce(el);

    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        replaceNodeInPlace(el, frag);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, SK.cloneChildSnapshot(el));
        return;
      }
      const cleaned = SK.stripStrayPlaceholderMarkers(translation);
      // v1.2.3: ok=false 時，嘗試從原始 DOM 找回 <a> 連結文字並重建連結結構
      const recovered = tryRecoverLinkSlots(el, cleaned, slots);
      if (recovered) {
        replaceNodeInPlace(el, recovered);
        el.setAttribute('data-shinkansen-translated', '1');
        STATE.translatedHTML.set(el, SK.cloneChildSnapshot(el));
        return;
      }
      plainTextFallback(el, cleaned);
      el.setAttribute('data-shinkansen-translated', '1');
      STATE.translatedHTML.set(el, SK.cloneChildSnapshot(el));
      return;
    }

    replaceTextInPlace(el, translation);
    el.setAttribute('data-shinkansen-translated', '1');
    STATE.translatedHTML.set(el, SK.cloneChildSnapshot(el));
  };

  function injectFragmentTranslation(unit, translation, slots) {
    if (!translation) return;
    const { el, startNode, endNode } = unit;

    if (!startNode || startNode.parentNode !== el) return;

    SK.snapshotOnce(el);

    let newContent;
    if (slots && slots.length > 0) {
      const { frag, ok } = SK.deserializeWithPlaceholders(translation, slots);
      if (ok) {
        newContent = frag;
      } else {
        const cleaned = SK.stripStrayPlaceholderMarkers(translation);
        newContent = document.createTextNode(cleaned);
      }
    } else {
      // v1.4.8: 無 slots 時也要把 \n 還原為 <br>（字面 \n 已在 injectTranslation 入口轉換完畢）
      if (translation.includes('\n')) {
        newContent = buildFragmentFromTextWithBr(translation);
      } else {
        newContent = document.createTextNode(translation);
      }
    }

    const anchor = endNode ? endNode.nextSibling : null;
    const toRemove = [];
    let cur = startNode;
    while (cur) {
      toRemove.push(cur);
      if (cur === endNode) break;
      cur = cur.nextSibling;
    }
    for (const n of toRemove) {
      if (n.parentNode === el) el.removeChild(n);
    }
    el.insertBefore(newContent, anchor);
  }

  // 暴露 resolveWriteTarget / injectIntoTarget 供 Debug API testInject 使用
  SK._resolveWriteTarget = resolveWriteTarget;
  SK._injectIntoTarget = injectIntoTarget;

})(window.__SK);
