// content-detect.js — Shinkansen 段落偵測
// 負責語言偵測、容器排除、段落收集（collectParagraphs）、fragment 抽取。

(function(SK) {

  // ─── v0.76: 自動語言偵測 ─────────────────────────────────
  const SIMPLIFIED_ONLY_CHARS = new Set(
    '们这对没说还会为从来东车长开关让认应该头电发问时点学两' +
    '乐义习飞马鸟鱼与单亲边连达远运进过选钱铁错阅难页题风' +
    '饭体办写农决况净减划动务区医华压变号叶员围图场坏块' +
    '声处备够将层岁广张当径总战担择拥拨挡据换损摇数断无旧显' +
    '机权条极标样欢残毕气汇沟泽浅温湿灭灵热爱状独环现盖监盘' +
    '码确离种积称穷竞笔节范药虑虽见规览计订训许设评识证诉试' +
    '详语误读调贝负贡财贫购贸费赶递邮释银锁门间隐随雾静须领' +
    '颜饮驱验鸡麦龙龟齿齐复'
  );

  const NON_CHINESE_LANG_PREFIX = /^(ja|ko)\b/i;

  SK.isTraditionalChinese = function isTraditionalChinese(text) {
    const htmlLang = document.documentElement.lang || '';
    if (NON_CHINESE_LANG_PREFIX.test(htmlLang)) return false;

    const lettersOnly = text.replace(/[\s\d\p{P}\p{S}]/gu, '');
    if (lettersOnly.length === 0) return false;

    let cjkCount = 0;
    let simpCount = 0;
    let kanaCount = 0;

    for (const ch of lettersOnly) {
      const code = ch.codePointAt(0);
      if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) {
        cjkCount++;
        if (SIMPLIFIED_ONLY_CHARS.has(ch)) simpCount++;
      }
      if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) {
        kanaCount++;
      }
    }

    if (kanaCount > 0 && kanaCount / lettersOnly.length > 0.05) return false;
    if (cjkCount / lettersOnly.length < 0.5) return false;
    if (cjkCount > 0 && simpCount / cjkCount >= 0.2) return false;
    return true;
  };

  function isCandidateText(el) {
    const text = el.innerText?.trim();
    if (!text || text.length < 2) return false;
    if (SK.isTraditionalChinese(text)) return false;
    if (!/[\p{L}]/u.test(text)) return false;
    return true;
  }

  // ─── 容器排除 ─────────────────────────────────────────

  function isContentFooter(el) {
    if (!el || el.tagName !== 'FOOTER') return false;
    if (el.querySelector('.wp-block-query, .wp-block-post-title, .wp-block-post')) return true;
    let cur = el.parentElement;
    while (cur && cur !== document.body) {
      if (cur.tagName === 'ARTICLE' || cur.tagName === 'MAIN') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isInsideExcludedContainer(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName;
      if (tag === 'FOOTER' && isContentFooter(cur)) {
        cur = cur.parentElement;
        continue;
      }
      if (tag && SK.SEMANTIC_CONTAINER_EXCLUDE_TAGS.has(tag)) return true;
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role && SK.EXCLUDE_ROLES.has(role)) return true;
      if (tag === 'HEADER' && role === 'banner') return true;
      if (cur.getAttribute && cur.getAttribute('contenteditable') === 'true') return true;
      if (role === 'textbox') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isInteractiveWidgetContainer(el) {
    if (!el.querySelector('button, [role="button"]')) return false;
    const textLen = (el.innerText || '').trim().length;
    if (textLen >= 300) return false;
    return true;
  }

  // v1.4.9 Case B helpers
  function hasBrChild(el) {
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') return true;
    }
    return false;
  }

  function directTextLength(el) {
    let total = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) total += child.nodeValue.trim().length;
    }
    return total;
  }

  // v1.4.14 Case C helper：BLOCK_TAGS_SET 元素有直接 CONTAINER_TAGS 子元素且各有候選文字時，
  // 不應整體收集，應 skip 讓 walker 下探讓子元素各自被收集。
  function hasContainerChildWithCandidateText(el) {
    for (const child of el.children) {
      if (SK.CONTAINER_TAGS.has(child.tagName) && isCandidateText(child)) return true;
    }
    return false;
  }

  // v1.4.14 Case C helper：確認有非 <a> 的 preservable inline 元素（STRONG/B/EM 等）。
  // 純連結導覽區（只有 <a>）不觸發，避免誤收 nav link div。
  function hasNonAnchorPreservableInline(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (n.tagName === 'A') continue;
      if (SK.HARD_EXCLUDE_TAGS.has(n.tagName)) continue;
      if (SK.isPreservableInline(n)) return true;
    }
    return false;
  }

  // ─── Fragment 抽取 ────────────────────────────────────

  function extractInlineFragments(el) {
    const fragments = [];
    const children = Array.from(el.childNodes);
    let runStart = null;
    let runEnd = null;

    const flushRun = () => {
      if (!runStart) return;
      let text = '';
      let n = runStart;
      while (n) {
        text += n.textContent || '';
        if (n === runEnd) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      // v1.2.0: 已翻譯成繁中的 fragment 不再重複收集
      // （fragment 注入後父元素不帶 data-shinkansen-translated，
      //   若不在此過濾，SPA observer rescan 會無限迴圈）
      if (trimmed.length >= 2 && SK.isTraditionalChinese(trimmed)) {
        runStart = null;
        runEnd = null;
        return;
      }
      if (/[A-Za-zÀ-ÿ\u0400-\u04FF\u3400-\u9fff0-9]/.test(text)) {
        fragments.push({
          kind: 'fragment',
          el,
          startNode: runStart,
          endNode: runEnd,
        });
      }
      runStart = null;
      runEnd = null;
    };

    for (const child of children) {
      if (SK.isInlineRunNode(child)) {
        if (!runStart) runStart = child;
        runEnd = child;
      } else {
        flushRun();
      }
    }
    flushRun();
    return fragments;
  }

  // ─── collectParagraphs ────────────────────────────────

  SK.collectParagraphs = function collectParagraphs(root, stats) {
    root = root || document.body;
    stats = stats || null;

    const results = [];
    const seen = new Set();
    const fragmentExtracted = new Set();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (SK.HARD_EXCLUDE_TAGS.has(el.tagName)) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.tagName === 'PRE' && el.querySelector('code')) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          if (stats) stats.alreadyTranslated = (stats.alreadyTranslated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // v1.1.9: 統一使用 BLOCK_TAGS_SET.has() 取代舊版 BLOCK_TAGS.includes()
        if (!SK.BLOCK_TAGS_SET.has(el.tagName)) {
          if (stats) stats.notBlockTag = (stats.notBlockTag || 0) + 1;
          // v1.4.7 / v1.4.9: 非 block-tag 容器（DIV、SECTION 等）的補抓邏輯。
          // 典型案例：XenForo <div class="bbWrapper">
          //   Case A: "intro"<br>"Pros:"<ul><li>...</li></ul>"Overall..."
          //   Case B: "段落一"<br><br>"段落二"
          // DIV 不在 BLOCK_TAGS_SET → 以前直接 FILTER_SKIP，text node 完全不可見。
          if (!fragmentExtracted.has(el) && !isInsideExcludedContainer(el)) {
            let hasDirectText = false;
            for (const child of el.childNodes) {
              if (child.nodeType === Node.TEXT_NODE && child.nodeValue.trim().length >= 2) {
                hasDirectText = true;
                break;
              }
            }
            if (hasDirectText && SK.containsBlockDescendant(el)) {
              // Case A (v1.4.7)：有 block 子孫 → 抽 inline fragment
              fragmentExtracted.add(el);
              const frags = extractInlineFragments(el);
              for (const f of frags) {
                results.push(f);
                seen.add(f.startNode);
                if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
              }
            } else if (
              // Case B (v1.4.9)：純文字 + BR、無 block 子孫 → 整體當 element 單元
              // 4 個條件全成立才匹配，避免誤抓 inline element / leaf-content-div / nav 短連結
              // / 麵包屑（每條對應一個既有 spec：detect-leaf-content-div /
              // detect-nav-anchor-threshold / detect-nav-content）
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              hasBrChild(el) &&
              directTextLength(el) >= 20 &&
              isCandidateText(el)
            ) {
              results.push({ kind: 'element', el });
              seen.add(el);
              if (stats) stats.containerWithBr = (stats.containerWithBr || 0) + 1;
            } else if (
              // Case C (v1.4.14)：wrapper div 只含 inline 格式元素（STRONG/B/EM 等），
              // 沒有直接 text node、沒有 BR、沒有 block 後代，但 innerText 有候選內容。
              // 結構特徵：CONTAINER_TAGS 元素其文字全部來自 preservable inline 子元素（非純連結）。
              // 常見於 vBulletin 的 <div class="smallfont"><strong>標題</strong></div>，
              // 若不在此收集，parent td 會把它跟其他內容合併成一個翻譯單元。
              SK.CONTAINER_TAGS.has(el.tagName) &&
              !seen.has(el) &&
              !hasBrChild(el) &&
              !hasDirectText &&
              hasNonAnchorPreservableInline(el) &&
              isCandidateText(el)
            ) {
              results.push({ kind: 'element', el });
              seen.add(el);
              if (stats) stats.inlineWrapperUnit = (stats.inlineWrapperUnit || 0) + 1;
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
        if (isInsideExcludedContainer(el)) {
          if (stats) stats.excludedContainer = (stats.excludedContainer || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!SK.WIDGET_CHECK_EXEMPT_TAGS.has(el.tagName) && isInteractiveWidgetContainer(el)) {
          if (stats) stats.interactiveWidget = (stats.interactiveWidget || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!SK.isVisible(el)) {
          if (stats) stats.invisible = (stats.invisible || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (SK.containsBlockDescendant(el)) {
          if (stats) stats.hasBlockDescendant = (stats.hasBlockDescendant || 0) + 1;
          if (!fragmentExtracted.has(el)) {
            fragmentExtracted.add(el);
            const frags = extractInlineFragments(el);
            for (const f of frags) {
              results.push(f);
              seen.add(f.startNode);
              if (stats) stats.fragmentUnit = (stats.fragmentUnit || 0) + 1;
            }
          }
          return NodeFilter.FILTER_SKIP;
        }
        // v1.4.14: 若 block 元素本身沒有 direct text，實質內容完全由 CONTAINER_TAGS
        // 子元素承載（例如 vBulletin <td> 含多個 <div>：標題 div + 內文 div），
        // skip 讓 walker 下探。否則 walker FILTER_ACCEPT 整個 block，
        // injection 的 media-preserving path 會把非最長 text 所在的 wrapper div 清掉。
        // 加 directTextLength 判斷是為了不誤傷「本身有段落文字 + 附帶 UI 小工具 div」
        // 的 block（例如 Medium 留言區 <pre>留言<div><button>more</button></div></pre>）。
        if (directTextLength(el) < 2 && hasContainerChildWithCandidateText(el)) {
          if (stats) stats.blockWithContainerChildren = (stats.blockWithContainerChildren || 0) + 1;
          return NodeFilter.FILTER_SKIP;
        }
        if (!isCandidateText(el)) {
          if (stats) stats.notCandidateText = (stats.notCandidateText || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (stats) stats.acceptedByWalker = (stats.acceptedByWalker || 0) + 1;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      results.push({ kind: 'element', el: node });
      seen.add(node);
    }

    // 補抓 selector 指定的特殊元素
    document.querySelectorAll(SK.INCLUDE_BY_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (isInsideExcludedContainer(el)) return;
      if (isInteractiveWidgetContainer(el)) return;
      if (!SK.isVisible(el)) return;
      if (!isCandidateText(el)) return;
      if (stats) stats.includedBySelector = (stats.includedBySelector || 0) + 1;
      results.push({ kind: 'element', el });
    });

    // v0.42: leaf content anchor 補抓
    document.querySelectorAll('a').forEach(a => {
      if (seen.has(a)) return;
      if (a.hasAttribute('data-shinkansen-translated')) return;
      let cur = a.parentElement;
      let hasBlockAncestor = false;
      while (cur && cur !== document.body) {
        if (SK.BLOCK_TAGS_SET.has(cur.tagName)) { hasBlockAncestor = true; break; }
        cur = cur.parentElement;
      }
      if (hasBlockAncestor) return;
      if (SK.containsBlockDescendant(a)) return;
      if (isInsideExcludedContainer(a)) return;
      if (isInteractiveWidgetContainer(a)) return;
      if (!SK.isVisible(a)) return;
      if (!isCandidateText(a)) return;
      const txt = (a.innerText || '').trim();
      if (txt.length < 20) return;
      if (stats) stats.leafContentAnchor = (stats.leafContentAnchor || 0) + 1;
      results.push({ kind: 'element', el: a });
      seen.add(a);
    });

    // v1.0.8: leaf content element 補抓（CSS-in-JS 框架）
    document.querySelectorAll('div, span').forEach(d => {
      if (seen.has(d)) return;
      if (d.hasAttribute('data-shinkansen-translated')) return;
      if (d.children.length > 0) return;
      let cur = d.parentElement;
      let hasBlockAncestor = false;
      while (cur && cur !== document.body) {
        if (SK.BLOCK_TAGS_SET.has(cur.tagName)) { hasBlockAncestor = true; break; }
        cur = cur.parentElement;
      }
      if (hasBlockAncestor) return;
      if (isInsideExcludedContainer(d)) return;
      if (isInteractiveWidgetContainer(d)) return;
      if (!SK.isVisible(d)) return;
      if (!isCandidateText(d)) return;
      const txt = (d.innerText || '').trim();
      if (txt.length < 20) return;
      if (stats) stats.leafContentDiv = (stats.leafContentDiv || 0) + 1;
      results.push({ kind: 'element', el: d });
      seen.add(d);
    });

    // v1.0.22: grid cell leaf text 補抓
    document.querySelectorAll('table[role="grid"] td').forEach(td => {
      const tdText = (td.innerText || '').trim();
      if (tdText.length < 20) return;
      if (td.hasAttribute('data-shinkansen-translated')) return;

      td.querySelectorAll('*').forEach(el => {
        if (seen.has(el)) return;
        if (el.hasAttribute('data-shinkansen-translated')) return;

        for (const child of el.children) {
          if ((child.innerText || '').trim().length >= 15) return;
        }

        const text = (el.innerText || '').trim();
        if (text.length < 15) return;

        if (!SK.isVisible(el)) return;
        if (!isCandidateText(el)) return;

        if (stats) stats.gridCellLeaf = (stats.gridCellLeaf || 0) + 1;
        results.push({ kind: 'element', el });
        seen.add(el);
      });
    });

    return results;
  };

  // ─── 術語表輸入萃取 ──────────────────────────────────

  SK.extractGlossaryInput = function extractGlossaryInput(units) {
    const parts = [];
    const title = document.title?.trim();
    if (title) parts.push(title);

    for (const unit of units) {
      const el = unit.kind === 'fragment' ? unit.parent : unit.el;
      if (!el) continue;
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      if (tag === 'FIGCAPTION' || tag === 'CAPTION') {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      const fullText = el.innerText?.trim();
      if (!fullText) continue;
      const sentenceMatch = fullText.match(/^[^.!?。！？]*[.!?。！？]/);
      const firstSentence = sentenceMatch ? sentenceMatch[0] : fullText.slice(0, 200);
      if (firstSentence.length >= 10) {
        parts.push(firstSentence);
      }
    }

    return parts.join('\n');
  };

})(window.__SK);
