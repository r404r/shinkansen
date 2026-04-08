// content.js — Shinkansen Content Script
// 職責：段落偵測、呼叫 background 翻譯、插入雙語顯示、Toast 提示。
// 注意：content script 不支援 ES module import，所有邏輯必須自包含。

(() => {
  if (window.__shinkansen_loaded) return;
  window.__shinkansen_loaded = true;

  const STATE = {
    translated: false,
    cache: new Map(),       // 段落文字 → 譯文
    // 記錄每個被替換過的元素與它原本的 innerHTML，供還原使用
    replaced: [],           // [{ el, originalHTML }]
  };

  // ─── Toast 提示 （Shadow DOM 隔離） ─────────────────────
  const toastHost = document.createElement('div');
  toastHost.id = 'shinkansen-toast-host';
  toastHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host, * { box-sizing: border-box; }
      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        width: 280px;
        padding: 14px 16px 12px 16px;
        background: #ffffff;
        color: #1d1d1f;
        border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,.18);
        font: 13px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      .toast.show { display: flex; }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .msg {
        flex: 1;
        font-weight: 500;
        color: #1d1d1f;
      }
      .detail {
        font-size: 12px;
        color: #6e6e73;
        font-variant-numeric: tabular-nums;
        margin-top: -2px;
      }
      .detail[hidden] { display: none; }
      .timer {
        font-variant-numeric: tabular-nums;
        color: #86868b;
        font-size: 12px;
      }
      .close {
        cursor: pointer;
        background: none; border: 0;
        font-size: 18px; line-height: 1;
        color: #86868b;
        padding: 0 2px;
      }
      .close:hover { color: #1d1d1f; }
      .bar {
        position: relative;
        height: 4px;
        width: 100%;
        background: #e8e8ed;
        border-radius: 2px;
        overflow: hidden;
      }
      .bar-fill {
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 0%;
        background: #0071e3;
        border-radius: 2px;
        transition: width .3s ease;
      }
      /* loading 狀態：沒有確定進度時，用流動動畫 */
      .toast.indeterminate .bar-fill {
        width: 30%;
        animation: slide 1.4s ease-in-out infinite;
      }
      @keyframes slide {
        0%   { left: -30%; }
        100% { left: 100%; }
      }
      .toast.success .bar-fill { background: #34c759; width: 100%; }
      .toast.error   .bar-fill { background: #ff3b30; width: 100%; }
    </style>
    <div class="toast" id="toast">
      <div class="row">
        <span class="msg" id="msg">翻譯中…</span>
        <span class="timer" id="timer"></span>
        <button class="close" id="close" title="關閉">×</button>
      </div>
      <div class="detail" id="detail" hidden></div>
      <div class="bar"><div class="bar-fill" id="fill"></div></div>
    </div>
  `;
  document.documentElement.appendChild(toastHost);
  const toastEl = shadow.getElementById('toast');
  const toastMsgEl = shadow.getElementById('msg');
  const toastDetailEl = shadow.getElementById('detail');
  const toastTimerEl = shadow.getElementById('timer');
  const toastFillEl = shadow.getElementById('fill');
  shadow.getElementById('close').addEventListener('click', () => hideToast());
  let toastTickHandle = null;
  let toastStartTime = 0;
  // 待定的 hide setTimeout；後續任何 showToast 都會清掉它，
  // 避免舊 toast 的 autoHide 把新 toast 也一起關掉。
  let toastHideHandle = null;

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    return m + ' 分 ' + (s % 60) + ' 秒';
  }

  // token 數字加千分位
  function formatTokens(n) {
    return n.toLocaleString('en-US');
  }

  // USD 費用格式化：小費用保留小數點後 4 位，大費用 2 位
  function formatUSD(n) {
    if (!n) return '$0';
    if (n < 0.01)  return '$' + n.toFixed(4);
    if (n < 1)     return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }

  /**
   * kind: 'loading' | 'success' | 'error'
   * opts: { progress?, startTimer?, stopTimer?, autoHideMs?, detail? }
   *   - detail: 顯示在主訊息下方的小字（例如 token 數 / 費用）
   */
  function showToast(kind, msg, opts = {}) {
    // 每次新的 showToast 一律清掉前一次遺留的 autoHide timer,
    // 避免上一個 toast 的 setTimeout 把這個新 toast 也一起關掉。
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }

    // 組合 class
    const classes = ['toast', 'show', kind];
    if (kind === 'loading' && opts.progress == null) classes.push('indeterminate');
    toastEl.className = classes.join(' ');
    toastMsgEl.textContent = msg;

    // 細節行（第二行，例如「280 tokens · $0.0028」)
    if (opts.detail) {
      toastDetailEl.textContent = opts.detail;
      toastDetailEl.hidden = false;
    } else {
      toastDetailEl.textContent = '';
      toastDetailEl.hidden = true;
    }

    // 進度條
    if (opts.progress != null) {
      toastFillEl.style.width = Math.round(opts.progress * 100) + '%';
    } else if (kind === 'success' || kind === 'error') {
      toastFillEl.style.width = '100%';
    } else {
      toastFillEl.style.width = '0%';
    }

    // 計時器
    if (opts.startTimer) {
      toastStartTime = Date.now();
      clearInterval(toastTickHandle);
      toastTimerEl.textContent = '0 秒';
      toastTickHandle = setInterval(() => {
        toastTimerEl.textContent = formatElapsed(Date.now() - toastStartTime);
      }, 500);
    }
    if (opts.stopTimer) {
      clearInterval(toastTickHandle);
      toastTickHandle = null;
      if (toastStartTime) {
        toastTimerEl.textContent = formatElapsed(Date.now() - toastStartTime);
      }
    }

    if (opts.autoHideMs) {
      toastHideHandle = setTimeout(() => {
        toastHideHandle = null;
        hideToast();
      }, opts.autoHideMs);
    }
  }
  function hideToast() {
    toastEl.className = 'toast';
    toastDetailEl.hidden = true;
    clearInterval(toastTickHandle);
    toastTickHandle = null;
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
  }

  // ─── 段落偵測 （v0.1 通用規則） ─────────────────────────
  const BLOCK_TAGS = [
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'DD', 'DT',
    'FIGCAPTION', 'CAPTION', 'TH', 'TD',
    'SUMMARY',
  ];
  // 直接排除 （純技術性元素）
  const HARD_EXCLUDE_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT']);
  // 標籤層級的容器排除：NAV / FOOTER 永遠跳過（HTML5 語意已表明是導覽/頁尾）
  const SEMANTIC_CONTAINER_EXCLUDE_TAGS = new Set(['NAV', 'FOOTER']);
  // 排除這些 ARIA role 的容器（全站頂部 banner、搜尋區、輔助側欄等）
  const EXCLUDE_ROLES = new Set(['banner', 'navigation', 'contentinfo', 'search']);

  // 注意：這裡「刻意」不做任何以內容為主的 selector 排除（例如 .ambox 維護模板）。
  // 硬規則：「翻譯範圍由 system prompt 決定，不由 selector 決定」——content.js 只負責
  // 「技術性必須跳過」的排除（script/style/code/表單控制項 + 語意容器 nav/footer/role），
  // 「這段讀者該不該看」之類的內容判斷一律交給 Gemini system prompt。
  // 歷史：v0.30 之前曾用 `.ambox, .box-AI-generated, .box-More_footnotes_needed` 排除
  // Wikipedia 維護模板，v0.31 起移除，因為讀者確實需要看到這些警告的中文版。

  // 部分有意義但用 DIV / SPAN 包裝的元素，需透過 selector 補抓
  const INCLUDE_BY_SELECTOR = [
    '#siteSub',
    '#contentSub',
    '#contentSub2',
    '#coordinates',
    '.hatnote',
    '.mw-redirectedfrom',
    '.dablink',
    '[role="note"]',
    // Wikipedia 的 {{thumb}} / {{wide image}} template 用 div.thumbcaption
    // 裝說明文字 （不是 <figcaption>)，需要主動補抓
    '.thumbcaption',
  ].join(',');

  function isInsideExcludedContainer(el) {
    // v0.31 起不再做 class/selector 層級的內容排除（見上方硬規則註解）。
    // 只保留 HTML5 語意容器（nav/footer）與 ARIA role（banner/navigation/
    // search/contentinfo）的結構性排除。
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName;
      if (tag && SEMANTIC_CONTAINER_EXCLUDE_TAGS.has(tag)) return true;
      const role = cur.getAttribute && cur.getAttribute('role');
      if (role && EXCLUDE_ROLES.has(role)) return true;
      // HEADER 只在明確標示 banner role 時排除（保留文章標題的 header)
      if (tag === 'HEADER' && role === 'banner') return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function isCandidateText(el) {
    const text = el.innerText?.trim();
    if (!text || text.length < 2) return false;
    if (!/[A-Za-zÀ-ÿ\u0400-\u04FF]/.test(text)) return false;
    return true;
  }

  // 過濾隱藏元素（例如 Wikipedia 的「50 languages」下拉選單內容）
  // 這些元素若被收進 batch，會因為段數過多造成 Gemini 回應分隔對齊錯亂
  // 是否含有其他 block tag 子孫（若是，代表這個元素不是「葉子 block」,
  // 應該跳過自己讓 walker 下降到子節點處理，避免父層 textContent 把子層
  // 的圖片/連結等子元素一併清掉）
  const BLOCK_TAGS_SET = new Set(['P','H1','H2','H3','H4','H5','H6','LI','BLOCKQUOTE','DD','DT','FIGCAPTION','CAPTION','TH','TD','SUMMARY']);
  function containsBlockDescendant(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      if (BLOCK_TAGS_SET.has(all[i].tagName)) return true;
    }
    return false;
  }

  // 是否含有需要保留的媒體元素（圖片/影片/SVG/canvas/picture)
  function containsMedia(el) {
    return !!el.querySelector('img, picture, video, svg, canvas, audio');
  }

  // ─── 行內樣式 / 連結保留 （placeholder 協定） ────────────
  // 把段落內的 <a>、<strong>、<em>、<code> 等 inline 元素抽出來換成
  // ⟦N⟧…⟦/N⟧ 佔位符，讓 LLM 只翻純文字、佔位符原樣保留；
  // 翻譯回來後再用同一份「殼」包回去，連結與樣式就完整保留。
  //
  // 為什麼用 ⟦ ⟧ (U+27E6/U+27E7)：這兩個字元在自然語言中幾乎不會出現，
  // LLM 也會乖乖保留；比 [N] 之類常見符號更安全。
  const PH_OPEN = '\u27E6';   // ⟦
  const PH_CLOSE = '\u27E7';  // ⟧

  // 需要保留外殼的 inline tag(連結與常見排版強調）
  const PRESERVE_INLINE_TAGS = new Set([
    'A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'MARK', 'U', 'S',
    'SUB', 'SUP', 'KBD', 'ABBR', 'CITE', 'Q', 'SMALL',
    'DEL', 'INS', 'VAR', 'SAMP', 'TIME',
  ]);

  // 內容是否「有實質文字」(含字母、CJK 或數字,不只是標點)
  // 只有標點或空白的 inline 元素沒有保留外殼的價值,還會增加 LLM 對齊難度。
  function hasSubstantiveContent(el) {
    const txt = (el.innerText || el.textContent || '');
    return /[A-Za-zÀ-ÿ\u0400-\u04FF\u3400-\u9fff0-9]/.test(txt);
  }

  // SPAN 通常是樣式 hook,只在帶 class 或 inline style 時才保留
  function isPreservableInline(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName;

    // Wikipedia 引用註腳 <sup class="reference">[N]</sup>:
    // 翻譯後的 [N] 純文字已足夠,保留外殼只會增加 LLM 對齊難度。
    if (tag === 'SUP' && el.classList && el.classList.contains('reference')) return false;

    let matchesTag = false;
    if (PRESERVE_INLINE_TAGS.has(tag)) {
      matchesTag = true;
    } else if (tag === 'SPAN') {
      if (el.hasAttribute('class')) matchesTag = true;
      else {
        const style = el.getAttribute('style');
        if (style && style.trim()) matchesTag = true;
      }
    }
    if (!matchesTag) return false;

    // 純標點/純空白的 inline 元素(例如 <span class="gloss-quot">'</span>)不保留
    if (!hasSubstantiveContent(el)) return false;

    // 注意：v0.31 之前這裡有一條「讓位給 <a>」規則 —— 非 <a> 的保留元素若內部
    // 含 <a>,就放棄外殼只保留連結(犧牲 bold / em 類樣式)。v0.32 起 serializer
    // 改為遞迴序列化,可以同時保住嵌套的 `<b><a>...</a></b>` 結構,因此這條規則
    // 已移除。例如 Wikipedia 維護模板的
    // <b>may incorporate text from a <a>large language model</a>, ...</b>
    // 會序列化成 `⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, ...⟦/0⟧`,
    // 外層 <b> 與內層 <a> 都會保留。

    return true;
  }

  // 段落內是否有任何需要保留的 inline 元素
  function hasPreservableInline(el) {
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (HARD_EXCLUDE_TAGS.has(n.tagName)) continue;
      if (isAtomicPreserve(n)) return true;
      if (isPreservableInline(n)) return true;
    }
    return false;
  }

  /**
   * 把元素內容序列化成「文字 + slots」。
   * 文字裡的每個保留 inline 元素都被替換成 ⟦N⟧…⟦/N⟧,
   * slots[N] 則記錄該元素的「殼」(shallow clone，會清空子節點）。
   *
   * v0.32 起支援巢狀：遞迴進入保留元素的子節點，所以
   * `<b>may incorporate text from a <a>LLM</a>, ...</b>` 會序列化成
   * `⟦0⟧may incorporate text from a ⟦1⟧LLM⟦/1⟧, ...⟦/0⟧`。
   * 反序列化時同樣會遞迴組回巢狀的 DocumentFragment。
   */
  // 「原子保留」(atomic) 子樹:整個元素保留 deep clone,中間的文字完全不送 LLM。
  // 用單一自閉合佔位符 ⟦*N⟧ 表示位置;LLM 只需把這 token 原樣留在譯文中。
  // 目的:像 Wikipedia 的 <sup class="reference"><a>[2]</a></sup>,
  // 整段 [2] 不該翻譯也不該被 LLM 改成全形,連結也應保留。
  function isAtomicPreserve(el) {
    if (el.tagName === 'SUP' && el.classList && el.classList.contains('reference')) return true;
    return false;
  }

  function serializeWithPlaceholders(el) {
    const slots = [];
    let out = '';
    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // 濾掉 <style> / <script> / <noscript> 等純技術元素,否則
          // Wikipedia infobox TH 裡內嵌的 .mw-parser-output {...} CSS
          // 會被當成純文字送進 LLM。
          if (HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          // 原子保留:整個元素 deep clone,只送 ⟦*N⟧ 給 LLM(裡面文字不翻譯)
          if (isAtomicPreserve(child)) {
            const idx = slots.length;
            slots.push({ atomic: true, node: child.cloneNode(true) });
            out += PH_OPEN + '*' + idx + PH_CLOSE;
            continue;
          }
          if (isPreservableInline(child)) {
            const idx = slots.length;
            // 殼：shallow clone，稍後反序列化時把譯文（與巢狀子節點）塞回去
            const shell = child.cloneNode(false);
            slots.push(shell);
            // 遞迴序列化子節點,可能產生巢狀的 ⟦M⟧…⟦/M⟧
            out += PH_OPEN + idx + PH_CLOSE;
            walk(child);
            out += PH_OPEN + '/' + idx + PH_CLOSE;
          } else {
            // 不保留外殼，但仍要把它的子文字串接進來
            walk(child);
          }
        }
      }
    }
    walk(el);
    return { text: out.replace(/\s+/g, ' ').trim(), slots };
  }

  /**
   * 把含佔位符的譯文反序列化成 DocumentFragment(寬鬆模式)。
   *
   * 策略:
   * - 只要譯文中有任何一組有效配對,就用 fragment 呈現(部分成功 > 整段退回純文字)。
   * - 配對成功的段落用原殼(連結 / 樣式保留)。
   * - 配對失敗或殘留的未配對 ⟦N⟧ / ⟦/N⟧ 標記會被剝除,剩下純文字附加在 fragment 中。
   * - 只有當 matched === 0(完全沒對到)才回傳 ok=false,讓呼叫端走純 textContent fallback。
   *
   * @returns {{ frag: DocumentFragment, ok: boolean, matched: number }}
   */
  // CJK 統一表意文字範圍（含擴充 A)以及常見中日標點
  const CJK_CHAR = '[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]';

  /**
   * 收掉「中文 _ 佔位符開頭 _ 中文」「中文 _ 佔位符結尾 _ 中文」之間的多餘空白。
   * 只動 CJK 字元兩側的空白，數字/英文 ↔ 中文之間的空白保留（那是 LLM 的譯文風格，不是 bug)。
   */
  function collapseCjkSpacesAroundPlaceholders(s) {
    if (!s) return s;
    // 開頭標籤 ⟦N⟧ 前的空白：左邊是 CJK，右邊（標籤內第一字）也是 CJK → 去掉空白
    s = s.replace(
      new RegExp('(' + CJK_CHAR + ')\\s+(' + PH_OPEN + '\\d+' + PH_CLOSE + CJK_CHAR + ')', 'g'),
      '$1$2'
    );
    // 結尾標籤 ⟦/N⟧ 後的空白：左邊（標籤內最後一字）是 CJK，右邊也是 CJK → 去掉空白
    s = s.replace(
      new RegExp('(' + CJK_CHAR + PH_OPEN + '\\/\\d+' + PH_CLOSE + ')\\s+(' + CJK_CHAR + ')', 'g'),
      '$1$2'
    );
    // 自閉合 ⟦*N⟧ 兩側的空白:CJK ↔ ⟦*N⟧ ↔ CJK 之間的空白也收掉
    s = s.replace(
      new RegExp('(' + CJK_CHAR + ')\\s+(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')', 'g'),
      '$1$2'
    );
    s = s.replace(
      new RegExp('(' + PH_OPEN + '\\*\\d+' + PH_CLOSE + ')\\s+(' + CJK_CHAR + ')', 'g'),
      '$1$2'
    );
    return s;
  }

  // 剝除譯文中殘留、未成功配對的佔位符標記(開頭、結尾或自閉合),只保留文字。
  // 例:'⟦5⟧bay' → 'bay';'estuary⟦/5⟧' → 'estuary';'foo⟦*3⟧bar' → 'foobar'
  function stripStrayPlaceholderMarkers(s) {
    return s.replace(new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'), '');
  }

  // 把佔位符 ⟦…⟧ 內部多餘空白收掉:⟦ 0 ⟧ → ⟦0⟧、⟦ /3 ⟧ → ⟦/3⟧、⟦ *5 ⟧ → ⟦*5⟧
  // 範圍嚴格鎖在 ⟦…⟧ 之間,不會誤傷譯文本身的格式。
  // (LLM 對佔位符的「全形化」傾向 ── 例如把 ⟦0⟧ 寫成 ⟦０⟧ ── 是 system prompt
  // 的責任,不在這裡 normalize,以免和 prompt 規則互相衝突或誤傷正文。)
  function normalizeLlmPlaceholders(s) {
    if (!s) return s;
    return s.replace(
      new RegExp(PH_OPEN + '\\s*(\\*?\\/?\\d+)\\s*' + PH_CLOSE, 'g'),
      PH_OPEN + '$1' + PH_CLOSE
    );
  }

  function deserializeWithPlaceholders(translation, slots) {
    if (!translation) {
      return { frag: document.createDocumentFragment(), ok: false, matched: 0 };
    }

    // 先把 LLM 自動全形化的佔位符 (⟦０⟧ / ⟦／0⟧ / ⟦ 0 ⟧ ...) 還原回標準形式
    translation = normalizeLlmPlaceholders(translation);
    // 再把 CJK 周圍黏在佔位符旁的殘留空白收掉
    translation = collapseCjkSpacesAroundPlaceholders(translation);

    // v0.32 起：recursive parse to support nested placeholders
    // （例如 ⟦0⟧一般文字 ⟦1⟧連結文字⟦/1⟧ 更多文字⟦/0⟧)。
    // parseSegment() 會用 regex 非貪婪匹配找最外層 ⟦N⟧...⟦/N⟧，
    // 然後對 inner 再次 parseSegment()，組出任意深度的 DocumentFragment 樹。
    const matchedRef = { count: 0 };
    const frag = parseSegment(translation, slots, matchedRef);
    const ok = matchedRef.count > 0;
    return { frag, ok, matched: matchedRef.count };
  }

  // 把一段含佔位符的字串解析成 DocumentFragment（可遞迴處理巢狀）。
  // 非貪婪 `([\s\S]*?)` + backreference `\1` 會正確找到對應的 `⟦/N⟧`,
  // 即使中間還有其他 `⟦M⟧...⟦/M⟧` 也不會誤判（因為 M ≠ N)。
  function parseSegment(text, slots, matchedRef) {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    // 同時匹配兩種佔位符:
    //   配對型 ⟦N⟧...⟦/N⟧  →  capture group 1=N, group 2=內含文字（可能含巢狀佔位符）
    //   自閉合 ⟦*N⟧        →  capture group 3=N（原子保留序號）
    // 注意：每次 parseSegment 呼叫都要 new 一個 regex，因為 /g 的 lastIndex 是 stateful。
    const re = new RegExp(
      PH_OPEN + '(\\d+)' + PH_CLOSE + '([\\s\\S]*?)' + PH_OPEN + '\\/\\1' + PH_CLOSE
        + '|' + PH_OPEN + '\\*(\\d+)' + PH_CLOSE,
      'g'
    );

    function pushText(s) {
      if (!s) return;
      // 剝掉任何殘留的(不配對)佔位符標記,只留乾淨文字
      const clean = stripStrayPlaceholderMarkers(s);
      if (clean) frag.appendChild(document.createTextNode(clean));
    }

    let cursor = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      // 配對前的散文(可能含未配對的殘留標記)
      if (m.index > cursor) {
        pushText(text.slice(cursor, m.index));
      }
      if (m[3] !== undefined) {
        // 自閉合 ⟦*N⟧:直接附上 atomic slot 的 deep clone
        const idx = Number(m[3]);
        const slot = slots[idx];
        if (slot && slot.atomic && slot.node) {
          frag.appendChild(slot.node.cloneNode(true));
          matchedRef.count++;
        }
        // slot 不存在或型別不符就丟掉這個 token(等同剝除)
      } else {
        // 配對型 ⟦N⟧...⟦/N⟧
        const idx = Number(m[1]);
        const inner = m[2];
        const slot = slots[idx];
        if (slot && slot.nodeType === Node.ELEMENT_NODE) {
          const shell = slot.cloneNode(false);
          // 遞迴解析 inner -> 可能是純文字,也可能還有 ⟦M⟧ 巢狀
          const innerFrag = parseSegment(inner, slots, matchedRef);
          shell.appendChild(innerFrag);
          frag.appendChild(shell);
          matchedRef.count++;
        } else if (slot && slot.atomic && slot.node) {
          // LLM 把自閉合誤寫成配對型,仍可救回:用 deep clone,丟掉 inner
          frag.appendChild(slot.node.cloneNode(true));
          matchedRef.count++;
        } else {
          // slot 不存在 → 把 inner 當普通內容遞迴解析（可能還有其他有效 slot)
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

  function isVisible(el) {
    if (!el) return false;
    if (el.tagName === 'BODY') return true;
    // offsetParent 為 null 通常代表 display:none 或祖先 display:none
    if (el.offsetParent === null) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
    }
    // 進一步檢查 computed style(處理 visibility:hidden)
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (style) {
      if (style.visibility === 'hidden' || style.display === 'none') return false;
    }
    return true;
  }

  function collectParagraphs(root = document.body, stats = null) {
    // stats（可選,v0.30 新增）：若傳入一個物件,walker 會在每個分支結尾遞增對應
    // 的計數 key,供 debug API / Playwright 測試診斷「為什麼某節點被跳過」。
    // 正常翻譯流程呼叫時不傳 stats,每個分支只多一次 null 檢查,效能影響可忽略。
    const results = [];
    const seen = new Set();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (HARD_EXCLUDE_TAGS.has(el.tagName)) {
          if (stats) stats.hardExcludeTag = (stats.hardExcludeTag || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (el.hasAttribute('data-shinkansen-translated')) {
          if (stats) stats.alreadyTranslated = (stats.alreadyTranslated || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!BLOCK_TAGS.includes(el.tagName)) {
          if (stats) stats.notBlockTag = (stats.notBlockTag || 0) + 1;
          return NodeFilter.FILTER_SKIP;
        }
        if (isInsideExcludedContainer(el)) {
          if (stats) stats.excludedContainer = (stats.excludedContainer || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(el)) {
          if (stats) stats.invisible = (stats.invisible || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // 葉子優先：如果這個 block 內含其他 block tag，讓 walker 下降處理子節點，
        // 避免父層被當成翻譯單位、用 textContent 把子層元素（含圖片）清光。
        if (containsBlockDescendant(el)) {
          if (stats) stats.hasBlockDescendant = (stats.hasBlockDescendant || 0) + 1;
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
      results.push(node);
      seen.add(node);
    }

    // 補抓 selector 指定的特殊 div(例如 #siteSub)
    document.querySelectorAll(INCLUDE_BY_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (isInsideExcludedContainer(el)) return;
      if (!isVisible(el)) return;
      if (!isCandidateText(el)) return;
      if (stats) stats.includedBySelector = (stats.includedBySelector || 0) + 1;
      results.push(el);
    });

    return results;
  }

  // ─── 翻譯流程 ────────────────────────────────────────
  const CHUNK_SIZE = 20; // 每批送 Gemini 的段數（越小回饋越即時，但總請求數越多）

  async function translatePage() {
    if (STATE.translated) {
      restorePage();
      return;
    }
    const elements = collectParagraphs();
    if (elements.length === 0) {
      showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      return;
    }
    const total = elements.length;
    showToast('loading', `翻譯中… 0 / ${total}`, {
      progress: 0,
      startTimer: true,
    });

    // 對每個段落都先序列化成「文字 + slots」，文字內含 ⟦N⟧…⟦/N⟧ 佔位符。
    // 沒有可保留 inline 元素的段落 slots 為空陣列，行為等同舊版純文字翻譯。
    const serialized = elements.map(el => {
      if (containsMedia(el)) {
        // 含媒體的段落不做佔位符 — 走舊的 text-node 替換路徑，避免複雜度爆炸
        return { text: el.innerText.trim(), slots: [] };
      }
      if (!hasPreservableInline(el)) {
        return { text: el.innerText.trim(), slots: [] };
      }
      return serializeWithPlaceholders(el);
    });
    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);
    let done = 0;
    // 本次翻譯的 token / 成本累計（只算真的打 API 的部分，快取命中 = 0)
    const pageUsage = { inputTokens: 0, outputTokens: 0, costUSD: 0, cacheHits: 0 };
    try {
      for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
        const sliceTexts = texts.slice(i, i + CHUNK_SIZE);
        const sliceEls = elements.slice(i, i + CHUNK_SIZE);

        const response = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_BATCH',
          payload: { texts: sliceTexts },
        });
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        const translations = response.result;
        // 累加 token 與成本
        if (response.usage) {
          pageUsage.inputTokens += response.usage.inputTokens || 0;
          pageUsage.outputTokens += response.usage.outputTokens || 0;
          pageUsage.costUSD += response.usage.costUSD || 0;
          pageUsage.cacheHits += response.usage.cacheHits || 0;
        }

        // 立即注入這一批的譯文 → 使用者看得到頁面逐步翻譯
        const sliceSlots = slotsList.slice(i, i + CHUNK_SIZE);
        translations.forEach((tr, j) => injectTranslation(sliceEls[j], tr, sliceSlots[j]));
        done += sliceTexts.length;

        // 更新進度
        showToast('loading', `翻譯中… ${done} / ${total}`, {
          progress: done / total,
        });
      }
      STATE.translated = true;
      // 通知 background 在 extension icon 上點亮紅點 badge
      chrome.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});
      // 組合完成訊息：主訊息只放段數，token/費用放 detail 第二行，
      // 避免同一行過長被擠到換行。
      const totalTokens = pageUsage.inputTokens + pageUsage.outputTokens;
      const successMsg = `翻譯完成 （${total} 段）`;
      let detail;
      if (totalTokens > 0) {
        detail = `${formatTokens(totalTokens)} tokens · ${formatUSD(pageUsage.costUSD)}`;
      } else if (pageUsage.cacheHits === total) {
        detail = '全部快取命中 · 本次未計費';
      }
      showToast('success', successMsg, {
        progress: 1,
        stopTimer: true,
        detail,
        // 不 autoHide：讓使用者自己按 × 關閉
      });
    } catch (err) {
      console.error('[Shinkansen]', err);
      showToast('error', `翻譯失敗：${err.message}`, { stopTimer: true });
    }
  }

  function injectTranslation(el, translation, slots) {
    if (!translation) return;
    // 保留原本的 innerHTML 供還原
    STATE.replaced.push({ el, originalHTML: el.innerHTML });

    // 路徑 A：有 slots(段落內含連結 / 樣式 inline 元素）→ 反序列化成 fragment
    // 若 LLM 把 placeholder 弄丟，fallback 到純文字 textContent。
    if (slots && slots.length > 0) {
      const { frag, ok } = deserializeWithPlaceholders(translation, slots);
      if (ok) {
        el.textContent = '';
        el.appendChild(frag);
        el.setAttribute('data-shinkansen-translated', '1');
        return;
      }
      // fallback：把譯文中的 ⟦N⟧⟦/N⟧ 標記去掉，當純文字塞回去
      const cleaned = translation.replace(
        new RegExp(PH_OPEN + '\\/?\\d+' + PH_CLOSE, 'g'),
        ''
      );
      el.textContent = cleaned;
      el.setAttribute('data-shinkansen-translated', '1');
      return;
    }

    if (containsMedia(el)) {
      // 元素內含圖片/影片等媒體 → 用 text-node 替換策略，保留媒體不動
      const textNodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.trim()) textNodes.push(n);
      }
      if (textNodes.length === 0) {
        // 沒有獨立文字節點？附加在最後
        el.appendChild(document.createTextNode(translation));
      } else {
        // 把整段譯文塞給最長的那個文字節點（主承載點），其餘清空
        let main = textNodes[0];
        for (const t of textNodes) {
          if (t.nodeValue.length > main.nodeValue.length) main = t;
        }
        main.nodeValue = translation;
        for (const t of textNodes) {
          if (t !== main) t.nodeValue = '';
        }
      }
    } else {
      // 純文字元素：直接整段替換，保留元素本身的 font/size/color/layout
      el.textContent = translation;
    }
    el.setAttribute('data-shinkansen-translated', '1');
  }

  function restorePage() {
    STATE.replaced.forEach(({ el, originalHTML }) => {
      el.innerHTML = originalHTML;
      el.removeAttribute('data-shinkansen-translated');
    });
    STATE.replaced = [];
    STATE.translated = false;
    // 通知 background 清掉 extension icon 的紅點
    chrome.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});
    showToast('success', '已還原原文', { progress: 1, autoHideMs: 2000 });
  }

  // ─── 訊息接收 （來自 background / popup) ──────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_TRANSLATE') {
      translatePage();
      return;
    }
    if (msg?.type === 'GET_STATE') {
      // popup 開啟時用來決定按鈕該顯示「翻譯本頁」還是「顯示原文」
      sendResponse({ ok: true, translated: STATE.translated });
      return true; // 保留 sendResponse 通道
    }
  });

  // 對外暴露（供 popup 透過 scripting 呼叫）
  window.__shinkansen_translate = translatePage;

  // ─── Debug API （唯讀,供自動化測試查詢內部狀態） ────────
  // 設計原則：
  // 1. 只暴露「查詢」,不暴露「執行」——避免測試誤觸真實翻譯燒錢
  // 2. 只回傳 plain object,絕不回 DOM Element 參考——跨 Playwright boundary
  //    會序列化失敗
  // 3. 掛在 window（此處是 content script 的 isolated world window）,測試端用
  //    page.evaluate(fn, { world: 'context' }) 或 CDP 指定 isolated world 存取
  // 4. version 對應 manifest version,方便測試端 assert「probe 版本 === 真實版本」,
  //    debug API 若 drift 至少能被偵測
  // 相關 ADR：見 SPEC.md §Debug API
  function buildSelectorPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 6) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) {
        s += '#' + cur.id;
        parts.unshift(s);
        break;
      }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // 序列化安全的單位摘要（debug API 內部共用）
  function unitSummary(el, i) {
    return {
      index: i,
      tag: el.tagName,
      textLength: (el.innerText || '').trim().length,
      textPreview: (el.innerText || '').trim().slice(0, 200),
      hasMedia: containsMedia(el),
      selectorPath: buildSelectorPath(el),
    };
  }

  window.__shinkansen = {
    get version() { return chrome.runtime.getManifest().version; },
    // 純偵測：呼叫真實 collectParagraphs,回傳序列化安全的 plain objects
    collectParagraphs() {
      return collectParagraphs().map(unitSummary);
    },
    // 純偵測 + walker 分支命中統計（v0.30 新增）：回傳 { units, skipStats }
    // 讓自動化測試能夠精準診斷「為什麼某節點被跳過」,取代先前靠鏡像 probe 計數的做法
    collectParagraphsWithStats() {
      const stats = {};
      const els = collectParagraphs(document.body, stats);
      return {
        units: els.map(unitSummary),
        skipStats: stats,
      };
    },
    // 佔位符序列化 / 反序列化（v0.32 新增）：純函式，無副作用，供自動化
    // 測試驗證巢狀 `⟦N⟧…⟦/N⟧` 的 round-trip 行為。不觸發任何 API 呼叫。
    serialize(el) { return serializeWithPlaceholders(el); },
    deserialize(text, slots) { return deserializeWithPlaceholders(text, slots); },
    // 當前翻譯狀態快照
    getState() {
      return {
        translated: STATE.translated,
        replacedCount: STATE.replaced.length,
        cacheSize: STATE.cache.size,
      };
    },
  };

  // 每次 content script 載入時（新頁面或重新整理）先清掉 badge,
  // 避免 SPA 同站內部導航時 chrome.tabs.onUpdated 沒觸發造成殘留。
  chrome.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});

  console.log('[Shinkansen] content script ready (v' + chrome.runtime.getManifest().version + ')');
})();
