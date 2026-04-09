// content.js — Shinkansen Content Script
// 職責：段落偵測、呼叫 background 翻譯、插入雙語顯示、Toast 提示。
// 注意：content script 不支援 ES module import，所有邏輯必須自包含。

(() => {
  if (window.__shinkansen_loaded) return;
  window.__shinkansen_loaded = true;

  const STATE = {
    translated: false,
    cache: new Map(),       // 段落文字 → 譯文
    // 記錄每個被替換過的元素與它原本的 innerHTML，供還原使用。
    // v0.36 起改為 Map，key 是 element，value 是 originalHTML。這樣同一個
    // element 被多個 fragment 單位改動時，只會快照一次「真正的原始 HTML」，
    // 不會被後續 fragment 的中途狀態污染。
    originalHTML: new Map(), // el → originalHTML
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
        /* v0.48: detail 支援多行顯示（tokens 一行、費用一行） */
        white-space: pre-line;
        line-height: 1.4;
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
  // v0.47: 「點擊外部關閉」的 mousedown listener handle。
  // 在 success 狀態且非 autoHide 時註冊（翻譯完成的主 toast），
  // hideToast / 下一次 showToast 時都要清掉。
  let toastOutsideHandler = null;

  function removeOutsideClickHandler() {
    if (toastOutsideHandler) {
      document.removeEventListener('mousedown', toastOutsideHandler, true);
      toastOutsideHandler = null;
    }
  }

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
    // v0.47: 也清掉前一次遺留的 outside-click listener,避免重疊註冊。
    removeOutsideClickHandler();

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

    // v0.47: 「翻譯完成」主 toast（kind === 'success' 且沒有 autoHideMs）
    // 註冊「點擊外部區域即關閉」的 listener。
    // - 排除 autoHide 情境:避免「已還原原文」這種 2 秒自動消失的 toast
    //   也被外部點擊搶先關掉,而且它本來就是次要提示。
    // - 用 mousedown + capture 比 click 更早觸發,避免使用者點別處的
    //   同時頁面 handler 吃掉事件。
    // - composedPath 判斷是否點在 toastHost 內部(含 shadow DOM)。
    //   若在內部(例如點 toast 本體 / × 按鈕)則不處理,交給原本邏輯。
    // - 延遲到下個 tick 再註冊,避免觸發 showToast 的那次 mousedown
    //   (如果真的是 click 觸發的話)立刻命中 listener 把自己關掉。
    //   目前 showToast 幾乎都由快捷鍵觸發,但保險起見還是延遲。
    if (kind === 'success' && !opts.autoHideMs) {
      setTimeout(() => {
        // 若在延遲期間 toast 已被關掉或被新 toast 取代,就不註冊。
        if (!toastEl.className.includes('show')) return;
        toastOutsideHandler = (ev) => {
          const path = ev.composedPath ? ev.composedPath() : [];
          if (path.includes(toastHost)) return; // 點在 toast 內部,忽略
          hideToast();
        };
        document.addEventListener('mousedown', toastOutsideHandler, true);
      }, 0);
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
    // v0.47: 關閉時一併移除 outside-click listener,避免遺留監聽。
    removeOutsideClickHandler();
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
    // v0.38: X / Twitter 的推文正文用 <div data-testid="tweetText"> 包住，
    // 整個子樹都是 <span>/<a>/<br>，沒有任何 block tag，walker 不會接受。
    // 推文是 X 上最核心的內容，必須主動補抓。同理補抓嵌入卡片的標題與描述。
    '[data-testid="tweetText"]',
    '[data-testid="card.layoutLarge.detail"] > div',
    '[data-testid="card.layoutSmall.detail"] > div',
    // v0.40: WordPress block theme 的「上一篇 / 下一篇」導覽連結。
    // 用 <div class="wp-block-post-navigation-link"> 包住 span + a,沒有 block tag,
    // walker 不會接受,需要主動補抓。Stratechery 等 WP 站都會用。
    '.wp-block-post-navigation-link',
  ].join(',');

  // v0.39: 判斷一個 block element 是否為「互動 widget 容器」。
  // 若一個 block 裡面含有 <button> 或 [role="button"] 的互動控制項後代,它
  // 通常是一張卡片 / 列表項 / toolbar 而不是文字段落（例如 X 的
  // <li data-testid="UserCell"> 整張「Who to follow」卡）。這種容器若被
  // 當成單一段落送 serializer,會產生太多 slot 導致 LLM 對齊失敗 → injector
  // 走 textContent fallback → 整個卡片結構被壓扁,avatar / 名稱 header /
  // 按鈕通通消失。直接整塊 reject 即可。
  //
  // v0.44: 加上「文字長度短路」——若 block 本身的文字量遠超過一般 widget
  // 卡片（閾值 300 字),則當作「文章段落含 CTA」而非 widget 卡片,放行
  // 讓 walker 下降處理內層的真正段落。
  //
  // 動機:Gmail 打開 HTML email newsletter 時,整個郵件本文常包在一個
  // `<td>` 裡(email 老派用 table-based layout),textLength ~1000,而且幾
  // 乎一定含有「Continue reading / Subscribe / Read more」這類 CTA
  // `<button>` 或 `[role="button"]`。v0.43 以前這個外層 TD 會被 widget
  // 規則整塊 REJECT,walker 下不到內層的 `<p>`,導致整封 email 只翻到
  // 2~3 段 Gmail UI 本身的 header/footer,郵件本文一字未翻。
  //
  // 閾值 300 字的選擇:
  //   - X UserCell 的典型大小:名稱(10~40) + @handle(10~20) + bio(<=160,
  //     Twitter 上限) ≈ 最多 ~200 字 → 維持 reject ✓
  //   - Gmail HTML email 本文 TD ≈ 500~2000+ 字 → 放行 ✓
  //   - Stratechery / Medium 內嵌 CTA card ≈ 50~150 字 → 維持 reject ✓
  //   - 含 CTA 的正常長段落(Substack 預覽段+「Continue reading」)→ 放行 ✓
  //
  // 以前有把 `[role="link"]` 納入的意圖(排除 Follow / 卡片封面整塊可點
  // widget),但實務上沒發現 regression,且 role="link" 在 Gmail / 其他站
  // 容易誤傷,所以 v0.44 只保留 button / role="button" 兩種真正的互動控
  // 制項訊號。
  function isInteractiveWidgetContainer(el) {
    if (!el.querySelector('button, [role="button"]')) return false;
    // 文字夠長就不當作 widget 卡片,讓 walker 下降處理內層真正的段落
    const textLen = (el.innerText || '').trim().length;
    if (textLen >= 300) return false;
    return true;
  }

  // v0.40: 「nav 內容白名單」——某些 WordPress 外掛（例如 Jetpack 的相關貼文）
  // 把「讀者要看的文章卡」裝在 <nav> 裡。語意上勉強說得通（nav = 導覽到其他
  // 文章）但實質是正文外的延伸內容,應該翻譯。這類 nav 的 class 會帶有明確
  // 的命名空間（jp-relatedposts-*)可以精準辨識。
  //
  // 這是 CLAUDE.md §6「結構性必須跳過」硬規則的「窄修例外」而不是方向轉變:
  // 一般站內選單仍由 NAV 一律跳過的規則處理,只有命中白名單的 nav 才放行。
  function isContentNav(el) {
    if (!el || el.tagName !== 'NAV') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    // Jetpack Related Posts (Stratechery 等站使用)
    if (/\bjp-relatedposts\b/.test(cls)) return true;
    return false;
  }

  // v0.41: 「footer 內容白名單」——WordPress Block Theme 常把「延伸閱讀」類的
  // 文章卡片區塊塞進 <footer class="wp-block-template-part"> 裡（例如
  // Stratechery 底部的 Stratechery Plus 三欄 Updates / Podcasts / Interviews)。
  // 語意上是站尾,但實質是讀者要看的內容。若 footer 裡含有 WordPress 的
  // 「文章查詢」區塊（wp-block-query / wp-block-post-title)就判定為內容 footer
  // 放行;一般站尾（版權、站內選單、社交連結)不會有這些 block,維持跳過。
  //
  // 這是 v0.40 nav 窄修的對稱延伸,同樣屬於 CLAUDE.md §6 的「窄修例外」而不
  // 是方向轉變——一般 footer 仍然整塊跳過,只有命中白名單條件的 footer 才放行。
  function isContentFooter(el) {
    if (!el || el.tagName !== 'FOOTER') return false;
    // 只要 footer 子樹裡有 WP 文章 block,就當成內容 footer
    return !!el.querySelector('.wp-block-query, .wp-block-post-title, .wp-block-post');
  }

  function isInsideExcludedContainer(el) {
    // v0.31 起不再做 class/selector 層級的內容排除（見上方硬規則註解）。
    // 只保留 HTML5 語意容器（nav/footer）與 ARIA role（banner/navigation/
    // search/contentinfo）的結構性排除。
    let cur = el;
    while (cur && cur !== document.body) {
      const tag = cur.tagName;
      // v0.40: nav 內容白名單例外——命中白名單的 nav 不算排除容器
      if (tag === 'NAV' && isContentNav(cur)) {
        cur = cur.parentElement;
        continue;
      }
      // v0.41: footer 內容白名單例外——含 WP 文章 block 的 footer 放行
      if (tag === 'FOOTER' && isContentFooter(cur)) {
        cur = cur.parentElement;
        continue;
      }
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

  // ─── Mixed-content fragment 偵測 （v0.36 新增） ─────────────
  // 當一個 block 元素同時含有自己的直接文字 + block 後代（例如 Stratechery 編號
  // 列表的 `<li>引言文字<ul>...</ul></li>` 結構）時，舊版 walker 會 SKIP 整個
  // 外層 block 讓 walker 下降，結果引言文字就被孤立、完全沒被收成段落。
  //
  // v0.36 起改為 mixed-content 策略：一個 block 若同時含直接文字 + block 後代,
  // walker 仍然 SKIP 外層讓子 block 各自獨立收成段落,但另外把外層自己的
  // inline-level 直接子節點切成一或多個 "fragment" 段落單位。
  //
  // fragment 單位的形狀: { kind: 'fragment', el, startNode, endNode }
  // 代表 `el` 這個元素裡,從 startNode 到 endNode（含）這段連續的直接子節點,
  // 他們全部都是 inline-level。序列化/注入時只碰這段，不動其他 block 子孫。

  /**
   * 判斷一個 node 是否可以納入 inline-run（連續的 inline 子節點區段）。
   * 規則：
   *   - 文字節點 → 是
   *   - HARD_EXCLUDE_TAGS (script/style/...) → 否（整個排除）
   *   - BLOCK_TAGS_SET 中的 tag → 否（這是子 block,讓 walker 獨立處理）
   *   - 本身含 block 後代（例如 <ul><li>...</li></ul>）→ 否（視為 block-run)
   *   - 其他 element → 是（視為 inline,包括 <a>、<strong>、<span>、<br> 等）
   */
  function isInlineRunNode(child) {
    if (child.nodeType === Node.TEXT_NODE) return true;
    if (child.nodeType !== Node.ELEMENT_NODE) return false; // comment、cdata 等略過
    if (HARD_EXCLUDE_TAGS.has(child.tagName)) return false;
    if (BLOCK_TAGS_SET.has(child.tagName)) return false;
    if (containsBlockDescendant(child)) return false;
    return true;
  }

  /**
   * 把一個 block 元素的直接子節點切成連續的 inline-run，每個 run 對應一個
   * fragment 段落單位（前提是 run 有實質文字內容）。
   *
   * 注意：要用 `Array.from(el.childNodes)` 快照,因為後續翻譯注入會動 childNodes,
   * 但收集時我們只關心此刻的結構。startNode / endNode 則保留 live Node 參考
   * （不是 index),這樣即使 DOM 被其他 fragment 改動,我們仍能指到正確節點。
   */
  function extractInlineFragments(el) {
    const fragments = [];
    const children = Array.from(el.childNodes);
    let runStart = null;
    let runEnd = null;

    const flushRun = () => {
      if (!runStart) return;
      // 檢查 run 內是否有實質文字（字母 / CJK / 數字）
      let text = '';
      let n = runStart;
      while (n) {
        text += n.textContent || '';
        if (n === runEnd) break;
        n = n.nextSibling;
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
      if (isInlineRunNode(child)) {
        if (!runStart) runStart = child;
        runEnd = child;
      } else {
        flushRun();
      }
    }
    flushRun();
    return fragments;
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
    return serializeNodeIterable(el.childNodes);
  }

  /**
   * Fragment 版序列化:只處理 [startNode, endNode] 這段連續的直接子節點
   * （v0.36 新增,配合 mixed-content block 的 fragment 段落單位)。
   */
  function serializeFragmentWithPlaceholders(unit) {
    const nodes = [];
    let cur = unit.startNode;
    while (cur) {
      nodes.push(cur);
      if (cur === unit.endNode) break;
      cur = cur.nextSibling;
    }
    return serializeNodeIterable(nodes);
  }

  /**
   * 共用的序列化核心:把一個 node iterable 遞迴序列化成
   * 「文字 + slots」。無論是整個 element 的 childNodes,還是 fragment
   * 的局部 node 範圍,都走這條路徑。
   */
  function serializeNodeIterable(topLevelNodes) {
    const slots = [];
    let out = '';
    function walk(nodeList) {
      for (const child of nodeList) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // 濾掉 <style> / <script> / <noscript> 等純技術元素,否則
          // Wikipedia infobox TH 裡內嵌的 .mw-parser-output {...} CSS
          // 會被當成純文字送進 LLM。
          if (HARD_EXCLUDE_TAGS.has(child.tagName)) continue;
          // v0.50: <br> 在 MJML / Mailjet / Mailchimp 等 HTML email 模板裡
          // 是「段落分隔符」（範本沒有 <p>，多段內容用 <br><br><br> 分隔）。
          // 序列化時把 <br> 還原成 \n，連續多個 <br> 就會變成 \n\n…，
          // 後續的 whitespace normalization 會收斂成「最多一個空行」（\n\n）。
          // 對一般網頁的單一 <br>（換行而非分段）也只是多一個 \n，不會破壞語意。
          if (child.tagName === 'BR') {
            // v0.51: 使用 sentinel \u0001 標記「來自 <br> 的換行」，
            // 與 source HTML 文字節點裡的原生 \n 分開處理。
            // 後面 normalize 階段會先把所有 whitespace（含原生 \n）收成 space，
            // 再把 sentinel 還原成真正的 \n。這樣就避免 Wikipedia 之類網頁
            // 從 source HTML formatting 帶進來的 \n 被誤當成段落分隔。
            out += '\u0001';
            continue;
          }
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
            walk(child.childNodes);
            out += PH_OPEN + '/' + idx + PH_CLOSE;
          } else {
            // 不保留外殼，但仍要把它的子文字串接進來
            walk(child.childNodes);
          }
        }
      }
    }
    walk(topLevelNodes);
    // v0.51: 兩階段 normalization，把「真正的 <br> 換行」與「source HTML
    // 排版用的 \n / 空白」分開處理。
    //   1. 先把所有原生 whitespace（含 source 的 \n）收成單一 space —— 這
    //      是 v0.50 之前的行為，能避免 Wikipedia 之類網頁的 source 排版
    //      \n 被誤當成段落分隔。
    //   2. 再處理 sentinel \u0001（來自 <br>）:吃掉 sentinel 兩側多餘空白,
    //      連續 3+ 個收成兩個（= 保留一個空行 = 一個段落分隔）。
    //   3. 最後把 sentinel 還原成真正的 \n。
    const normalized = out
      .replace(/\s+/g, ' ')
      .replace(/ *\u0001 */g, '\u0001')
      .replace(/\u0001{3,}/g, '\u0001\u0001')
      .replace(/\u0001/g, '\n')
      .trim();
    return { text: normalized, slots };
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

  /**
   * v0.57: 對譯文中重複出現的 slot index 做「graceful dedup」。
   *
   * 行為:
   *   - 掃出所有 `⟦N⟧…⟦/N⟧` 配對(用 backreference 強制 close 對應的 N)。
   *   - 對每個 idx N,若只出現一次直接保留;若 >1 次,挑「首次出現非空 inner」
   *     的那個當 winner,其餘 occurrence 拆殼成純內文(只剩 inner)。
   *   - 若全部 occurrence 都是空的(極罕見,LLM 雙重失誤),保留第一個。
   *
   * 為什麼用 regex 掃 top-level pair 就夠:
   *   slot 是 source-side 序列化時遞增分配的 idx,巢狀 slot 一定是不同 idx
   *   (例:`⟦3⟧⟦4⟧lit.⟦/4⟧⟦/3⟧`)。同一個 N 出現兩次必然代表 LLM 失誤,
   *   且兩個 occurrence 是 disjoint 的 top-level pair——non-greedy `[\s\S]*?`
   *   會自動找最近的 `⟦/N⟧` 對應。其他 idx 的 nested marker 留在 inner 裡,
   *   parseSegment 後續會處理。
   *
   * inner「是否非空」的判定:剝掉所有 placeholder marker 之後仍有非空白文字
   *   (CJK / 字母 / 數字 / 標點都算)。純空殼 `⟦0⟧⟦/0⟧` 或 `⟦0⟧ ⟦/0⟧`
   *   都判為空。
   */
  function selectBestSlotOccurrences(text) {
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
    // 依 idx 分組
    const byIdx = new Map();
    for (const o of occurrences) {
      if (!byIdx.has(o.idx)) byIdx.set(o.idx, []);
      byIdx.get(o.idx).push(o);
    }
    // 找出 losers (idx >1 次,且不是 winner)
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
    // 從尾向前 splice,避免位移影響後續 offset
    losers.sort((a, b) => b.start - a.start);
    let out = text;
    for (const l of losers) {
      out = out.slice(0, l.start) + l.inner + out.slice(l.end);
    }
    console.log('[Shinkansen v0.57] graceful dedup: dup_slots=' + dupSlotCount +
      ' losers_demoted=' + losers.length +
      ' preview=' + JSON.stringify(out.slice(0, 200)));
    return out;
  }

  function deserializeWithPlaceholders(translation, slots) {
    if (!translation) {
      return { frag: document.createDocumentFragment(), ok: false, matched: 0 };
    }

    // 先把 LLM 自動全形化的佔位符 (⟦０⟧ / ⟦／0⟧ / ⟦ 0 ⟧ ...) 還原回標準形式
    translation = normalizeLlmPlaceholders(translation);
    // 再把 CJK 周圍黏在佔位符旁的殘留空白收掉
    translation = collapseCjkSpacesAroundPlaceholders(translation);

    // v0.57: 「graceful slot dedup」——優雅處理 LLM 把同一個 slot index 重複
    // 引用的情況,保住絕大多數 slot 結構,只丟掉真的對不齊的那少數幾個。
    //
    // 取代了 v0.52 的「all-or-nothing rejection」:當時偵測到任何 dup 就整段
    // 砍掉走 plain-text fallback。問題是 plain-text fallback 會把 element
    // 整個 clean-slate(失去所有 `<a>` 連結),代價巨大;而真實 LLM 失誤通常
    // 只影響 1–2 個 slot,卻拖累其他 12+ 個正確的 slot 一起陪葬。
    //
    // 真實案例(Wikipedia Edo lead p,14 slots):LLM 把 slot 11(`<a>former
    // name</a>`)同時用在「⟦11⟧現今日本首都⟦/11⟧」與「⟦11⟧舊稱⟦/11⟧」兩處,
    // 因為「現今首都」與「舊稱」在中文裡被分開敘述。整段譯文除了這個 slot 11
    // 重複以外,其他 13 個 slot 全部正確就位。v0.52 detector 直接全部丟掉,
    // 結果頁面整段失去所有連結。
    //
    // 反例(v0.52 當初為了解決的 Wikipedia ambox):LLM 把所有譯文塞進「最後
    // 一組」⟦I⟧⟦SMALL⟧⟦A⟧ 內部,前面 slot 0/1/2 變成空殼 ⟦0⟧⟦/0⟧。在這個
    // 反例下,first-occurrence 是空的,winner 應該選 second-occurrence。
    //
    // 因此 winner 的選法是:**首次出現的「非空」occurrence**。empty wrapper
    // 一律不算 winner。若所有 occurrence 都是空的,就保留第一個(都一樣)。
    //
    // loser occurrence 的處理:把外殼 `⟦N⟧…⟦/N⟧` 拆掉,只留 inner text。
    // inner text 自己可能還有別的 slot marker,後續 parseSegment 會處理。
    //
    // 通則:這條規則描述的是「placeholder 協定下 LLM 重複引用 slot」這個
    // 結構特徵,不綁站點、不綁 selector、不綁特定 slot index。任何網頁的
    // 任何元素遇到同樣 LLM 失誤都會走同一條 graceful path。
    translation = selectBestSlotOccurrences(translation);

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
      if (!clean) return;
      // v0.50: 序列化階段把 <br> 轉成 \n,反序列化時還原成真正的 <br>。
      // 連續多個 \n 會產出對應數量的 <br>(在 normalize 階段已限制最多兩個 = 一個空行）。
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
    //
    // 回傳的單位是物件陣列,每個單位型態之一:
    //   { kind: 'element',  el }
    //   { kind: 'fragment', el, startNode, endNode }
    // v0.36 前只有 element 形式；v0.36 起新增 fragment 型態處理 mixed-content
    // block（既有自己的直接文字、又含 block 後代的結構）。
    const results = [];
    const seen = new Set();
    // 記錄哪些元素已經處理過 fragment 抽取，避免同一 element 被 walker 多次觸發
    const fragmentExtracted = new Set();

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
        // v0.39: 含 button / role=button 的 block 是互動 widget 容器（例如
        // X 的 Who-to-follow UserCell <li>）,整塊不翻譯以免 serializer slot
        // 爆炸壓扁結構。見 isInteractiveWidgetContainer 註解。
        if (isInteractiveWidgetContainer(el)) {
          if (stats) stats.interactiveWidget = (stats.interactiveWidget || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        if (!isVisible(el)) {
          if (stats) stats.invisible = (stats.invisible || 0) + 1;
          return NodeFilter.FILTER_REJECT;
        }
        // Mixed-content 處理：如果這個 block 內含其他 block tag,讓 walker 下降
        // 處理子 block；**但同時**把這個 element 自己的直接 inline 子節點切成
        // 一或多個 fragment 單位獨立翻譯,避免像 Stratechery 編號列表
        // （<li>引言+<ul>子項目</ul></li>）的引言文字被孤立。
        if (containsBlockDescendant(el)) {
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

    // 補抓 selector 指定的特殊 div(例如 #siteSub)
    document.querySelectorAll(INCLUDE_BY_SELECTOR).forEach(el => {
      if (seen.has(el)) return;
      if (el.hasAttribute('data-shinkansen-translated')) return;
      if (isInsideExcludedContainer(el)) return;
      // v0.39: selector 路徑也套相同的 widget 容器排除，避免未來有人加進來
      // 的 selector 不小心命中互動卡片（例如 X 的推文卡片若未來結構變）。
      if (isInteractiveWidgetContainer(el)) return;
      if (!isVisible(el)) return;
      if (!isCandidateText(el)) return;
      if (stats) stats.includedBySelector = (stats.includedBySelector || 0) + 1;
      results.push({ kind: 'element', el });
    });

    // v0.42: 「leaf content anchor」補抓 —— 卡片式網站（Substack / Culpium /
    // Medium 首頁等）常把整張文章卡包在 <a> 裡,內部只有 <div class="...">
    // 巢狀結構,完全不用 h1/h2/h3/p/article,walker 一個 block tag 都收不到。
    // 歷史觀察:culpium.com 首頁 0 個 h2/h3/p,全頁只有 1 個 h1(站名),導致
    // 舊版 Shinkansen 只會偵測到「1 段」。
    //
    // 規則(四個條件必須同時成立):
    //   1. 是 leaf anchor —— 祖先中沒有任何 BLOCK_TAG
    //      (一般文章內的 <a> 會有 <p> / <li> 祖先,由父 block 走正規路徑處理)
    //   2. 本身不含 block 後代(避免吃到巨大的外層 <a>)
    //   3. innerText 經 trim 後 >= 12 字
    //      (擋掉「Home / Notes / Sign in / About」這類 nav 連結)
    //   4. 通過 isVisible / isCandidateText / 排除容器 / widget 容器 / 已翻過
    //
    // 為什麼把這條放在 INCLUDE_BY_SELECTOR 後面而不是整合進 walker:
    //   walker 只看 BLOCK_TAGS,改它會影響所有現有站點的行為;走補抓路徑
    //   (跟 v0.38 的 tweetText、v0.40 的 wp-block-post-navigation-link 同路)
    //   風險最小,且命中後直接以 element 形式加入 results,序列化與注入流程
    //   不需要任何改動。
    document.querySelectorAll('a').forEach(a => {
      if (seen.has(a)) return;
      if (a.hasAttribute('data-shinkansen-translated')) return;
      // 條件 1:祖先無 BLOCK_TAG
      let cur = a.parentElement;
      let hasBlockAncestor = false;
      while (cur && cur !== document.body) {
        if (BLOCK_TAGS_SET.has(cur.tagName)) { hasBlockAncestor = true; break; }
        cur = cur.parentElement;
      }
      if (hasBlockAncestor) return;
      // 條件 2:本身不含 block 後代
      if (containsBlockDescendant(a)) return;
      // 結構性排除(nav/footer/banner role 等)與互動 widget
      if (isInsideExcludedContainer(a)) return;
      if (isInteractiveWidgetContainer(a)) return;
      if (!isVisible(a)) return;
      if (!isCandidateText(a)) return;
      // 條件 3:文字夠長,擋掉 nav 類短連結
      const txt = (a.innerText || '').trim();
      if (txt.length < 12) return;
      if (stats) stats.leafContentAnchor = (stats.leafContentAnchor || 0) + 1;
      results.push({ kind: 'element', el: a });
      seen.add(a);
    });

    return results;
  }

  // ─── 翻譯流程 ────────────────────────────────────────
  // v0.37 起改為「字元預算 + 段數上限」雙門檻的 greedy 打包，以避免單批
  // token 數暴衝（例如 20 個 Stratechery 論述段）或 slot 過多導致 LLM
  // 對齊失準。任一門檻先達到就封口開新批次；單段本身超過預算時獨佔一批。
  const MAX_UNITS_PER_BATCH = 20;        // 段數上限（原 CHUNK_SIZE）
  const MAX_CHARS_PER_BATCH = 3500;      // 字元預算，作為 token proxy（≈ 1000 英文 tokens，留 output headroom）
  const DEFAULT_MAX_CONCURRENT = 10; // content.js 側並發上限（與 background 的 rate limiter 雙重保險）

  // ─── v0.69: 術語表一致化 ──────────────────────────────
  // 門檻常數（與 storage.js 的 glossary 設定對應，但 content.js 不 import ES module，
  // 所以在這裡先定義預設值，translatePage 會從 settings 讀取覆蓋）
  const GLOSSARY_SKIP_THRESHOLD_DEFAULT = 1;
  const GLOSSARY_BLOCKING_THRESHOLD_DEFAULT = 5;
  const GLOSSARY_TIMEOUT_DEFAULT = 60000; // v0.70: 60s — Structured Output 對長文可能需要 30-50 秒

  /** SHA-1 hash（content script 版本，不依賴 ES module import）。 */
  async function sha1(text) {
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 從偵測到的段落 units 中萃取「術語擷取用的壓縮輸入」。
   * 只取 heading、每段第一句、figcaption、表格 caption、頁面 title，
   * 壓縮到原文的 20–30%，召回率仍高（名詞通常在首次出現時就會被抓到）。
   */
  function extractGlossaryInput(units) {
    const parts = [];

    // 頁面 title
    const title = document.title?.trim();
    if (title) parts.push(title);

    for (const unit of units) {
      const el = unit.kind === 'fragment' ? unit.parent : unit.el;
      if (!el) continue;
      const tag = el.tagName;

      // heading（h1–h6）：全文取用
      if (/^H[1-6]$/.test(tag)) {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      // figcaption / table caption
      if (tag === 'FIGCAPTION' || tag === 'CAPTION') {
        const txt = el.innerText?.trim();
        if (txt) parts.push(txt);
        continue;
      }

      // 一般段落：只取第一句（到第一個句號、問號、驚嘆號、或前 200 字元）
      const fullText = el.innerText?.trim();
      if (!fullText) continue;
      const sentenceMatch = fullText.match(/^[^.!?。！？]*[.!?。！？]/);
      const firstSentence = sentenceMatch ? sentenceMatch[0] : fullText.slice(0, 200);
      if (firstSentence.length >= 10) {
        parts.push(firstSentence);
      }
    }

    return parts.join('\n');
  }

  // Greedy 打包：依原順序累加段落，超過任一門檻就封口。
  // - 字元數 > MAX_CHARS_PER_BATCH 的超大段落獨佔一批（不切段落本身，避免破壞語意）。
  // - 順序維持原始 DOM index，確保注入位置正確。
  function packBatches(texts, units, slotsList) {
    const jobs = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.texts.length > 0) jobs.push(cur);
      cur = null;
    };
    for (let i = 0; i < texts.length; i++) {
      const len = (texts[i] || '').length;
      // 單段就超過預算 → 獨佔一批
      if (len > MAX_CHARS_PER_BATCH) {
        flush();
        jobs.push({
          start: i,
          texts: [texts[i]],
          units: [units[i]],
          slots: [slotsList[i]],
          chars: len,
          oversized: true,
        });
        continue;
      }
      // 若加入這段會超過任一門檻，先封口
      if (cur && (cur.chars + len > MAX_CHARS_PER_BATCH || cur.texts.length >= MAX_UNITS_PER_BATCH)) {
        flush();
      }
      if (!cur) cur = { start: i, texts: [], units: [], slots: [], chars: 0 };
      cur.texts.push(texts[i]);
      cur.units.push(units[i]);
      cur.slots.push(slotsList[i]);
      cur.chars += len;
    }
    flush();
    return jobs;
  }

  /**
   * 翻譯核心:把一組 units 序列化 → 打包 → 並行送翻 → 注入 DOM。
   * v0.45 抽出,供 translatePage (初次翻譯) 與 rescanTick (延遲補抓) 共用。
   * 不負責:顯示主 toast / 設定 STATE.translated / 發送 badge 訊息。這些
   * 由呼叫者 (translatePage) 自己處理,rescan 路徑則走靜默/補抓 toast。
   *
   * onProgress: 可選 callback(done, total),每批完成時呼叫一次
   * referencePairs: v0.73 可選的首批翻譯參考對（方案 3），格式 [{source, target}, ...]
   */
  async function translateUnits(units, { onProgress, referencePairs } = {}) {
    const total = units.length;
    // 對每個段落都先序列化成「文字 + slots」,文字內含 ⟦N⟧…⟦/N⟧ 佔位符。
    // 沒有可保留 inline 元素的段落 slots 為空陣列,行為等同舊版純文字翻譯。
    // v0.36 起 units 可能含 element 或 fragment 兩種型態,要分別處理。
    const serialized = units.map(unit => {
      if (unit.kind === 'fragment') {
        return serializeFragmentWithPlaceholders(unit);
      }
      const el = unit.el;
      if (containsMedia(el)) {
        return { text: el.innerText.trim(), slots: [] };
      }
      if (!hasPreservableInline(el)) {
        return { text: el.innerText.trim(), slots: [] };
      }
      return serializeWithPlaceholders(el);
    });
    const texts = serialized.map(s => s.text);
    const slotsList = serialized.map(s => s.slots);

    // 讀取並發上限設定(若讀取失敗就用 default)
    let maxConcurrent = DEFAULT_MAX_CONCURRENT;
    try {
      const { maxConcurrentBatches } = await chrome.storage.sync.get('maxConcurrentBatches');
      if (Number.isFinite(maxConcurrentBatches) && maxConcurrentBatches > 0) {
        maxConcurrent = maxConcurrentBatches;
      }
    } catch (_) { /* 保持 default */ }

    let done = 0;
    // cachedTokens: Gemini implicit context cache 命中的輸入 token 累計（v0.46 新增）
    // billedInputTokens / billedCostUSD: 套 implicit cache 折扣後的實付值（v0.48 新增）
    const pageUsage = {
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUSD: 0,
      billedInputTokens: 0, billedCostUSD: 0,
      cacheHits: 0,
    };
    const jobs = packBatches(texts, units, slotsList);
    const failures = [];

    await runWithConcurrency(jobs, maxConcurrent, async (job) => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'TRANSLATE_BATCH',
          payload: { texts: job.texts, referencePairs: referencePairs || null },
        });
        if (!response?.ok) throw new Error(response?.error || '未知錯誤');
        const translations = response.result;
        if (response.usage) {
          pageUsage.inputTokens += response.usage.inputTokens || 0;
          pageUsage.outputTokens += response.usage.outputTokens || 0;
          pageUsage.cachedTokens += response.usage.cachedTokens || 0;
          pageUsage.costUSD += response.usage.costUSD || 0;
          pageUsage.billedInputTokens += response.usage.billedInputTokens || 0;
          pageUsage.billedCostUSD += response.usage.billedCostUSD || 0;
          pageUsage.cacheHits += response.usage.cacheHits || 0;
        }
        translations.forEach((tr, j) => injectTranslation(job.units[j], tr, job.slots[j]));
        done += job.texts.length;
        if (onProgress) onProgress(done, total);
      } catch (err) {
        console.warn('[Shinkansen] batch failed', { start: job.start, error: err.message });
        failures.push({ start: job.start, count: job.texts.length, error: err.message });
      }
    });

    return { done, total, failures, pageUsage };
  }

  async function translatePage() {
    if (STATE.translated) {
      restorePage();
      return;
    }
    const units = collectParagraphs();
    if (units.length === 0) {
      showToast('error', '找不到可翻譯的內容', { autoHideMs: 3000 });
      return;
    }
    const total = units.length;

    // ─── v0.73: 術語表一致化（方案 3：首批播種 + 其餘平行） ─────────
    // 讀取開關
    let glossaryEnabled = true;
    try {
      const { glossary: gc } = await chrome.storage.sync.get('glossary');
      if (gc) glossaryEnabled = gc.enabled !== false;
    } catch (_) { /* 保持 default */ }

    // 估算批次數（決定是否需要術語表流程）
    const preSerialized = units.map(unit => {
      if (unit.kind === 'fragment') return { text: (unit.parent?.innerText || '').trim() };
      return { text: (unit.el?.innerText || '').trim() };
    });
    const preTexts = preSerialized.map(s => s.text);
    let batchCount = 0;
    {
      let chars = 0, segs = 0;
      for (const t of preTexts) {
        const len = t.length;
        if (len > MAX_CHARS_PER_BATCH) { batchCount++; chars = 0; segs = 0; continue; }
        if (chars + len > MAX_CHARS_PER_BATCH || segs >= MAX_UNITS_PER_BATCH) {
          batchCount++; chars = 0; segs = 0;
        }
        chars += len; segs++;
      }
      if (segs > 0) batchCount++;
    }

    // 方案 3：若啟用且 ≥2 批，先翻首批收集 reference pairs，其餘帶著平行翻
    // ≤1 批不需要一致化（沒有跨批問題）
    const useSeeding = glossaryEnabled && batchCount >= 2;

    console.log(`[Shinkansen] translatePage: ${total} units, ~${batchCount} batches, glossary=${glossaryEnabled ? 'on' : 'off'}, seeding=${useSeeding}`);

    showToast('loading', `翻譯中… 0 / ${total}`, {
      progress: 0,
      startTimer: true,
    });

    try {
      let referencePairs = null;

      if (useSeeding) {
        // ── 首批播種：單獨翻譯第一批，收集 source↔target pairs ──
        // 用 packBatches 的第一批 units 做為種子
        const seedSize = Math.min(total, MAX_UNITS_PER_BATCH);
        const seedUnits = units.slice(0, seedSize);
        const remainingUnits = units.slice(seedSize);

        console.log(`[Shinkansen] seeding: translating first ${seedSize} units to build reference...`);
        showToast('loading', `播種翻譯中… 0 / ${seedSize}`, { progress: 0 });

        const seedResult = await translateUnits(seedUnits, {
          onProgress: (d, t) => showToast('loading', `播種翻譯中… ${d} / ${t}`, {
            progress: d / (total), // 分母用 total 讓進度條是整頁的
          }),
        });

        // 從首批結果收集 reference pairs（source → target）
        // translateUnits 完成後，seedUnits 的 DOM 已被注入譯文，
        // 但我們需要 source 與 target 的配對。用 seedUnits 的 _originalText
        // （restorePage 用的備份）與注入後的 innerText 來組 pairs。
        referencePairs = [];
        for (const unit of seedUnits) {
          const source = unit._originalText || '';
          const el = unit.kind === 'fragment' ? unit.parent : unit.el;
          const target = el ? el.innerText.trim() : '';
          // 只收集有意義的配對（兩邊都有內容、且有變化）
          if (source && target && source !== target) {
            referencePairs.push({ source, target });
          }
        }
        console.log(`[Shinkansen] seeding done: ${referencePairs.length} reference pairs collected`);
        if (referencePairs.length > 0 && referencePairs.length <= 5) {
          // 數量少的時候印出來方便 debug
          console.log('[Shinkansen] reference pairs:', referencePairs.map(p =>
            `${p.source.slice(0, 40)}… → ${p.target.slice(0, 40)}…`));
        } else if (referencePairs.length > 5) {
          console.log('[Shinkansen] reference pairs (first 5):', referencePairs.slice(0, 5).map(p =>
            `${p.source.slice(0, 40)}… → ${p.target.slice(0, 40)}…`));
        }

        // 若首批沒收集到有效 pairs，放棄 seeding，後續當普通翻譯
        if (referencePairs.length === 0) {
          console.warn('[Shinkansen] seeding: no valid pairs collected, proceeding without reference');
          referencePairs = null;
        }

        // 翻譯剩餘 units，帶著 referencePairs
        if (remainingUnits.length > 0) {
          const seedDone = seedResult.done;
          const restResult = await translateUnits(remainingUnits, {
            referencePairs,
            onProgress: (d, t) => showToast('loading', `翻譯中… ${seedDone + d} / ${total}`, {
              progress: (seedDone + d) / total,
            }),
          });

          // 合併 usage
          var done = seedResult.done + restResult.done;
          var failures = [...seedResult.failures, ...restResult.failures];
          var pageUsage = {
            inputTokens: seedResult.pageUsage.inputTokens + restResult.pageUsage.inputTokens,
            outputTokens: seedResult.pageUsage.outputTokens + restResult.pageUsage.outputTokens,
            cachedTokens: seedResult.pageUsage.cachedTokens + restResult.pageUsage.cachedTokens,
            costUSD: seedResult.pageUsage.costUSD + restResult.pageUsage.costUSD,
            billedInputTokens: seedResult.pageUsage.billedInputTokens + restResult.pageUsage.billedInputTokens,
            billedCostUSD: seedResult.pageUsage.billedCostUSD + restResult.pageUsage.billedCostUSD,
            cacheHits: seedResult.pageUsage.cacheHits + restResult.pageUsage.cacheHits,
          };
        } else {
          var done = seedResult.done;
          var failures = seedResult.failures;
          var pageUsage = seedResult.pageUsage;
        }
      } else {
        // 不需要 seeding（關閉或 ≤1 批），直接平行翻譯全部
        const result = await translateUnits(units, {
          onProgress: (d, t) => showToast('loading', `翻譯中… ${d} / ${t}`, {
            progress: d / t,
          }),
        });
        var done = result.done;
        var failures = result.failures;
        var pageUsage = result.pageUsage;
      }

      // 有部分失敗 → 顯示部分完成的訊息,但仍標記為已翻譯
      if (failures.length) {
        const failedSegs = failures.reduce((s, f) => s + f.count, 0);
        const firstErr = failures[0].error;
        showToast('error', `翻譯部分失敗:${failedSegs} / ${total} 段失敗`, {
          stopTimer: true,
          detail: firstErr.slice(0, 120),
        });
      }

      STATE.translated = true;
      chrome.runtime.sendMessage({ type: 'SET_BADGE_TRANSLATED' }).catch(() => {});

      if (!failures.length) {
        const totalTokens = pageUsage.inputTokens + pageUsage.outputTokens;
        const successMsg = `翻譯完成 （${total} 段）`;
        let detail;
        if (totalTokens > 0) {
          // v0.48: Toast 顯示「實付」值（已套 Gemini implicit cache 折扣）。
          //   Line 1: `{billed tokens} tokens (XX% hit)`
          //   Line 2: `${billed USD} (XX% saved)`
          // - billed tokens = billedInputTokens + outputTokens（等效 token 數）
          // - hit%  = cachedTokens / inputTokens × 100  (input 層的 cache 命中比例)
          // - saved% = (原價 − 實付) / 原價 × 100         (費用層的節省比例，
          //            output 沒折扣所以會比 hit% 略低)
          // - 若 cachedTokens === 0 則不附加括號內容（避免 0% hit / 0% saved 刺眼）
          const billedTotalTokens = pageUsage.billedInputTokens + pageUsage.outputTokens;
          let line1 = `${formatTokens(billedTotalTokens)} tokens`;
          let line2 = formatUSD(pageUsage.billedCostUSD);
          if (pageUsage.cachedTokens > 0 && pageUsage.inputTokens > 0) {
            const hitPct = (pageUsage.cachedTokens / pageUsage.inputTokens) * 100;
            const savedPct = pageUsage.costUSD > 0
              ? ((pageUsage.costUSD - pageUsage.billedCostUSD) / pageUsage.costUSD) * 100
              : 0;
            line1 += ` (${hitPct.toFixed(0)}% hit)`;
            line2 += ` (${savedPct.toFixed(0)}% saved)`;
          }
          // 用 \n 分隔兩行，依靠 CSS `.detail { white-space: pre-line }` 正確換行
          detail = `${line1}\n${line2}`;
        } else if (pageUsage.cacheHits === total) {
          detail = '全部快取命中 · 本次未計費';
        }
        // 把完整 usage 印到 console，方便事後在 DevTools 查實際數字（v0.48 更新欄位）
        console.log('[Shinkansen] page usage', {
          segments: total,
          inputTokens: pageUsage.inputTokens,
          cachedTokens: pageUsage.cachedTokens,
          outputTokens: pageUsage.outputTokens,
          billedInputTokens: pageUsage.billedInputTokens,
          billedTotalTokens: pageUsage.billedInputTokens + pageUsage.outputTokens,
          implicitCacheHitRate: pageUsage.inputTokens > 0
            ? `${((pageUsage.cachedTokens / pageUsage.inputTokens) * 100).toFixed(1)}%`
            : 'n/a',
          originalCostUSD: pageUsage.costUSD,
          billedCostUSD: pageUsage.billedCostUSD,
          costSavedRate: pageUsage.costUSD > 0
            ? `${(((pageUsage.costUSD - pageUsage.billedCostUSD) / pageUsage.costUSD) * 100).toFixed(1)}%`
            : 'n/a',
          localCacheHitSegments: pageUsage.cacheHits,
        });
        showToast('success', successMsg, {
          progress: 1,
          stopTimer: true,
          detail,
        });
      }

      // v0.45: 安排延遲 rescan 補抓 hydration 後才 render 的內容
      // (例如 Nikkei 的 READ NEXT 區,Next.js 把它放在 hydration 之後才 mount)
      scheduleRescanForLateContent();
    } catch (err) {
      console.error('[Shinkansen]', err);
      showToast('error', `翻譯失敗:${err.message}`, { stopTimer: true });
    }
  }

  // ─── v0.45: 延遲 rescan 機制 ─────────────────────────────
  // 動機:Nikkei Asia 這類 Next.js 站的 READ NEXT 區在 `document_idle` 階段
  // (content.js 最早可執行的時機) 還沒 attach 到 DOM,React hydration 之後
  // 才 mount。初次 translatePage 的 walker 抓不到,結果整個下半截都沒翻。
  // 使用者手動再按一次 Alt+S 就會翻,因為第二次 walker 看到的已經是
  // hydration 完成的完整 DOM——這正是採證時看到的行為,也證明問題純粹
  // 在於「第一次 walker 跑太早」,不是偵測規則本身有誤。
  //
  // 修法:初次 translatePage 成功後,在兩個退避時間點 (1200ms, 3000ms) 再
  // 各跑一次 `collectParagraphs`。walker 會自動 REJECT 已帶
  // `data-shinkansen-translated` 標記的節點,所以 rescan 拿到的自然是
  // 「上次翻完之後才出現的新段落」。若有新段落就打包送翻、注入;沒有
  // 就靜默跳過,避免無謂打擾。
  //
  // 為什麼不用 MutationObserver:
  //   - SPA 動態內容(Twitter timeline / Substack infinite scroll)會無限觸發
  //     observer,翻譯成本會爆炸
  //   - 需要很複雜的節流與去重
  //   - 兩次退避式 rescan 已經足以處理 Nikkei 這類「一次性 hydration」的
  //     常見場景,而且成本固定可預測
  //
  // 為什麼兩次而不是一次:第一次 rescan 可能還趕在 hydration 完成之前
  // (尤其手機 / 慢機),3000ms 再補一次提供安全餘量。兩次都沒抓到就停。
  const RESCAN_DELAYS_MS = [1200, 3000];
  let rescanAttempts = 0;
  let rescanTimer = null;

  function cancelRescan() {
    if (rescanTimer) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
    rescanAttempts = 0;
  }

  function scheduleRescanForLateContent() {
    cancelRescan();
    rescanTimer = setTimeout(rescanTick, RESCAN_DELAYS_MS[0]);
  }

  async function rescanTick() {
    rescanTimer = null;
    // 使用者可能已經按 Alt+S 切回原文;此時不該再注入譯文
    if (!STATE.translated) return;
    const newUnits = collectParagraphs();
    if (newUnits.length > 0) {
      try {
        const { done, failures } = await translateUnits(newUnits);
        // 離開 await 後再次檢查:rescan 期間使用者可能已按還原
        if (!STATE.translated) return;
        // v0.47: 不再顯示「補抓 X 段新內容」toast。
        // 原因:翻譯完成後的主 toast 帶著 token / 費用 / 快取命中率等
        // 使用者真正在意的統計資料,若補抓 toast 在幾秒後蓋掉它,使用者
        // 就看不到統計。補抓本身是自動機制,使用者不需要主動知道,
        // 改成只 console.log 讓需要的人自己去 DevTools 看。
        // 失敗原本就靜默(console.warn 在 translateUnits 內做),成功比照辦理。
        if (done > 0) {
          console.log('[Shinkansen] rescan 補抓', {
            done,
            failures: failures.length,
            attempt: rescanAttempts + 1,
          });
        }
      } catch (err) {
        console.warn('[Shinkansen] rescan failed', err);
      }
    }
    // 即使這次沒抓到內容,也再試一次(頁面可能還在 hydrate)
    rescanAttempts += 1;
    if (rescanAttempts < RESCAN_DELAYS_MS.length) {
      rescanTimer = setTimeout(rescanTick, RESCAN_DELAYS_MS[rescanAttempts]);
    }
  }

  /**
   * 並行執行 jobs,同時最多 maxConcurrent 個任務在跑。
   * 每個 job 執行的錯誤由 workerFn 自己處理(此函式不會 throw)。
   */
  async function runWithConcurrency(jobs, maxConcurrent, workerFn) {
    const n = Math.min(maxConcurrent, jobs.length);
    if (n === 0) return;
    let cursor = 0;
    const workers = [];
    for (let w = 0; w < n; w++) {
      workers.push((async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const idx = cursor++;
          if (idx >= jobs.length) return;
          await workerFn(jobs[idx]);
        }
      })());
    }
    await Promise.all(workers);
  }

  /**
   * 保證同一個 element 只快照一次原始 innerHTML,之後的覆蓋不會污染快照。
   * 用於 fragment 同一 parent 多 fragment 的情況,以及 element 模式本身。
   */
  function snapshotOnce(el) {
    if (!STATE.originalHTML.has(el)) {
      STATE.originalHTML.set(el, el.innerHTML);
    }
  }

  function injectTranslation(unit, translation, slots) {
    if (!translation) return;
    // v0.36: unit 可能是 { kind: 'element', el } 或 { kind: 'fragment', el, startNode, endNode }
    if (unit.kind === 'fragment') {
      return injectFragmentTranslation(unit, translation, slots);
    }
    const el = unit.el;
    // 保留原本的 innerHTML 供還原
    snapshotOnce(el);

    // 路徑 A：有 slots(段落內含連結 / 樣式 inline 元素）→ 反序列化成 fragment
    // 若 LLM 把 placeholder 弄丟，fallback 到純文字 textContent。
    if (slots && slots.length > 0) {
      const { frag, ok } = deserializeWithPlaceholders(translation, slots);
      if (ok) {
        // v0.49 bugfix：不能用 `el.textContent = ''; el.appendChild(frag)`，
        // 原因跟 replaceTextInPlace 註解一樣——MJML 外層 TD 常設 font-size:0，
        // 把 el 裡所有 child 清掉就等於丟掉內層 DIV/SPAN wrapper 提供的真字體大小，
        // fragment 裡的 SPAN shell 只保留 font-family/color（沒有 font-size），
        // 結果文字繼承 TD 的 0px → 整段看不見（Gmail MJML newsletter 的 step body
        // 實測就是這條路徑觸發的 bug）。
        // 改法：找最長的可見文字節點，把 fragment 插在它原位，再把它跟其他文字
        // 節點清空。這樣 fragment 會落在 MJML inner wrapper 底下，自動繼承 16px。
        replaceNodeInPlace(el, frag);
        el.setAttribute('data-shinkansen-translated', '1');
        return;
      }
      // fallback：把譯文中的 ⟦N⟧⟦/N⟧ 標記去掉,走 plain-text 替換。
      //
      // v0.52: 之前用 replaceTextInPlace 把譯文塞進「最長文字節點」,但對於
      // Wikipedia ambox 這種「最長文字節點剛好在 <I><SMALL><A> 裡面」的
      // 結構,Chinese 會繼承 italic/small/link 樣式,看起來像 v0.51 的失敗
      // 視覺(雖然結構不再錯亂)。改用 plainTextFallback：直接寫到 el 本身
      // 的 textContent,只在 MJML 之類「el 自己 font-size:0」的特殊情況下
      // 才退到 inner wrapper,避免 ambox 的 inline ancestor 把樣式繼承下來。
      // v0.52: 含 `\\*?` 才能順便清掉原子型佔位符 `⟦*N⟧`(像 Wikipedia
      // sup.reference 腳註),不然這些 token 會以字面形式留在 fallback 文字裡。
      const cleaned = translation.replace(
        new RegExp(PH_OPEN + '\\*?\\/?\\d+' + PH_CLOSE, 'g'),
        ''
      );
      plainTextFallback(el, cleaned);
      el.setAttribute('data-shinkansen-translated', '1');
      return;
    }

    replaceTextInPlace(el, translation);
    el.setAttribute('data-shinkansen-translated', '1');
  }

  /**
   * v0.49: 「最長文字節點就地替換」——把整段譯文塞給 el 底下最長的可見文字節點，
   * 其餘文字節點清空；完全不動 element 結構。
   *
   * 為什麼不用 `el.textContent = translation`：後者會清掉所有子節點（包含 inner
   * wrapper 例如 <div>/<span>），只留一個裸文字節點 child。在一般網頁沒差，但
   * MJML / Mailjet / Mailchimp 等 HTML email 模板常把外層 `<td>` 設為
   * `font-size: 0`（消除 inline-block 欄位間的空白縫隙），真正字體大小放在內層
   * `<div>` 或 `<span>` 上。內層 wrapper 一旦被清掉，文字繼承 TD 的 `font-size: 0px`
   * → 視覺上「整段消失」。歷史教訓：v0.48 之前 Gmail 打開 MJML newsletter（例如
   * Claude 官方歡迎信）翻完之後標題 / 段落 / step 卡片文字全部不見，icon 卻留著。
   *
   * 對純文字元素（只有一個 text child）行為等價於舊版 `el.textContent = translation`,
   * 因此沒有回歸風險。對含媒體元素（圖片 / SVG / video）則同時達成「保留媒體 + 替換
   * 最長文字節點」目標，取代原本的 containsMedia() 分支邏輯。
   *
   * 需過濾的技術節點（歷史教訓 v0.33 / v0.34）:
   *   (1) <script>/<style>/<noscript>/<code>/<pre> 底下的文字節點
   *   (2) CSS display:none / visibility:hidden 的隱形祖先底下的文字節點
   * Wikipedia 的 #coordinates 同時含 .geo-dms（可見）與 .geo-nondefault > .geo-dec
   * （display:none），過濾掉隱形祖先才能確保譯文塞進看得到的節點。
   */
  function collectVisibleTextNodes(el) {
    const textNodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== el) {
          if (HARD_EXCLUDE_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
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
  }

  function findLongestTextNode(textNodes) {
    let main = textNodes[0];
    for (const t of textNodes) {
      if (t.nodeValue.length > main.nodeValue.length) main = t;
    }
    return main;
  }

  /**
   * v0.55 / v0.56: 共用的「注入目標解析」helper。回答「要把譯文寫到哪個
   * 元素?」
   *
   * 預設值是 `el` 本身——呼叫端清空 `el.children` 再 append 譯文就對了,
   * `el` 自己的 padding / background / font-family / line-height 等樣式會
   * 透過 CSS 繼承繼續套用到新 content,不會被動到。
   *
   * 唯一例外:**`el` 自己 computed font-size 趨近 0**。這是 MJML / Mailjet /
   * Mailchimp 等 HTML email 模板在消除 `inline-block` 欄位縫隙時的業界標準
   * 做法——外層容器 `<td style="font-size:0">`,真正字體放在內層 wrapper 上。
   * 這類 `el` 的「font-size 繼承來源」是內層 wrapper,若直接清空 `el.children`
   * 會把這個 wrapper 也清掉,新 content 只能繼承 `el` 的 0px,整段消失。
   * 命中時改把「第一個 font-size 正常的後代」當寫入目標,清掉它的 children
   * 後再 append,就能保留 wrapper 提供的字體大小。
   *
   * 但**descent 過程必須拒絕整個 slot subtree** (`isPreservableInline` /
   * `isAtomicPreserve` 命中的元素**及其所有後代**)。理由:slot 元素本身與
   * 它內部的所有節點都會由 deserializer 從 shell + 譯文重建,寫入目標若
   * 落在 slot 內任何一層,clean-slate-append fragment 都會把新 shell 塞到
   * 舊 shell 裡面,造成雙層巢狀;padding / margin / border 全部加倍,視覺上
   * 就是按鈕往一邊偏移凸出。
   *
   * **歷史**:
   * - v0.55 的 Gmail Claude Code welcome email「深入了解」按鈕踩到一次——
   *   MJML 結構是 `<td font-size:0> <a font-size:18px>Learn more</a> </td>`,
   *   resolveWriteTarget 把 descent 停在 `<a>` 上,fragment 裡又有一個從 slot
   *   shell 複製出來的 `<a>`,結果變成 `<td> <a> <a>深入了解</a> </a> </td>`,
   *   padding 8px 35px 加倍成 16px 70px,按鈕往左凸出。v0.56 的 fix 是「skip
   *   slot 元素本身」,對這個結構足夠。
   *
   * - v0.57 的同一封 email 又踩到,因為來源結構其實是
   *   `<td font-size:0> <a> <span> Learn more </span> </a> </td>`(SPAN 沒
   *   class 沒 style,不是 preservable)。v0.56 walk 跳過 `<a>`,但繼續往下
   *   走進 `<a>` 內部找到那個 SPAN(font-size 18 from inheritance),把 SPAN
   *   當寫入目標 → clean-slate SPAN 後塞 fragment(`<a>譯文</a>`)→ 結果變成
   *   `<td><a><span><a>譯文</a></span></a></td>`,outer A 沒被清(因為 target
   *   是 SPAN 不是 td),inner A 是 slot 0 shell。padding 又加倍。
   *
   * - v0.58 的 fix:walk 時把 slot 元素整個 subtree FILTER_REJECT,不只是
   *   元素本身。slot 內部所有後代都不該當寫入目標,因為 deserializer 重建
   *   的是 slot 「整段」而非「殼 + 你內部的某個節點」。
   *
   * 通則:descent 是在找「td/wrapper 裡面唯一一個非 slot 的真正內容容器」,
   * slot subtree 整段都是 slot 的責任範圍,walk 不能進去。對 MJML、`<button>`
   * 包 `<span>`、或任何 inline 元素被巢狀包裹的排版都適用。
   */
  function resolveWriteTarget(el) {
    const win = el.ownerDocument?.defaultView;
    const cs = win?.getComputedStyle?.(el);
    const px = cs ? parseFloat(cs.fontSize) : NaN;
    if (Number.isFinite(px) && px < 1) {
      // v0.58: 用 TreeWalker + FILTER_REJECT 拒絕整個 slot subtree(只 SKIP
      // 會繼續走進子節點,REJECT 才會跳過整段)。
      const walker = el.ownerDocument.createTreeWalker(
        el,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode(node) {
            if (node === el) return NodeFilter.FILTER_SKIP;
            if (isPreservableInline(node) || isAtomicPreserve(node)) {
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
   * v0.55: 共用的「注入」helper。回答「要怎麼把譯文寫進 target?」
   *
   * 兩條互斥路徑:
   *
   * (A) **Clean slate 預設**:清空 `target.children` 後 append content。
   *     這對所有「slots 已經完整重建譯文結構」的場景都對——fragment 本身
   *     就含完整的 inline 元素殼 (A/STRONG/EM/...),整段覆蓋就是正確的。
   *
   * (B) **Media-preserving 例外**:當 `target` 含 `<img>` / `<svg>` /
   *     `<video>` / `<picture>` / `<audio>` / `<canvas>` 這類**序列化階段
   *     會被丟掉**的元素時,不能 clean slate——那些元素沒被 LLM 看到、也
   *     不在 fragment 裡,一清就消失。改走「就地替換最長文字節點」:找到
   *     target 底下最長的可見文字節點,把 content 插在它的原位,其他文字
   *     節點清空,但所有 element children(含 img / svg / ...)原封保留。
   *
   * 為什麼用 `containsMedia(target)` 這個 check 當分流條件:描述的是**結構
   * 特徵**(「此元素內含需保留的非文字媒體」),不綁定站點。任何包含 inline
   * 媒體 + 文字的段落都走同一條邏輯。
   *
   * BR 去重:只有 media 路徑才需要,因為 clean slate 路徑會清空所有原始
   * children (含 BR)。media 路徑若 fragment 自己帶了 `<br>`、target 又留
   * 著原始 `<br>`,兩組會堆疊造成多餘空白,所以要先把 target 的 BR 清掉。
   */
  function injectIntoTarget(target, content) {
    const isString = typeof content === 'string';

    if (containsMedia(target)) {
      // (B) media-preserving path.
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
      const textNodes = collectVisibleTextNodes(target);
      if (textNodes.length === 0) {
        target.appendChild(node);
        return;
      }
      const main = findLongestTextNode(textNodes);
      for (const t of textNodes) if (t !== main) t.nodeValue = '';
      const parent = main.parentNode;
      if (parent) {
        parent.insertBefore(node, main);
        parent.removeChild(main);
      } else {
        target.appendChild(node);
      }
      return;
    }

    // (A) clean slate path.
    while (target.firstChild) target.removeChild(target.firstChild);
    if (isString) {
      target.textContent = content;
    } else {
      target.appendChild(content);
    }
  }

  /**
   * v0.52 → v0.55 重構:slot 配對失敗 fallback 用的純文字注入。
   * 現在只是 `resolveWriteTarget` + `injectIntoTarget` 的薄包裝,
   * 與 `replaceNodeInPlace` / `replaceTextInPlace` 共用同一套注入邏輯,
   * 不再有自己的 MJML 檢測實作。
   */
  function plainTextFallback(el, cleaned) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, cleaned);
  }

  /**
   * v0.49 → v0.55 重構:無 slots 路徑的純文字注入。
   * 現在與 `replaceNodeInPlace` / `plainTextFallback` 共用同一套「寫入目標
   * 解析 + 注入策略」邏輯。含 `\n` 的譯文仍走 fragment 路徑(`\n` → `<br>`)。
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
   * v0.50: 把含 \n 的純文字譯文做成 DocumentFragment,\n 換成真正的 <br>。
   * 用在無 slots 路徑（路徑 B）的譯文有段落分隔時。
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
   * v0.49 → v0.55 重構:slots 路徑的 fragment 注入。
   * 與 `replaceTextInPlace` / `plainTextFallback` 共用同一套「寫入目標解析
   * + 注入策略」邏輯(`resolveWriteTarget` + `injectIntoTarget`),三條路徑
   * 不再各自實作 MJML font-size:0 檢測或 media 保留邏輯。
   */
  function replaceNodeInPlace(el, frag) {
    const target = resolveWriteTarget(el);
    injectIntoTarget(target, frag);
  }

  /**
   * Fragment 版注入:只替換 parent 內 [startNode, endNode] 這段連續子節點,
   * 不動其他 block 子孫。v0.36 新增,配合 mixed-content block 的段落單位。
   *
   * 注意:不在 parent el 上設 data-shinkansen-translated,因為同一個 parent
   * 底下可能還有其他 fragment 或 block 子孫需要被 walker 看到。重複翻譯的
   * 保護靠 STATE.translated 的頁面層級 flag。
   */
  function injectFragmentTranslation(unit, translation, slots) {
    if (!translation) return;
    const { el, startNode, endNode } = unit;

    // 若 startNode 已經不在 parent 下（可能前面的 fragment 早一步把它搬走了，
    // 理論上不會發生因為 fragment 之間是 disjoint 的,但保險）,略過本次注入。
    if (!startNode || startNode.parentNode !== el) return;

    // 同一個 parent 只快照一次原始 HTML,後續 fragment 或 element 注入都沿用
    snapshotOnce(el);

    // 建出新內容（fragment DocumentFragment 或 Text node）
    let newContent;
    if (slots && slots.length > 0) {
      const { frag, ok } = deserializeWithPlaceholders(translation, slots);
      if (ok) {
        newContent = frag;
      } else {
        const cleaned = stripStrayPlaceholderMarkers(translation);
        newContent = document.createTextNode(cleaned);
      }
    } else {
      newContent = document.createTextNode(translation);
    }

    // 移除 startNode..endNode 之間（含兩端）的所有節點,然後在原位置 insert
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

  function restorePage() {
    // v0.45: 取消掉任何還沒觸發的延遲 rescan,避免使用者按還原之後
    // rescan tick 又把新段落翻出來,造成「已按還原但中文仍零星冒出」。
    // 注意:目前正在 await 中的 rescan 還是可能寫入,接受這個小風險。
    cancelRescan();
    STATE.originalHTML.forEach((originalHTML, el) => {
      el.innerHTML = originalHTML;
      el.removeAttribute('data-shinkansen-translated');
    });
    STATE.originalHTML.clear();
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

  // 序列化安全的單位摘要（debug API 內部共用）。
  // v0.36 起 unit 是 { kind, el, startNode?, endNode? } 物件而非 raw element。
  // 回傳格式對舊測試保持相容: tag / textPreview / textLength / hasMedia /
  // selectorPath 仍存在, 另外新增 kind 欄位供 fragment 單位識別。
  function unitSummary(unit, i) {
    if (unit.kind === 'fragment') {
      // 把 fragment 範圍內的所有節點串成純文字,計長度/預覽
      let text = '';
      let n = unit.startNode;
      while (n) {
        text += n.textContent || '';
        if (n === unit.endNode) break;
        n = n.nextSibling;
      }
      const trimmed = text.trim();
      return {
        index: i,
        kind: 'fragment',
        tag: unit.el.tagName,
        textLength: trimmed.length,
        textPreview: trimmed.slice(0, 200),
        hasMedia: false, // fragment 本質上是 inline-run,不會跨 block 媒體容器
        selectorPath: buildSelectorPath(unit.el),
      };
    }
    const el = unit.el;
    return {
      index: i,
      kind: 'element',
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
      const units = collectParagraphs(document.body, stats);
      return {
        units: units.map(unitSummary),
        skipStats: stats,
      };
    },
    // 佔位符序列化 / 反序列化（v0.32 新增）：純函式，無副作用，供自動化
    // 測試驗證巢狀 `⟦N⟧…⟦/N⟧` 的 round-trip 行為。不觸發任何 API 呼叫。
    serialize(el) { return serializeWithPlaceholders(el); },
    deserialize(text, slots) { return deserializeWithPlaceholders(text, slots); },
    // 測試專用 (v0.59 新增):對指定 element 跑「serialize → 假 LLM 回應 →
    // inject」的完整路徑,跳過網路層但保留所有真實的 serialize/deserialize/
    // resolveWriteTarget/injectIntoTarget 邏輯。讓 Category B 回歸測試能夠
    // 對 v0.49–v0.58 修過的 inject 路徑 bug 做斷言,而不需要打 Gemini API。
    // 不污染 page main world (留在 isolated world)。
    testInject(el, translation) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) {
        throw new Error('testInject: el must be an Element');
      }
      const { text, slots } = serializeWithPlaceholders(el);
      const unit = { kind: 'element', el };
      injectTranslation(unit, translation, slots);
      return { sourceText: text, slotCount: slots.length };
    },
    // 測試專用 (v0.59 新增):暴露 selectBestSlotOccurrences 給 Category C
    // 純函式測試呼叫(slot dup graceful degradation 的 winner 選擇邏輯)。
    selectBestSlotOccurrences(text) {
      return selectBestSlotOccurrences(text);
    },
    // 當前翻譯狀態快照
    getState() {
      return {
        translated: STATE.translated,
        replacedCount: STATE.originalHTML.size,
        cacheSize: STATE.cache.size,
      };
    },
  };

  // 每次 content script 載入時（新頁面或重新整理）先清掉 badge,
  // 避免 SPA 同站內部導航時 chrome.tabs.onUpdated 沒觸發造成殘留。
  chrome.runtime.sendMessage({ type: 'CLEAR_BADGE' }).catch(() => {});

  console.log('[Shinkansen] content script ready (v' + chrome.runtime.getManifest().version + ')');
})();
