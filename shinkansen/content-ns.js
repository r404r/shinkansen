// content-ns.js — Shinkansen 命名空間、共用狀態、常數、工具函式
// 這是 content script 拆分後的第一個檔案，建立 window.__SK 命名空間，
// 後續子模組透過 (function(SK) { ... })(window.__SK) 存取共用資源。
// 注意：content script 不支援 ES module import，所有邏輯透過全域命名空間共用。

// Safari / Firefox 相容性 shim（v1.3.16）
// content script 不能 import ES module，改用全域方式讓後續所有 content script 繼承。
globalThis.browser = globalThis.browser ?? globalThis.chrome;

// ─── v1.5.2: iframe gate（pure function 設計，給 spec unit-test 用） ───
// manifest 開 `all_frames: true` 讓 content script 也注入 iframe（為了翻 BBC 等
// 站點嵌入的 Flourish / Datawrapper 等第三方圖表 iframe），但 0×0 廣告 iframe、
// reCAPTCHA、cookie consent、Cxense / DoubleClick 等技術性 iframe 不該被翻——
// 否則一個 BBC 文章頁就會跑 11 份 content script、CPU 與第三方 widget 都受傷。
// gate 條件：iframe 內的可見尺寸 >= 200×100 才啟動 content script，否則 SK.disabled = true。
function _sk_shouldDisableInFrame(isFrame, width, height, visible) {
  if (!isFrame) return false;            // 主 frame 永遠啟動
  if (!visible) return true;             // 不可見 → 跳過
  if (width < 200 || height < 100) return true;  // 太小 → 視為廣告/分析 iframe
  return false;
}

function _sk_isCurrentFrameDisabled() {
  const isFrame = window !== window.top;
  if (!isFrame) return false;
  const html = document.documentElement;
  let visible = !!html;
  if (html) {
    const cs = window.getComputedStyle?.(html);
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none')) visible = false;
  }
  return _sk_shouldDisableInFrame(isFrame, window.innerWidth, window.innerHeight, visible);
}

if (window.__shinkansen_loaded) {
  // 防止重複載入（SPA 框架可能重新注入 content script）
} else if (_sk_isCurrentFrameDisabled()) {
  // 在不合格 iframe 內（廣告/分析/cookie consent 等），不建立完整命名空間
  window.__shinkansen_loaded = true;
  window.__SK = { disabled: true, shouldDisableInFrame: _sk_shouldDisableInFrame };
} else {
  window.__shinkansen_loaded = true;

  // ─── 命名空間初始化 ─────────────────────────────────────
  window.__SK = {};
  const SK = window.__SK;
  SK.disabled = false;
  SK.shouldDisableInFrame = _sk_shouldDisableInFrame;

  // ─── v1.5: Content Script 多語言支援 ──────────────────
  // content script 不能 import ES module，內嵌精簡版字串表。
  // 從 storage 讀取 uiLocale，預設 zh-TW。
  SK._locale = 'zh-TW';
  SK._strings = {
    'zh-TW': {
      cs_translating: '翻譯中…', cs_close: '關閉', cs_seconds: ' 秒', cs_minutes: ' 分 ',
      cs_zero_seconds: '0 秒', cs_batch_timeout: '批次逾時（{0}s）', cs_unknown_error: '未知錯誤',
      cs_google_docs_redirect: '偵測到 Google Docs，正在開啟可翻譯的閱讀版⋯',
      cs_cancelling: '正在取消翻譯⋯',
      cs_offline: '目前處於離線狀態，無法翻譯。請確認網路連線後再試',
      cs_already_target_lang: '此頁面已是{0}，不需翻譯',
      cs_no_content: '找不到可翻譯的內容',
      cs_building_glossary: '建立術語表⋯', cs_glossary_timeout: '術語表逾時',
      cs_progress: '{0}翻譯中… {1} / {2}', cs_cancelled: '已取消翻譯',
      cs_partial_fail: '翻譯部分失敗:{0} / {1} 段失敗',
      cs_complete_truncated: '翻譯完成 （{0} 段，另有 {1} 段因頁面過長被略過）',
      cs_complete: '翻譯完成 （{0} 段）',
      cs_all_cache_hit: '全部快取命中 · 本次未計費',
      cs_rpd_warning_title: '提醒：今日 API 請求次數已超過預算上限',
      cs_rpd_warning_body: '翻譯仍可正常使用，但請留意用量。每日計數於太平洋時間午夜重置（約台灣時間下午 3 點）',
      cs_translate_fail: '翻譯失敗:{0}', cs_restored: '已還原原文',
      cs_google_progress: '{0}Google 翻譯中… {1} / {2}',
      cs_google_complete_truncated: 'Google 翻譯完成（{0} 段，另有 {1} 段因頁面過長被略過）',
      cs_google_complete: 'Google 翻譯完成（{0} 段）',
      cs_google_chars: '{0} 字元 · 免費', cs_auto_translate: '自動翻譯',
      cs_target_lang_name: '繁體中文',
      cs_spa_progress: '翻譯新內容… {0} / {1}',
      cs_spa_partial_fail: '新內容翻譯部分失敗:{0} / {1} 段',
      cs_spa_complete: '已翻譯 {0} 段新內容', cs_spa_fail: '新內容翻譯失敗:{0}',
      cs_mode_single: '單語覆蓋', cs_mode_dual: '雙語對照',
      cs_mode_changed: '顯示模式已切換為「{0}」，請按快速鍵重新翻譯以套用',
      yt_translating: '翻譯中…', yt_translate_fail: '翻譯失敗',
      yt_restored: '已還原原文字幕',
      yt_waiting_cc: '字幕翻譯已啟動，等待 CC 字幕資料…',
      yt_starting: '已有 {0} 條字幕，開始翻譯', yt_waiting_data: '等待字幕資料…',
      yt_activated: '字幕翻譯已開啟。請開啟 YouTube 字幕（CC），翻譯將自動開始。',
      yt_behind: '{0}s ⚠️ 落後', yt_debug_title: '🔍 Shinkansen 字幕 Debug',
    },
    'zh-CN': {
      cs_translating: '翻译中…', cs_close: '关闭', cs_seconds: ' 秒', cs_minutes: ' 分 ',
      cs_zero_seconds: '0 秒', cs_batch_timeout: '批次超时（{0}s）', cs_unknown_error: '未知错误',
      cs_google_docs_redirect: '检测到 Google Docs，正在打开可翻译的阅读版…',
      cs_cancelling: '正在取消翻译…',
      cs_offline: '当前处于离线状态，无法翻译。请检查网络连接后重试',
      cs_already_target_lang: '此页面已是{0}，无需翻译',
      cs_no_content: '找不到可翻译的内容',
      cs_building_glossary: '正在建立术语表…', cs_glossary_timeout: '术语表超时',
      cs_progress: '{0}翻译中… {1} / {2}', cs_cancelled: '已取消翻译',
      cs_partial_fail: '翻译部分失败：{0} / {1} 段失败',
      cs_complete_truncated: '翻译完成（{0} 段，另有 {1} 段因页面过长被略过）',
      cs_complete: '翻译完成（{0} 段）',
      cs_all_cache_hit: '全部缓存命中 · 本次未计费',
      cs_rpd_warning_title: '提醒：今日 API 请求次数已超过预算上限',
      cs_rpd_warning_body: '翻译仍可正常使用，但请注意用量。每日计数于太平洋时间午夜重置（约北京时间下午 3 点）',
      cs_translate_fail: '翻译失败：{0}', cs_restored: '已还原原文',
      cs_google_progress: '{0}Google 翻译中… {1} / {2}',
      cs_google_complete_truncated: 'Google 翻译完成（{0} 段，另有 {1} 段因页面过长被略过）',
      cs_google_complete: 'Google 翻译完成（{0} 段）',
      cs_google_chars: '{0} 字符 · 免费', cs_auto_translate: '自动翻译',
      cs_target_lang_name: '简体中文',
      cs_spa_progress: '翻译新内容… {0} / {1}',
      cs_spa_partial_fail: '新内容翻译部分失败：{0} / {1} 段',
      cs_spa_complete: '已翻译 {0} 段新内容', cs_spa_fail: '新内容翻译失败：{0}',
      cs_mode_single: '单语覆盖', cs_mode_dual: '双语对照',
      cs_mode_changed: '显示模式已切换为「{0}」，请按快捷键重新翻译以套用',
      yt_translating: '翻译中…', yt_translate_fail: '翻译失败',
      yt_restored: '已还原原文字幕',
      yt_waiting_cc: '字幕翻译已启动，等待 CC 字幕数据…',
      yt_starting: '已有 {0} 条字幕，开始翻译', yt_waiting_data: '等待字幕数据…',
      yt_activated: '字幕翻译已开启。请开启 YouTube 字幕（CC），翻译将自动开始。',
      yt_behind: '{0}s ⚠️ 落后', yt_debug_title: '🔍 Shinkansen 字幕 Debug',
    },
    'ja': {
      cs_translating: '翻訳中…', cs_close: '閉じる', cs_seconds: ' 秒', cs_minutes: ' 分 ',
      cs_zero_seconds: '0 秒', cs_batch_timeout: 'バッチタイムアウト（{0}s）', cs_unknown_error: '不明なエラー',
      cs_google_docs_redirect: 'Google Docs を検出しました。翻訳可能な閲覧版を開いています…',
      cs_cancelling: '翻訳をキャンセル中…',
      cs_offline: '現在オフラインです。ネットワーク接続を確認してから再試行してください',
      cs_already_target_lang: 'このページは既に{0}です。翻訳は不要です',
      cs_no_content: '翻訳可能なコンテンツが見つかりません',
      cs_building_glossary: '用語集を作成中…', cs_glossary_timeout: '用語集タイムアウト',
      cs_progress: '{0}翻訳中… {1} / {2}', cs_cancelled: '翻訳をキャンセルしました',
      cs_partial_fail: '翻訳が部分的に失敗：{0} / {1} 段が失敗',
      cs_complete_truncated: '翻訳完了（{0} 段、他に {1} 段がページ長超過により省略）',
      cs_complete: '翻訳完了（{0} 段）',
      cs_all_cache_hit: 'すべてキャッシュヒット・今回は課金なし',
      cs_rpd_warning_title: '注意：本日の API リクエスト数が予算上限を超えました',
      cs_rpd_warning_body: '翻訳は引き続き使用できますが、使用量にご注意ください。日次カウントは太平洋時間の午前0時にリセットされます',
      cs_translate_fail: '翻訳失敗：{0}', cs_restored: '原文を復元しました',
      cs_google_progress: '{0}Google 翻訳中… {1} / {2}',
      cs_google_complete_truncated: 'Google 翻訳完了（{0} 段、他に {1} 段がページ長超過により省略）',
      cs_google_complete: 'Google 翻訳完了（{0} 段）',
      cs_google_chars: '{0} 文字・無料', cs_auto_translate: '自動翻訳',
      cs_target_lang_name: '日本語',
      cs_spa_progress: '新しいコンテンツを翻訳中… {0} / {1}',
      cs_spa_partial_fail: '新コンテンツの翻訳が部分的に失敗：{0} / {1} 段',
      cs_spa_complete: '{0} 段の新コンテンツを翻訳しました', cs_spa_fail: '新コンテンツの翻訳に失敗：{0}',
      cs_mode_single: '単一言語', cs_mode_dual: 'バイリンガル',
      cs_mode_changed: '表示モードを「{0}」に切り替えました。ショートカットキーで再翻訳してください',
      yt_translating: '翻訳中…', yt_translate_fail: '翻訳失敗',
      yt_restored: '字幕を原文に復元しました',
      yt_waiting_cc: '字幕翻訳を開始しました。CC 字幕データを待っています…',
      yt_starting: '{0} 件の字幕を取得済み、翻訳を開始します', yt_waiting_data: '字幕データを待っています…',
      yt_activated: '字幕翻訳をオンにしました。YouTube の字幕（CC）をオンにすると自動的に翻訳が始まります。',
      yt_behind: '{0}s ⚠️ 遅延', yt_debug_title: '🔍 Shinkansen 字幕 Debug',
    },
  };

  /**
   * Content script 翻譯函式。用法：SK.t('cs_translating') 或 SK.t('cs_progress', '', 5, 10)
   */
  SK.t = function(key) {
    const table = SK._strings[SK._locale] || SK._strings['zh-TW'];
    let s = table[key] ?? SK._strings['zh-TW'][key] ?? key;
    for (let i = 1; i < arguments.length; i++) {
      s = s.replace('{' + (i - 1) + '}', arguments[i]);
    }
    return s;
  };

  // 從 storage 異步讀取語言設定（不阻塞初始化）
  try {
    browser.storage.sync.get('uiLocale').then(function(result) {
      if (result.uiLocale && SK._strings[result.uiLocale]) {
        SK._locale = result.uiLocale;
      }
    }).catch(function() {});
  } catch(e) {}

  // ─── 共用狀態 ──────────────────────────────────────────
  SK.STATE = {
    translated: false,
    translatedBy: null,      // v1.4.0: 'gemini' | 'google' | null
    translating: false,      // v0.80: 翻譯進行中（防止重複觸發 + 支援中途取消）
    abortController: null,   // v0.80: AbortController，翻譯中按 Alt+S 或離開頁面時 abort
    cache: new Map(),       // 段落文字 → 譯文
    // 記錄每個被替換過的元素與它原本的子節點快照，供還原使用。
    // v0.36 起改為 Map，key 是 element，value 是 innerHTML 字串。這樣同一個
    // element 被多個 fragment 單位改動時，只會快照一次「真正的原始 HTML」，
    // 不會被後續 fragment 的中途狀態污染。
    originalHTML: new Map(), // el → innerHTML string
    // v1.0.14: 儲存翻譯後的 innerHTML，用於偵測框架覆寫並重新套用。
    translatedHTML: new Map(), // el → innerHTML string
    // v1.0.23: 續翻模式
    stickyTranslate: false,
    // v1.4.12: 記錄本次翻譯使用的 preset slot（1/2/3），供 SPA 導航續翻 + 跨 tab sticky 用。
    // null = 非 preset 觸發（例如 autoTranslate 白名單、popup 按鈕舊路徑）。
    stickySlot: null,
    // v1.5.0: 雙語對照模式
    // displayMode：本次翻譯要用的模式（'single' 覆蓋 / 'dual' 雙語對照），讀自 storage 的設定值
    // translatedMode：本次實際翻譯時用的模式（restorePage 依此分派 single / dual 還原邏輯）
    // translationCache：dual 模式下，原段落 → wrapper 的對照表，供 Content Guard 在 SPA 刪掉
    //   wrapper 時 re-append 用。Map<originalEl, wrapperEl>
    displayMode: 'single',
    translatedMode: null,
    translationCache: new Map(),
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

  // 直接排除（純技術性元素 + 我們自己注入的譯文 wrapper）
  // v1.5.2: SHINKANSEN-TRANSLATION 加入 HARD_EXCLUDE。
  // 真實場景：BBC byline 翻譯後譯文是「《Inside Health》主持人，BBC Radio 4」，
  // CJK 字元佔比 < 50%（人名 / 節目名保留英文），不會被 isTraditionalChinese 認定，
  // 所以 isCandidateText 把譯文當「新英文段落」回傳。SPA observer 看到這個
  // 「新段落」就 translateUnits + injectDual 又疊一個 wrapper——每次 BBC 頁面
  // 自然 mutation 觸發 observer，wrapper 再疊一層，視覺上呈現「慢慢長出第二、第三個」。
  // 把 wrapper 整個 tag 標記為 HARD_EXCLUDE，detector 完全跳過 wrapper 子樹即可根治。
  SK.HARD_EXCLUDE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'CODE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SELECT',
    'SHINKANSEN-TRANSLATION',
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

  // ─── v1.5.0 雙語對照模式常數 ─────────────────────────
  SK.TRANSLATION_WRAPPER_TAG = 'shinkansen-translation';
  SK.DEFAULT_MARK_STYLE = 'tint';
  // 視覺標記合法值（options 頁 radio + content.js sanitize）
  SK.VALID_MARK_STYLES = new Set(['tint', 'bar', 'dashed', 'none']);
  // 顯示模式合法值
  SK.VALID_DISPLAY_MODES = new Set(['single', 'dual']);
  // 計算「最近的 block 祖先」用的 display 值（雙語模式 inline 段落 wrapper 用）
  SK.BLOCK_DISPLAY_VALUES = new Set([
    'block', 'flex', 'grid', 'table', 'list-item', 'flow-root',
  ]);

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
