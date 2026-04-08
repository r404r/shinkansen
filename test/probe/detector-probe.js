// =====================================================================
// detector-probe.js — Shinkansen v0.28 段落偵測邏輯之鏡像副本
// =====================================================================
//
// ⚠️  DRIFT 警告 ⚠️
//
// 這份檔案是 shinkansen/content.js (v0.28) 段落偵測邏輯的「複製品」，
// 不是 import。content.js 改了之後這裡不會自動跟著動，會 drift。
//
// 為什麼要複製：
//   content script 不能 ES module import，且 v0.28 的 content.js 沒有
//   暴露 window.__shinkansen 之類的 debug API 可以從測試端呼叫。
//   為了不動 v0.28 程式碼，先複製一份偵測邏輯到測試端。
//
// 計畫廢棄時機：
//   下一輪改 content.js 時（v0.29 或 v0.30），會在 content.js 裡加上
//   window.__shinkansen.collectParagraphs() 之類的 debug API，
//   然後刪掉這個檔案，改由測試直接呼叫 extension 的真實函式。
//
// 內容範圍（最小集合）：
//   - 常數：BLOCK_TAGS / HARD_EXCLUDE_TAGS / SEMANTIC_CONTAINER_EXCLUDE_TAGS
//           / EXCLUDE_ROLES / INCLUDE_BY_SELECTOR / BLOCK_TAGS_SET
//   - 函式：isInsideExcludedContainer / isCandidateText
//           / containsBlockDescendant / containsMedia / isVisible
//           / collectParagraphs
//   - 不複製：PRESERVE_INLINE_TAGS、placeholder 序列化、Gemini 呼叫、
//             快取、Toast、DOM 注入、還原邏輯。
//
// 以下程式碼若需要修正，請同步檢查 shinkansen/content.js v0.28
// 第 214–592 行附近的對應段落。
// =====================================================================

(function () {
  'use strict';

  // ─── 常數 (mirror of content.js v0.28) ──────────────────────────────
  const BLOCK_TAGS = [
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'DD', 'DT',
    'FIGCAPTION', 'CAPTION', 'TH', 'TD',
    'SUMMARY',
  ];
  const BLOCK_TAGS_SET = new Set(BLOCK_TAGS);

  const HARD_EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT',
    'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT',
  ]);

  const SEMANTIC_CONTAINER_EXCLUDE_TAGS = new Set(['NAV', 'FOOTER']);
  const EXCLUDE_ROLES = new Set(['banner', 'navigation', 'contentinfo', 'search']);

  const INCLUDE_BY_SELECTOR = [
    '#siteSub',
    '#contentSub',
    '#contentSub2',
    '#coordinates',
    '.hatnote',
    '.mw-redirectedfrom',
    '.dablink',
    '[role="note"]',
    '.thumbcaption',
  ].join(',');

  // ─── 判斷函式 (mirror) ──────────────────────────────────────────────
  function isInsideExcludedContainer(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName;
      if (tag && SEMANTIC_CONTAINER_EXCLUDE_TAGS.has(tag)) return true;
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role && EXCLUDE_ROLES.has(role)) return true;
      if (tag === 'HEADER' && role === 'banner') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isCandidateText(el) {
    const text = el.innerText && el.innerText.trim();
    if (!text || text.length < 2) return false;
    if (!/[A-Za-zÀ-ÿ\u0400-\u04FF]/.test(text)) return false;
    return true;
  }

  function containsBlockDescendant(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (BLOCK_TAGS_SET.has(all[i].tagName)) return true;
    }
    return false;
  }

  function containsMedia(el) {
    return !!el.querySelector('img, picture, video, svg, canvas, audio');
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'BODY') return true;
    if (el.offsetParent === null) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    const style = el.ownerDocument && el.ownerDocument.defaultView
      && el.ownerDocument.defaultView.getComputedStyle
      && el.ownerDocument.defaultView.getComputedStyle(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  }

  // ─── 收集器（含統計） ────────────────────────────────────────────────
  // 與 content.js collectParagraphs 同邏輯，但額外記錄被跳過的原因，
  // 方便測試端 dump 出結構化偵錯資訊。
  function collectParagraphsWithStats(root) {
    root = root || document.body;
    const results = [];
    const seen = new Set();
    const skipped = {
      hardExcludeTag: 0,
      alreadyTranslated: 0,
      notBlockTag: 0,
      excludedContainer: 0,
      invisible: 0,
      hasBlockDescendant: 0,
      notCandidateText: 0,
    };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (HARD_EXCLUDE_TAGS.has(el.tagName)) {
          skipped.hardExcludeTag++;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          skipped.alreadyTranslated++;
          return NodeFilter.FILTER_REJECT;
        }
        if (!BLOCK_TAGS_SET.has(el.tagName)) {
          skipped.notBlockTag++;
          return NodeFilter.FILTER_SKIP;
        }
        if (isInsideExcludedContainer(el)) {
          skipped.excludedContainer++;
          return NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(el)) {
          skipped.invisible++;
          return NodeFilter.FILTER_REJECT;
        }
        if (containsBlockDescendant(el)) {
          skipped.hasBlockDescendant++;
          return NodeFilter.FILTER_SKIP;
        }
        if (!isCandidateText(el)) {
          skipped.notCandidateText++;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      results.push(node);
      seen.add(node);
    }

    // INCLUDE_BY_SELECTOR 補抓
    let selectorAdded = 0;
    document.querySelectorAll(INCLUDE_BY_SELECTOR).forEach((el) => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (isInsideExcludedContainer(el)) return;
      if (!isVisible(el)) return;
      if (!isCandidateText(el)) return;
      results.push(el);
      seen.add(el);
      selectorAdded++;
    });

    return { elements: results, skipped, selectorAdded };
  }

  // ─── 序列化：把元素轉成可 JSON 的描述 ───────────────────────────────
  function buildSelectorPath(el) {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        part += '#' + cur.id;
        parts.unshift(part);
        break;
      }
      const cls = (cur.getAttribute('class') || '')
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) part += '.' + cls.join('.');
      parts.unshift(part);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  function describe(el, index) {
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
    return {
      index,
      tag: el.tagName,
      textLength: text.length,
      preview: text.slice(0, 80),
      hasMedia: containsMedia(el),
      selectorPath: buildSelectorPath(el),
    };
  }

  function run() {
    const t0 = performance.now();
    const { elements, skipped, selectorAdded } = collectParagraphsWithStats();
    const elapsedMs = +(performance.now() - t0).toFixed(2);

    return {
      probeVersion: 'mirror-of-v0.28',
      url: location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      elapsedMs,
      counts: {
        total: elements.length,
        fromTreeWalker: elements.length - selectorAdded,
        fromIncludeBySelector: selectorAdded,
      },
      skipped,
      units: elements.map(describe),
    };
  }

  // 暴露給 Playwright 注入後呼叫
  window.__shinkansenProbe = { run };
})();
