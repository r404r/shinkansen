// content-ns.js — Shinkansen 命名空間、共用狀態、常數、工具函式
// 這是 content script 拆分後的第一個檔案，建立 window.__SK 命名空間，
// 後續子模組透過 (function(SK) { ... })(window.__SK) 存取共用資源。
// 注意：content script 不支援 ES module import，所有邏輯透過全域命名空間共用。

// Safari / Firefox 相容性 shim（v1.3.16）
// content script 不能 import ES module，改用全域方式讓後續所有 content script 繼承。
globalThis.browser = globalThis.browser ?? globalThis.chrome;

if (window.__shinkansen_loaded) {
  // 防止重複載入（SPA 框架可能重新注入 content script）
} else {
  window.__shinkansen_loaded = true;

  // ─── 命名空間初始化 ─────────────────────────────────────
  window.__SK = {};
  const SK = window.__SK;

  // ─── 共用狀態 ──────────────────────────────────────────
  SK.STATE = {
    translated: false,
    translatedBy: null,      // v1.4.0: 'gemini' | 'google' | null
    translating: false,      // v0.80: 翻譯進行中（防止重複觸發 + 支援中途取消）
    abortController: null,   // v0.80: AbortController，翻譯中按 Alt+S 或離開頁面時 abort
    cache: new Map(),       // 段落文字 → 譯文
    // 記錄每個被替換過的元素與它原本的子節點快照，供還原使用。
    // v0.36 起改為 Map，key 是 element，value 是 child node snapshot。這樣同一個
    // element 被多個 fragment 單位改動時，只會快照一次「真正的原始 HTML」，
    // 不會被後續 fragment 的中途狀態污染。
    originalHTML: new Map(), // el → Node[]
    // v1.0.14: 儲存翻譯後的子節點快照，用於偵測框架覆寫並重新套用。
    translatedHTML: new Map(), // el → Node[]
    // v1.0.23: 續翻模式
    stickyTranslate: false,
    // v1.4.12: 記錄本次翻譯使用的 preset slot（1/2/3），供 SPA 導航續翻 + 跨 tab sticky 用。
    // null = 非 preset 觸發（例如 autoTranslate 白名單、popup 按鈕舊路徑）。
    stickySlot: null,
  };

  // v1.4.12: content script 在 storage.sync.translatePresets 尚未寫入時的 fallback
  // （例如從 v1.4.11 升級但使用者還未開過設定頁 / onInstalled 沒觸發）。
  // 內容必須與 lib/storage.js DEFAULT_SETTINGS.translatePresets 保持一致。
  SK.DEFAULT_PRESETS = [
    { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite-preview', label: 'Flash Lite' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ];

  // ─── v0.88: 統一 Log 系統 ─────────────────────────────
  SK.sendLog = function sendLog(level, category, message, data) {
    try {
      browser.runtime.sendMessage({
        type: 'LOG',
        payload: { level, category, message, data },
      }).catch(() => {}); // fire-and-forget
    } catch { /* 靜默 */ }
  };

  SK.cloneChildSnapshot = function cloneChildSnapshot(el) {
    return Array.from(el.childNodes, node => node.cloneNode(true));
  };

  SK.restoreChildSnapshot = function restoreChildSnapshot(el, snapshot) {
    el.replaceChildren(...snapshot.map(node => node.cloneNode(true)));
  };

  SK.childSnapshotEquals = function childSnapshotEquals(el, snapshot) {
    if (el.childNodes.length !== snapshot.length) return false;
    for (let i = 0; i < snapshot.length; i++) {
      if (!el.childNodes[i].isEqualNode(snapshot[i])) return false;
    }
    return true;
  };

  // ─── 共用常數 ──────────────────────────────────────────

  // Block-level 標籤集合（v1.1.9 統一為 Set，移除舊版 Array 重複定義）
  SK.BLOCK_TAGS_SET = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'DD', 'DT',
    'FIGCAPTION', 'CAPTION', 'TH', 'TD',
    'SUMMARY',
    'PRE',     // v1.0.8: 從 HARD_EXCLUDE_TAGS 移來
    'FOOTER',  // v1.0.9: 內容 footer 需要被 walker 接受
  ]);

  // querySelector 用的 block tag 選擇器字串（預先組好，containsBlockDescendant 用）
  SK.BLOCK_TAG_SELECTOR = Array.from(SK.BLOCK_TAGS_SET).join(',');

  // v1.4.9: 「container-like」非 BLOCK_TAGS_SET 的 tag——可能扮演段落容器角色，
  // 與 inline element（A/SPAN/B/I/...）區分。BBCode Case B 的 DIV 偵測用此白名單，
  // 避免誤抓 inline 元素內的短文字。
  SK.CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE']);

  // 直接排除（純技術性元素）
  SK.HARD_EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT',
  ]);

  // 語意容器排除
  SK.SEMANTIC_CONTAINER_EXCLUDE_TAGS = new Set(['FOOTER']);

  // ARIA role 排除
  SK.EXCLUDE_ROLES = new Set(['banner', 'contentinfo', 'search', 'grid']);

  // 豁免 isInteractiveWidgetContainer 檢查的標籤
  SK.WIDGET_CHECK_EXEMPT_TAGS = new Set([
    'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);

  // 補抓 selector
  SK.INCLUDE_BY_SELECTOR = [
    '#siteSub',
    '#contentSub',
    '#contentSub2',
    '#coordinates',
    '.hatnote',
    '.mw-redirectedfrom',
    '.dablink',
    '[role="note"]',
    '.thumbcaption',
    '[data-testid="tweetText"]',
    '[data-testid="card.layoutLarge.detail"] > div',
    '[data-testid="card.layoutSmall.detail"] > div',
    '.wp-block-post-navigation-link',
  ].join(',');

  // ─── Placeholder 協定常數 ─────────────────────────────
  SK.PH_OPEN = '\u27E6';   // ⟦
  SK.PH_CLOSE = '\u27E7';  // ⟧

  // 需要保留外殼的 inline tag
  SK.PRESERVE_INLINE_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'MARK', 'U', 'S',
    'SUB', 'SUP', 'KBD', 'ABBR', 'CITE', 'Q', 'SMALL',
    'DEL', 'INS', 'VAR', 'SAMP', 'TIME',
  ]);

  // Google Translate 專用行內標籤白名單（加標記保留外殼）
  // 刻意排除 SPAN（最常見的亂碼來源）、ABBR（純樣式用途）
  SK.GT_INLINE_TAGS = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'SMALL', 'U', 'S',
    'SUB', 'SUP', 'MARK', 'DEL', 'INS', 'CITE', 'Q',
  ]);

  // LLM 替代括號字元
  SK.BRACKET_ALIASES_OPEN = ['\u2770'];  // ❰
  SK.BRACKET_ALIASES_CLOSE = ['\u2771']; // ❱

  // ─── 翻譯流程常數 ─────────────────────────────────────
  // 注意：content script 無法 import ES module，以下兩個值鏡像 lib/constants.js，
  // 修改時必須同步更新 lib/constants.js（lib/gemini.js 與 lib/storage.js 的單一來源）。
  SK.DEFAULT_UNITS_PER_BATCH = 12;
  SK.DEFAULT_CHARS_PER_BATCH = 3500;
  SK.DEFAULT_MAX_CONCURRENT = 10;
  SK.DEFAULT_MAX_TOTAL_UNITS = 1000;

  // SPA 動態載入常數
  SK.SPA_OBSERVER_DEBOUNCE_MS = 1000;
  SK.SPA_OBSERVER_MAX_RESCANS = Infinity;
  SK.SPA_OBSERVER_MAX_UNITS = 50;
  SK.SPA_NAV_SETTLE_MS = 800;

  // 術語表常數
  SK.GLOSSARY_SKIP_THRESHOLD_DEFAULT = 1;
  SK.GLOSSARY_BLOCKING_THRESHOLD_DEFAULT = 5;
  SK.GLOSSARY_TIMEOUT_DEFAULT = 60000;

  // Rescan 常數
  SK.RESCAN_DELAYS_MS = [1200, 3000];

  // CJK 字元匹配 pattern（serialize 用）
  SK.CJK_CHAR = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';

  // ─── 共用工具函式 ──────────────────────────────────────

  /** SHA-1 hash（content script 版本，不依賴 ES module import） */
  SK.sha1 = async function sha1(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  };

  // 過濾隱藏元素
  SK.isVisible = function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'BODY') return true;
    if (el.offsetParent === null) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  };

  // 是否含有需要保留的媒體元素
  SK.containsMedia = function containsMedia(el) {
    return !!el.querySelector('img, picture, video, svg, canvas, audio');
  };

  // 是否含有 block 後代（v1.1.9 重構：用 querySelector 取代 getElementsByTagName 迴圈）
  SK.containsBlockDescendant = function containsBlockDescendant(el) {
    return !!el.querySelector(SK.BLOCK_TAG_SELECTOR);
  };

  // 內容是否「有實質文字」
  SK.hasSubstantiveContent = function hasSubstantiveContent(el) {
    const txt = (el.innerText || el.textContent || '');
    return /[A-Za-zÀ-ÿ\u0400-\u04FF\u3400-\u9fff0-9]/.test(txt);
  };

  // 「原子保留」子樹
  SK.isAtomicPreserve = function isAtomicPreserve(el) {
    if (el.tagName === 'SUP' && el.classList && el.classList.contains('reference')) return true;
    // v1.4.10: <hr> 是區塊分隔線，序列化時保留為 ⟦*N⟧，避免 clean slate 注入後丟失
    if (el.tagName === 'HR') return true;
    return false;
  };

  // SPAN 通常是樣式 hook,只在帶 class 或 inline style 時才保留
  SK.isPreservableInline = function isPreservableInline(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;
    if (tag === 'SUP' && el.classList && el.classList.contains('reference')) return false;
    let matchesTag = false;
    if (SK.PRESERVE_INLINE_TAGS.has(tag)) {
      matchesTag = true;
    } else if (tag === 'SPAN') {
      if (el.hasAttribute('class')) matchesTag = true;
      else {
        const style = el.getAttribute('style');
        if (style && style.trim()) matchesTag = true;
      }
    }
    if (!matchesTag) return false;
    if (!SK.hasSubstantiveContent(el)) return false;
    return true;
  };

  // 段落內是否有任何需要保留的 inline 元素
  SK.hasPreservableInline = function hasPreservableInline(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (SK.HARD_EXCLUDE_TAGS.has(n.tagName)) continue;
      if (SK.isAtomicPreserve(n)) return true;
      if (SK.isPreservableInline(n)) return true;
    }
    return false;
  };

  // 判斷一個 node 是否可以納入 inline-run
  SK.isInlineRunNode = function isInlineRunNode(child) {
    if (child.nodeType === Node.TEXT_NODE) return true;
    if (child.nodeType !== Node.ELEMENT_NODE) return false;
    if (SK.HARD_EXCLUDE_TAGS.has(child.tagName)) return false;
    if (SK.BLOCK_TAGS_SET.has(child.tagName)) return false;
    if (SK.containsBlockDescendant(child)) return false;
    return true;
  };

  /**
   * 收集可見的文字節點（過濾技術節點與隱藏祖先）。
   * 用於 inject 路徑的「最長文字節點就地替換」。
   */
  SK.collectVisibleTextNodes = function collectVisibleTextNodes(el) {
    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== el) {
          if (SK.HARD_EXCLUDE_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.tagName === 'PRE' && p.querySelector('code')) return NodeFilter.FILTER_REJECT;
          const cs = p.ownerDocument?.defaultView?.getComputedStyle?.(p);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.trim()) textNodes.push(n);
    }
    return textNodes;
  };

  SK.findLongestTextNode = function findLongestTextNode(textNodes) {
    let main = textNodes[0];
    for (const t of textNodes) {
      if (t.nodeValue.length > main.nodeValue.length) main = t;
    }
    return main;
  };
}
