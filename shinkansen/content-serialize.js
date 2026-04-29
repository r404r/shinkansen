// content-serialize.js — Shinkansen 佔位符序列化/反序列化
// 負責把段落內的 inline 元素轉成 ⟦N⟧…⟦/N⟧ 佔位符（序列化），
// 以及把含佔位符的譯文還原成 DocumentFragment（反序列化）。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）

  const PH_OPEN = SK.PH_OPEN;
  const PH_CLOSE = SK.PH_CLOSE;

  // ─── 序列化 ───────────────────────────────────────────

  SK.serializeWithPlaceholders = function serializeWithPlaceholders(el) {
    return serializeNodeIterable(el.childNodes);
  };

  // ─── Google Translate 專用序列化 ──────────────────────
  // 只標記 <a> 連結（用【N】/【/N】）與 atomic 元素（用【*N】），
  // 其他 span/b/i/abbr 直接遞迴取文字（不加標記）。
  // 這樣送給 Google MT 的標記數量極少（通常 2-4 個），
  // 避免過多標記導致 Google MT 位置錯亂。
  //
  // 為什麼用【】而不用⟦⟧：⟦⟧ 是數學符號，Google MT 視為可翻譯符號會亂移；
  // 【】是 CJK 標點，Google MT 原樣保留且維持正確前後順序。
  //
  // 回傳的 text 可直接送 Google MT；結果還原時用
  // SK.restoreGoogleTranslateMarkers(tr) 把【N】換回⟦N⟧再走現有 deserialization。

  // v1.8.13: paired marker 數量上限。Google Translate 非官方端點對同段內
  // 「【N】xxx【/N】」配對標記超過 5 個時會 hallucinate(把標記當 list 結構
  // 亂吐 garbage tokens,典型症狀:譯文殘留「[/5】[/5]【6】【6】」「/Proad】」
  // 這類 garbage)。實 fetch 驗:3-5 對都 OK、6 對開始壞、8 對完全爛。
  // 觸發場景:Medium 作者 byline「socials: <a>YouTube</a> | <a>TikTok</a> |
  // ...」這類大量短 <a> 列表。超過閾值時改走「不加 paired marker、純取文字」
  // 退化路徑,該段失去 <a> 連結保留(anchor text 變純文字)但譯文不會壞掉。
  // Atomic 標記(【*N】)不受影響——probe 顯示連 8 個 atomic 都不會亂。
  const GT_MAX_PAIRED_SLOTS = 5;

  function countPairedInlineForGT(topLevelNodes) {
    let count = 0;
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
        if (SK.isAtomicPreserve(child)) continue;
        if (SK.GT_INLINE_TAGS.has(child.tagName)) {
          count++;
          if (count > GT_MAX_PAIRED_SLOTS) return;
        }
        walk(child.childNodes);
        if (count > GT_MAX_PAIRED_SLOTS) return;
      }
    }
    walk(topLevelNodes);
    return count;
  }

  function serializeNodeIterableForGoogle(topLevelNodes) {
    const slots = [];
    let out = '';
    // v1.8.13: paired marker 過閾值 → 降級為純文字模式(slots 仍可含
    // atomic,但不再產生 paired【N】/【/N】標記)。
    const degrade = countPairedInlineForGT(topLevelNodes) > GT_MAX_PAIRED_SLOTS;
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          if (child.tagName === 'BR') { out += '\u0001'; continue; }
          // Atomic 元素（footnote sup 等）→ 單一標記，不翻內容
          if (SK.isAtomicPreserve(child)) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += '【*' + idx + '】';
            continue;
          }
          // 語意行內標籤 → 配對標記（保留格式）
          // 包含 <a>（連結）與 <b>/<i>/<small> 等語意格式標籤。
          // 刻意排除 <span>：SPAN 是最常見的爆炸來源（Wikipedia lede 有 10+ 個
          // span.class，會讓 Google MT 位置錯亂）。<abbr> 也排除（樣式用途為主）。
          // v1.8.13: degrade 模式下 GT_INLINE_TAGS 也走純文字路徑(不加標記)。
          if (!degrade && SK.GT_INLINE_TAGS.has(child.tagName)) {
            const idx = slots.length;
            slots.push(child.cloneNode(false));
            out += '【' + idx + '】';
            walk(child.childNodes);
            out += '【/' + idx + '】';
            continue;
          }
          // SPAN、ABBR 及其他非語意元素 → 只取文字，不加標記
          walk(child.childNodes);
        }
      }
    }
    walk(topLevelNodes);
    const normalized = out
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/\u0001{3,}/g, '\u0001\u0001')
      .replace(/\u0001/g, '\n')
      .trim();
    return { text: normalized, slots };
  }

  SK.serializeForGoogleTranslate = function serializeForGoogleTranslate(el) {
    return serializeNodeIterableForGoogle(el.childNodes);
  };

  SK.serializeFragmentForGoogleTranslate = function serializeFragmentForGoogleTranslate(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    return serializeNodeIterableForGoogle(nodes);
  };

  // 將 Google MT 回傳的【N】/【/N】/【*N】換回⟦N⟧/⟦/N⟧/⟦*N⟧，
  // 交給現有 deserializeWithPlaceholders 處理。
  SK.restoreGoogleTranslateMarkers = function restoreGoogleTranslateMarkers(s) {
    return s
      .replace(/【\*(\d+)】/g, PH_OPEN + '*$1' + PH_CLOSE)
      .replace(/【(\d+)】/g,   PH_OPEN + '$1'  + PH_CLOSE)
      .replace(/【\/(\d+)】/g, PH_OPEN + '/$1' + PH_CLOSE);
  };

  SK.serializeFragmentWithPlaceholders = function serializeFragmentWithPlaceholders(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    return serializeNodeIterable(nodes);
  };

  function serializeNodeIterable(topLevelNodes) {
    const slots = [];
    let out = '';
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          if (child.tagName === 'PRE' && child.querySelector('code')) continue;
          if (child.tagName === 'BR') {
            out += '\u0001';
            continue;
          }
          if (SK.isAtomicPreserve(child)) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += PH_OPEN + '*' + idx + PH_CLOSE;
            continue;
          }
          if (SK.isPreservableInline(child)) {
            const idx = slots.length;
            const shell = child.cloneNode(false);
            slots.push(shell);
            out += PH_OPEN + idx + PH_CLOSE;
            walk(child.childNodes);
            out += PH_OPEN + '/' + idx + PH_CLOSE;
          } else {
            walk(child.childNodes);
          }
        }
      }
    }
    walk(topLevelNodes);
    const normalized = out
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/\u0001{3,}/g, '\u0001\u0001')
      .replace(/\u0001/g, '\n')
      .trim();
    return { text: normalized, slots };
  }

  // ─── 反序列化輔助函式 ─────────────────────────────────

  SK.collapseCjkSpacesAroundPlaceholders = function collapseCjkSpacesAroundPlaceholders(s) {
    if (!s) return s;
    const C = SK.CJK_CHAR;
    // 注意：用 [ \t]+ 而非 \s+，刻意保留 \n 不移除。
    // \n 代表原文有 <br> 換行（序列化時 <br> → \u0001 → \n），
    // 若用 \s+ 會把 ⟦/N⟧\n漢字 的 \n 吃掉，導致 <br> 無法還原（v1.4.4 修正）。
    s = s.replace(
      new RegExp('(' + C + ')[ \\t]+(' + PH_OPEN + '\\d+' + PH_CLOSE + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + PH_OPEN + '\\/\\d+' + PH_CLOSE + ')[ \\t]+(' + C + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + C + ')[ \\t]+(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')[ \\t]+(' + C + ')', 'g'),
      '$1$2'
    );
    return s;
  };

  SK.stripStrayPlaceholderMarkers = function stripStrayPlaceholderMarkers(s) {
    s = s.replace(new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'), '');
    s = s.replace(new RegExp('[\\*\\/]\\d+' + PH_CLOSE, 'g'), '');
    s = s.replace(new RegExp('[' + PH_OPEN + PH_CLOSE +
      SK.BRACKET_ALIASES_OPEN.join('') + SK.BRACKET_ALIASES_CLOSE.join('') + ']', 'g'), '');
    return s;
  };

  SK.normalizeLlmPlaceholders = function normalizeLlmPlaceholders(s) {
    if (!s) return s;
    for (const alias of SK.BRACKET_ALIASES_OPEN) {
      if (s.includes(alias)) s = s.split(alias).join(PH_OPEN);
    }
    for (const alias of SK.BRACKET_ALIASES_CLOSE) {
      if (s.includes(alias)) s = s.split(alias).join(PH_CLOSE);
    }
    // 若模型在佔位符標記內插入了多餘描述（如 ⟦0 drug⟧ → ⟦0⟧、⟦/0 drug⟧ → ⟦/0⟧），
    // 只保留前綴符號（*/?) 與數字，丟棄多餘文字。
    // 觸發情境：slot 內容涉及醫藥 / 術語時，模型會「加注」slot 代表的類別
    // （例如 ⟦0⟧ 對應 <strong>ファーストエイド用品（鎮痛剤...）</strong>，輸出 ⟦0 drug⟧）。
    // 修法：匹配「數字後有空白 + 非空白文字」的 pattern，統一清除（v1.4.5 修正）。
    s = s.replace(
      new RegExp(PH_OPEN + '\\s*(\\*?\\/?\\d+)[ \\t]+\\S[^' + PH_CLOSE + ']{0,28}' + PH_CLOSE, 'g'),
      PH_OPEN + '$1' + PH_CLOSE
    );
    return s.replace(
      new RegExp(PH_OPEN + '\\s*(\\*?\\/?\\d+)\\s*' + PH_CLOSE, 'g'),
      PH_OPEN + '$1' + PH_CLOSE
    );
  };

  SK.selectBestSlotOccurrences = function selectBestSlotOccurrences(text) {
    if (!text) return text;
    const re = new RegExp(PH_OPEN + '(\\d+)' + PH_CLOSE + '([\\s\\S]*?)' + PH_OPEN + '\\/\\1' + PH_CLOSE, 'g');
    const occurrences = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[2];
      const innerStripped = inner.replace(new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'), '').trim();
      occurrences.push({
        idx: Number(m[1]),
        start: m.index,
        end: m.index + m[0].length,
        inner: inner,
        nonEmpty: innerStripped.length > 0,
      });
    }
    if (occurrences.length === 0) return text;
    const byIdx = new Map();
    for (const o of occurrences) {
      if (!byIdx.has(o.idx)) byIdx.set(o.idx, []);
      byIdx.get(o.idx).push(o);
    }
    const losers = [];
    let dupSlotCount = 0;
    for (const [, list] of byIdx) {
      if (list.length === 1) continue;
      dupSlotCount++;
      let winner = list.find(o => o.nonEmpty);
      if (!winner) winner = list[0];
      for (const o of list) if (o !== winner) losers.push(o);
    }
    if (losers.length === 0) return text;
    losers.sort((a, b) => b.start - a.start);
    let out = text;
    for (const l of losers) {
      out = out.slice(0, l.start) + l.inner + out.slice(l.end);
    }
    SK.sendLog('info', 'translate', 'graceful dedup: dup_slots=' + dupSlotCount +
      ' losers_demoted=' + losers.length +
      ' preview=' + JSON.stringify(out.slice(0, 200)));
    return out;
  };

  // ─── 反序列化 ─────────────────────────────────────────

  SK.deserializeWithPlaceholders = function deserializeWithPlaceholders(translation, slots) {
    if (!translation) {
      return { frag: document.createDocumentFragment(), ok: false, matched: 0 };
    }

    translation = SK.normalizeLlmPlaceholders(translation);

    // v1.4.6 修正：Gemini 有時把換行指令解讀為「輸出字面 \n（反斜線 + n）」
    // 而非真正的換行符（U+000A）。pushText 用 clean.includes('\n') 偵測換行，
    // 字面 \n（兩字元：0x5C 0x6E）無法觸發，導致「\n」以兩個可見字元殘留 DOM。
    // 修法：在此統一把字面 \n（兩字元）轉換為真正換行符，再繼續後續流程。
    if (translation.includes('\\n')) {
      translation = translation.replace(/\\n/g, '\n');
    }

    translation = SK.collapseCjkSpacesAroundPlaceholders(translation);
    translation = SK.selectBestSlotOccurrences(translation);

    const matchedRef = { count: 0 };
    const frag = parseSegment(translation, slots, matchedRef);
    const ok = matchedRef.count > 0;
    return { frag, ok, matched: matchedRef.count };
  };

  function parseSegment(text, slots, matchedRef) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    const re = new RegExp(
      PH_OPEN + '(\\d+)' + PH_CLOSE + '([\\s\\S]*?)' + PH_OPEN + '\\/\\1' + PH_CLOSE
        + '|' + PH_OPEN + '\\*(\\d+)' + PH_CLOSE,
      'g'
    );

    function pushText(s) {
      if (!s) return;
      const clean = SK.stripStrayPlaceholderMarkers(s);
      if (!clean) return;
      if (clean.includes('\n')) {
        const parts = clean.split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) frag.appendChild(document.createTextNode(parts[i]));
          if (i < parts.length - 1) frag.appendChild(document.createElement('br'));
        }
      } else {
        frag.appendChild(document.createTextNode(clean));
      }
    }

    let cursor = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > cursor) {
        pushText(text.slice(cursor, m.index));
      }
      if (m[3] !== undefined) {
        const idx = Number(m[3]);
        const slot = slots[idx];
        if (slot && slot.atomic && slot.node) {
          frag.appendChild(slot.node.cloneNode(true));
          matchedRef.count++;
        }
      } else {
        const idx = Number(m[1]);
        const inner = m[2];
        const slot = slots[idx];
        if (slot && slot.nodeType === Node.ELEMENT_NODE) {
          const shell = slot.cloneNode(false);
          const innerFrag = parseSegment(inner, slots, matchedRef);
          shell.appendChild(innerFrag);
          frag.appendChild(shell);
          matchedRef.count++;
        } else if (slot && slot.atomic && slot.node) {
          frag.appendChild(slot.node.cloneNode(true));
          matchedRef.count++;
        } else {
          const innerFrag = parseSegment(inner, slots, matchedRef);
          frag.appendChild(innerFrag);
        }
      }
      cursor = m.index + m[0].length;
    }
    if (cursor < text.length) {
      pushText(text.slice(cursor));
    }
    return frag;
  }

})(window.__SK);
