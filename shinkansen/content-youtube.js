// content-youtube.js — Shinkansen YouTube 字幕翻譯模組（isolated world）
// v1.3.9：移除 MAIN world XHR 攔截，改為主動抓取架構（Innertube 重構）
//
// 依賴：window.__SK（content-ns.js）、SK.sendLog、SK.showToast、SK.hideToast
// 載入順序：必須在 content.js 之前、content-ns.js 之後
// 外部介面：SK.YT（狀態物件）、SK.translateYouTubeSubtitles、SK.stopYouTubeTranslation、SK.isYouTubePage
//
// 核心設計（v1.3.9 起）：
//   1. 主動抓取：extractCaptionTracksFromPage → selectBestTrack → background FETCH_YT_CAPTIONS
//      → 取得含時間戳的字幕 → rawSegments[{text,normText,startMs}]
//   2. SPA fallback：<script> 已過期時改由 background FETCH_YT_CAPTION_TRACKS 重新抓頁面
//   3. 按時間視窗翻譯（預設 30 秒一批），video.timeupdate 驅動觸發下一批
//   4. 在剩餘時間 < lookaheadS（預設 10 秒）時提前翻譯下一批
//   5. observer 提前啟動，支援 on-the-fly 備援（主動抓取失敗時仍可逐條即時翻譯）
//   6. 字幕翻譯設定（prompt/temperature/windowSizeS/lookaheadS）從 ytSubtitle settings 讀取

(function(SK) {

  // ─── 預設設定（storage 讀不到時用這組） ────────────────────
  const DEFAULT_YT_CONFIG = {
    windowSizeS: 30,
    lookaheadS:  10,
    debugToast:  false,
    onTheFly:    false,          // v1.2.49: cache miss 時是否送 on-the-fly API 翻譯
    // preserveLineBreaks 已移除 toggle（v1.2.38），永遠 true（見 translateWindowFrom）
  };

  // ─── Debug 狀態面板 ─────────────────────────────────────
  // 開啟 ytSubtitle.debugToast 後，頁面左上角顯示即時狀態面板。

  let _debugEl        = null;
  let _debugInterval  = null;
  let _lastEvent      = '—';
  // debugToast 開啟時，記錄已 log 過的 miss key，避免同一條字幕重複刷 log
  let _debugMissedKeys = new Set();

  function _debugRender() {
    if (!_debugEl) return;
    const YT = SK.YT;
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs : 0;
    const video   = YT.videoEl || document.querySelector('video');
    const curS    = video ? video.currentTime.toFixed(1) : '0.0';
    const speed   = video ? `${video.playbackRate}x` : '—';
    const config  = YT.config || DEFAULT_YT_CONFIG;
    // v1.2.40: buffer = translatedUpToMs - video.currentTime（正數=超前備妥，負數=字幕追不上）
    // v1.2.59: 若當前視窗 API 還在飛（translatingWindows）且尚未完成（translatedWindows 不含），
    //          buffer 顯示「翻譯中…」，不顯示因 translatedUpToMs 提前佔位造成的虛假正值。
    const bufMs   = video ? YT.translatedUpToMs - video.currentTime * 1000 : 0;
    const _curWinStart = video
      ? Math.floor(video.currentTime * 1000 / ((config.windowSizeS || 30) * 1000)) * ((config.windowSizeS || 30) * 1000)
      : 0;
    const _curWinTranslating = YT.translatingWindows?.has(_curWinStart);
    const _curWinDone        = YT.translatedWindows?.has(_curWinStart);
    const bufStr  = (_curWinTranslating && !_curWinDone)
      ? '翻譯中…'
      : bufMs >= 0
        ? `+${(bufMs / 1000).toFixed(1)}s ✓`
        : `${(bufMs / 1000).toFixed(1)}s ⚠️ 落後`;
    // v1.2.43: 各批次耗時，格式如「5230 / 7110 / 16770ms」，進行中的批次顯示「…」
    const batchArr = YT.batchApiMs || [];
    const batchStr = batchArr.length === 0
      ? (YT.lastApiMs > 0 ? `${YT.lastApiMs}ms` : '—')
      : batchArr.map(t => t > 0 ? `${t}` : '…').join(' / ') + 'ms';
    _debugEl.textContent = [
      '🔍 Shinkansen 字幕 Debug',
      `active      : ${YT.active}`,
      `translating : ${YT.translatingWindows.size > 0}（${YT.translatingWindows.size} 視窗）`,
      `speed       : ${speed}`,
      `rawSegments : ${YT.rawSegments.length} 條（涵蓋 ${Math.round(maxMs/1000)}s）`,
      `captionMap  : ${YT.captionMap.size} 條`,
      `translated↑ : ${Math.round(YT.translatedUpToMs/1000)}s`,
      `coverage    : ${YT.captionMapCoverageUpToMs > 0 ? Math.round(YT.captionMapCoverageUpToMs/1000) + 's' : '—'}`,
      `video now   : ${curS}s`,
      `buffer      : ${bufStr}`,
      `batch API   : ${batchStr}`,
      `batch0 size : ${(() => { const lead = YT.lastLeadMs; const s = YT.firstBatchSize || 8; const tag = lead <= 0 ? `⚠️ lead ${(lead/1000).toFixed(1)}s` : `lead +${(lead/1000).toFixed(1)}s`; return `${s} 條（${tag}）`; })()}`,
      `on-the-fly  : ${YT.onTheFlyTotal} 條`,
      `stale skip  : ${YT.staleSkipCount > 0 ? `⚠️ ${YT.staleSkipCount} 次` : '0'}`,
      `window/look : ${config.windowSizeS}s / ${config.lookaheadS}s`,
      `adapt look  : ${YT.adaptiveLookaheadMs > 0 ? Math.round(YT.adaptiveLookaheadMs / 1000) + 's' : '—'}`,
      `事件        : ${_lastEvent}`,
    ].join('\n');
  }

  function _debugUpdate(eventLabel) {
    const YT = SK.YT;
    if (!YT.config?.debugToast) return;
    _lastEvent = eventLabel;

    if (!_debugEl) {
      _debugEl = document.createElement('div');
      _debugEl.id = '__sk-yt-debug';
      Object.assign(_debugEl.style, {
        position:   'fixed',
        top:        '8px',
        left:       '8px',
        background: 'rgba(0,0,0,0.88)',
        color:      '#39ff14',
        fontFamily: 'monospace',
        fontSize:   '11px',
        lineHeight: '1.65',
        padding:    '8px 12px',
        borderRadius: '6px',
        zIndex:     '2147483647',
        maxWidth:   '340px',
        pointerEvents: 'none',
        whiteSpace: 'pre',
      });
      document.body.appendChild(_debugEl);
      // 啟動 500ms 重繪 timer，讓 video now / captionMap 等欄位即時更新
      _debugInterval = setInterval(_debugRender, 500);
    }

    _debugRender();
  }

  function _debugRemove() {
    if (_debugInterval) { clearInterval(_debugInterval); _debugInterval = null; }
    if (_debugEl) { _debugEl.remove(); _debugEl = null; }
    _lastEvent = '—';
    _debugMissedKeys.clear();
  }

  // ─── 字幕區狀態提示（取代 toast）─────────────────────────
  // 在 .ytp-caption-window-container 內注入一個仿原生字幕樣式的提示元素，
  // 用 setInterval 追蹤 .caption-window 位置，貼在英文字幕正上方。
  // 第一條中文字幕出現（_firstCacheHitLogged）時自動移除。

  let _captionStatusEl    = null;
  let _captionStatusTimer = null;

  function _updateCaptionStatusPosition() {
    if (!_captionStatusEl) return;
    const container = _captionStatusEl.parentElement;
    if (!container) return;

    const captionWindow = document.querySelector('.caption-window');
    if (captionWindow) {
      const contRect  = container.getBoundingClientRect();
      const capRect   = captionWindow.getBoundingClientRect();
      // 若字幕容器在畫面外（播放器未展示）則略過
      if (capRect.height === 0) return;
      const ourH      = _captionStatusEl.offsetHeight || 28;
      const relTop    = capRect.top  - contRect.top - ourH - 4;
      const relLeft   = capRect.left - contRect.left + capRect.width / 2;
      _captionStatusEl.style.top    = Math.max(2, relTop) + 'px';
      _captionStatusEl.style.bottom = '';
      _captionStatusEl.style.left   = relLeft + 'px';
    } else {
      // 尚無英文字幕：貼在字幕區預設底部位置
      _captionStatusEl.style.top    = '';
      _captionStatusEl.style.bottom = '8%';
      _captionStatusEl.style.left   = '50%';
    }
  }

  function showCaptionStatus(text) {
    // 注入目標：.ytp-caption-window-container > 我們的 div
    // 退而求其次用 #movie_player，仍在播放器範圍內
    const container =
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('#movie_player');
    if (!container) return;

    if (!_captionStatusEl) {
      _captionStatusEl = document.createElement('div');
      _captionStatusEl.id = '__sk-yt-caption-status';
      // 讀取現有字幕的字型大小，若尚無字幕則用 14px
      const seg      = document.querySelector('.ytp-caption-segment');
      const fontSize = seg ? getComputedStyle(seg).fontSize : '14px';
      Object.assign(_captionStatusEl.style, {
        position:      'absolute',
        zIndex:        '99',
        background:    'rgba(8, 8, 8, 0.75)',
        color:         '#fff',
        fontFamily:    '"YouTube Noto", Roboto, Arial, Helvetica, sans-serif',
        fontSize,
        lineHeight:    '1.5',
        padding:       '0.1em 0.45em',
        borderRadius:  '2px',
        pointerEvents: 'none',
        whiteSpace:    'nowrap',
        transform:     'translateX(-50%)',
        // 初始預設位置
        bottom:        '8%',
        left:          '50%',
      });
      container.appendChild(_captionStatusEl);

      // v1.3.5: 250ms 追蹤——每秒 4 次足夠追蹤字幕位置，節省 60% 定時器開銷（原 100ms）
      if (_captionStatusTimer) clearInterval(_captionStatusTimer);
      _captionStatusTimer = setInterval(_updateCaptionStatusPosition, 250);
      _updateCaptionStatusPosition(); // 立刻更新一次
    }

    _captionStatusEl.textContent = text;
  }

  function hideCaptionStatus() {
    if (_captionStatusTimer) {
      clearInterval(_captionStatusTimer);
      _captionStatusTimer = null;
    }
    if (_captionStatusEl) {
      _captionStatusEl.remove();
      _captionStatusEl = null;
    }
  }

  // ─── 狀態 ──────────────────────────────────────────────────
  SK.YT = {
    captionMap:       new Map(),   // normText(原文) → 譯文
    rawSegments:      [],          // [{text, normText, startMs}] sorted by startMs
    pendingQueue:     new Map(),   // on-the-fly 備案：normText → [DOM element]
    observer:         null,
    batchTimer:       null,
    flushing:         false,
    active:           false,
    videoId:          null,
    translatingWindows: new Set(), // v1.2.54: 正在翻譯中的視窗 startMs 集合（允許不同視窗並行）
    translatedUpToMs: 0,           // 已翻譯涵蓋到的時間點（ms）
    config:           null,        // ytSubtitle settings 快取
    videoEl:          null,        // video element（timeupdate 監聽對象）
    // v1.2.39: 本次影片 session 的累積用量（用於 LOG_USAGE）
    sessionUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 },
    sessionStartTime: 0,
    // v1.2.40: debug 面板診斷資料
    lastApiMs:           0,    // 第一批完成的耗時（ms），用於 buffer 監控
    batchApiMs:          [],   // v1.2.43: 各批次完成耗時陣列，debug 面板逐批顯示
    adaptiveLookaheadMs: 0,    // v1.2.44: 自適應 lookahead（根據上次 API 耗時動態調整）
    staleSkipCount:          0,    // v1.2.45: API 完成時 video 已超過 window end 的次數（追趕跳位）
    captionMapCoverageUpToMs: 0,   // v1.2.46: 實際翻過最遠的位置（僅供 debug 顯示）
    translatedWindows:    new Set(), // v1.2.48: 精確記錄已翻視窗的 windowStartMs 集合
    onTheFlyTotal:            0,   // 本 session 累計落入 on-the-fly 的字幕條數
    firstBatchSize:           8,   // v1.2.50: 最近一次視窗實際使用的首批大小（debug 用）
    lastLeadMs:               0,   // v1.2.50: 最近一次視窗起點距影片位置的 ms（負數=緊急）
    _firstCacheHitLogged:     false, // v1.2.51: 本 session 是否已記錄第一次 cache hit
  };

  // ─── 工具 ──────────────────────────────────────────────────

  SK.isYouTubePage = function isYouTubePage() {
    return location.hostname === 'www.youtube.com'
      && location.pathname.startsWith('/watch');
  };

  function normText(t) {
    return t.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getVideoIdFromUrl() {
    return new URL(location.href).searchParams.get('v') || null;
  }

  async function getYtConfig() {
    if (SK.YT.config) return SK.YT.config;
    const saved = await chrome.storage.sync.get('ytSubtitle');
    SK.YT.config = { ...DEFAULT_YT_CONFIG, ...(saved.ytSubtitle || {}) };
    return SK.YT.config;
  }

  // ─── 時間字串轉 ms（TTML 格式 "HH:MM:SS.mmm"） ────────────

  function parseTimeToMs(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':');
    const secs = parts.reduce((acc, p) => acc * 60 + parseFloat(p || 0), 0);
    return Math.round(secs * 1000);
  }

  // ─── 字幕解析：JSON3（含時間戳）────────────────────────────

  function parseJson3(text) {
    const json = JSON.parse(text);
    const segments = [];
    const seen = new Set();
    let groupCounter = 0;
    for (const ev of (json.events || [])) {
      if (!ev.segs) continue;
      const full = ev.segs.map(s => s.utf8 || '').join('');
      // YouTube 以 \n 分隔同一 event 內的多行歌詞；DOM 每行獨立渲染為一個 .ytp-caption-segment
      // 拆行後分別建立條目，確保 normText 與 DOM 字幕對齊，避免落入 on-the-fly
      // preserveLineBreaks 開啟時，同一 event 的多行共用 groupId，供整組送翻
      const lines = full.split('\n').map(l => l.trim()).filter(Boolean);
      const groupId = lines.length > 1 ? groupCounter++ : null;
      for (const line of lines) {
        if (seen.has(line)) continue;
        seen.add(line);
        segments.push({ text: line, normText: normText(line), startMs: ev.tStartMs || 0, groupId });
      }
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 字幕解析：XML/TTML（含時間戳）────────────────────────

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const els = doc.querySelectorAll('text, p');
    const segments = [];
    const seen = new Set();
    for (const el of els) {
      const t = el.textContent.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      const begin = el.getAttribute('begin') || '0';
      const startMs = begin.includes(':') ? parseTimeToMs(begin) : parseInt(begin, 10) || 0;
      segments.push({ text: t, normText: normText(t), startMs });
    }
    return segments.sort((a, b) => a.startMs - b.startMs);
  }

  // ─── 自動偵測格式並解析 ────────────────────────────────────

  function parseCaptionResponse(responseText) {
    if (!responseText) return [];
    try { return parseJson3(responseText); } catch (_) {}
    try { return parseTtml(responseText); } catch (_) {}
    return [];
  }

  // ─── v1.3.9: 主動抓取字幕軌道（取代 MAIN world XHR 攔截）────

  // 從頁面 <script> 標籤解析 ytInitialPlayerResponse 內的 captionTracks 陣列。
  // 只讀 DOM（isolated world 可存取），不需要 MAIN world。
  // videoId 用於驗證 script 內容屬於當前影片（SPA 導航後 script 可能殘留舊影片資料）。
  function extractCaptionTracksFromPage(videoId) {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      if (!text.includes('"captionTracks"')) continue;
      // 若指定了 videoId，確認此 script 確實對應當前影片
      if (videoId && !text.includes(videoId)) continue;
      try {
        const ctIdx = text.indexOf('"captionTracks"');
        if (ctIdx === -1) continue;
        const arrStart = text.indexOf('[', ctIdx);
        if (arrStart === -1) continue;
        // 計算平衡括號找 array 結尾（支援巢狀物件）
        let depth = 0, i = arrStart;
        while (i < text.length) {
          if (text[i] === '[' || text[i] === '{') depth++;
          else if (text[i] === ']' || text[i] === '}') {
            depth--;
            if (depth === 0) break;
          }
          i++;
        }
        const tracks = JSON.parse(text.slice(arrStart, i + 1));
        if (Array.isArray(tracks) && tracks.length > 0 && tracks[0].baseUrl) {
          return tracks;
        }
      } catch (_) {}
    }
    return null;
  }

  // 從 captionTracks 挑選最適合翻譯的軌道。
  // 優先序：英文人工翻譯 → 英文 ASR → 任何非中文軌道（取首個）
  function selectBestTrack(tracks) {
    if (!tracks || tracks.length === 0) return null;
    // 排除繁/簡體中文軌道（翻譯目標語言）
    const nonChinese = tracks.filter(t => !/^zh/i.test(t.languageCode || ''));
    const pool = nonChinese.length > 0 ? nonChinese : tracks;
    // 英文人工翻譯（kind 不是 'asr'）
    const enHuman = pool.find(t => /^en/i.test(t.languageCode) && t.kind !== 'asr');
    if (enHuman) return enHuman;
    // 英文 ASR（自動語音辨識）
    const enAsr = pool.find(t => /^en/i.test(t.languageCode));
    if (enAsr) return enAsr;
    // 任何非中文的第一條軌道
    return pool[0] || null;
  }

  // 主動抓取字幕資料的完整流程：
  //   1. 嘗試從頁面 <script> 解析 captionTracks（快，無額外 HTTP）
  //   2. 失敗時請 background fetch YouTube 頁面取得軌道（SPA 後 script 已過期時用）
  //   3. 挑選最佳軌道 → 請 background fetch timedtext URL → 解析成 rawSegments
  async function fetchCaptionsForVideo(videoId) {
    if (!videoId) return null;

    // Step 1：從頁面 <script> 標籤取得字幕軌道
    let tracks = extractCaptionTracksFromPage(videoId);
    const source = tracks ? 'page-script' : 'background-fetch';

    // Step 2：<script> 已過期（SPA nav 後常見）→ 請 background 抓一次完整頁面
    if (!tracks) {
      SK.sendLog('info', 'youtube', 'captionTracks not in page scripts, fetching via background', { videoId });
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'FETCH_YT_CAPTION_TRACKS',
          payload: { videoId },
        });
        tracks = res?.tracks?.length > 0 ? res.tracks : null;
      } catch (e) {
        SK.sendLog('warn', 'youtube', 'FETCH_YT_CAPTION_TRACKS error', { error: e?.message });
      }
    }

    const track = selectBestTrack(tracks);
    if (!track) {
      SK.sendLog('warn', 'youtube', 'no caption track found', {
        source,
        trackCount: tracks?.length ?? 0,
        videoId,
      });
      return null;
    }

    SK.sendLog('info', 'youtube', 'caption track selected', {
      source,
      lang: track.languageCode,
      kind: track.kind || 'human',
    });

    // Step 3：請 background fetch timedtext URL 取得字幕原文
    const captionUrl = track.baseUrl.includes('fmt=')
      ? track.baseUrl
      : track.baseUrl + '&fmt=json3';
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'FETCH_YT_CAPTIONS',
        payload: { url: captionUrl },
      });
      if (!res?.ok || !res.responseText) {
        SK.sendLog('warn', 'youtube', 'FETCH_YT_CAPTIONS returned empty', { error: res?.error });
        return null;
      }
      const segments = parseCaptionResponse(res.responseText);
      SK.sendLog('info', 'youtube', 'captions fetched', {
        segmentCount: segments.length,
        lastMs: segments.length > 0 ? segments[segments.length - 1].startMs : 0,
      });
      return segments.length > 0 ? segments : null;
    } catch (e) {
      SK.sendLog('warn', 'youtube', 'FETCH_YT_CAPTIONS error', { error: e?.message });
      return null;
    }
  }

  // ─── 翻譯單位建構（preserveLineBreaks 模式用）────────────
  // preserve=false：每條 segment 各自一個單位（現有行為）
  // preserve=true ：同一 groupId 的 segment 合成一個單位，以空格串接後整組送翻
  //   （不用 \n 串接，避免 LLM 誤輸出 literal \n 字串進譯文）
  //   翻完後第一個 key 存完整合併譯文，其餘 key 存空字串讓 DOM segment 視覺消失

  function buildTranslationUnits(segs, preserve) {
    if (!preserve) {
      return segs.map(s => ({ text: s.text, keys: [s.normText] }));
    }
    const units = [];
    let i = 0;
    while (i < segs.length) {
      const seg = segs[i];
      if (seg.groupId != null) {
        // 收集所有相鄰且 groupId 相同的 segment
        const group = [seg];
        let j = i + 1;
        while (j < segs.length && segs[j].groupId === seg.groupId) {
          group.push(segs[j]);
          j++;
        }
        units.push({ text: group.map(s => s.text).join(' '), keys: group.map(s => s.normText) });
        i = j;
      } else {
        units.push({ text: seg.text, keys: [seg.normText] });
        i++;
      }
    }
    return units;
  }

  // ─── 時間視窗翻譯 ──────────────────────────────────────────

  async function translateWindowFrom(windowStartMs) {
    const YT = SK.YT;
    if (YT.translatingWindows.has(windowStartMs)) return;  // v1.2.54: per-window 防重入
    if (!YT.active) return;

    // 取得設定
    const config = await getYtConfig();
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const windowEndMs  = windowStartMs + windowSizeMs;

    // 標記「已排程翻譯到此位置」，防止 timeupdate 重複觸發
    YT.translatedUpToMs = windowEndMs;
    YT.translatingWindows.add(windowStartMs);  // v1.2.54: 加入 Set，允許其他視窗並行

    // v1.3.5: try-finally 確保 translatingWindows.delete 無論如何都會執行
    // （涵蓋：正常完成、!YT.active 提前 return、catch 繼續後到達 finally）
    try {

    // v1.2.48: 若此視窗已確實翻過（Set 精確記錄），直接推進不送 API。
    // 舊版用 captionMapCoverageUpToMs（高水位線）判斷，但高水位線不保證連續覆蓋：
    // 若使用者從中間開始看，前段從未翻過，向後拖時高水位線誤判「已翻」導致字幕空白。
    if (YT.translatedWindows.has(windowStartMs)) return;  // try-finally 會清理

    // 找出本視窗內的字幕（[windowStartMs, windowEndMs)）
    const windowSegs = YT.rawSegments.filter(
      s => s.startMs >= windowStartMs && s.startMs < windowEndMs
    );

    SK.sendLog('info', 'youtube', 'translateWindow start', {
      windowStartMs, windowEndMs, segCount: windowSegs.length,
      sessionOffsetMs: Date.now() - YT.sessionStartTime,  // v1.2.51: 距 session 啟動的 ms
    });
    if (config.debugToast && windowSegs.length > 0) {
      SK.sendLog('info', 'youtube-debug', 'translateWindow texts', {
        window: `${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s`,
        texts: windowSegs.map(s => ({ ms: s.startMs, norm: s.normText })),
      });
    }
    _debugUpdate(`翻譯視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s（${windowSegs.length} 條）`);

    if (windowSegs.length > 0) {
      // v1.2.42: 串流注入（streaming injection）——各批次一完成就立刻寫入 captionMap，
      // 不等其他批次。原本 Promise.all 後統一注入：所有批次都需等最慢那批（T_max）。
      // 改用 .then() 串流：第一批 T₁ 秒可用，第二批 T₂ 秒可用（T₁ ≤ T₂ ≤ T₃），
      // 早出現的字幕（batch 0）最快備妥，後續 timeupdate 觸發替換時命中率更高。
      // lastApiMs 改記最快完成批次的耗時（buffer 最關鍵的是第一批何時好）。
      // v1.2.47: 字幕批次大小從 20 降為 8。
      // 頁面翻譯的 CHUNK_SIZE=20 是針對「段落」設計，每段落數百字，密度高。
      // 字幕段落極短（平均 3-5 字），密度低（~0.6 條/秒）：
      //   20 條/批 × 0.6 條/秒 ≈ 33 秒的字幕 → 30 秒視窗只有 1 批，並行無效。
      //   8 條/批 × 0.6 條/秒 ≈ 13 秒的字幕 → 30 秒視窗有 2–3 批，串流注入生效。
      // 另一效果：每批 input tokens 減半，API 處理時間從 ~17s 降至 ~7s，
      // adapt look 自然收斂到更小值，buffer overrun 次數減少。
      const BATCH = 8;
      const preserve = true; // v1.2.38 起固定開啟，已移除設定頁 toggle
      const units = buildTranslationUnits(windowSegs, preserve);
      try {
        // 1. 切好每批的 units（批次索引 = 時間順序，batch 0 最早出現）
        // v1.2.50: 自適應首批大小（adaptive first batch size）
        // 以「視窗起點距影片當前位置的 lead time」決定 batch 0 的條數：
        //   lead ≤ 0（影片已超過視窗起點，緊急）→ 1 條：最小 payload，最快回傳
        //   lead < 5s → 2 條；lead < 10s → 4 條；lead ≥ 10s → 8 條（正常）
        // 首批條數愈少，input/output tokens 愈少，API 回傳愈快，
        // 第一條字幕出現的延遲從 ~10s（batch=8）有望降至 ~5s（batch=1）。
        // 其餘批次仍用 BATCH=8 並行送出，不影響後續字幕速度。
        const videoNowMs = YT.videoEl ? YT.videoEl.currentTime * 1000 : 0;
        const leadMs = windowStartMs - videoNowMs;
        const firstBatchSize = leadMs <= 0    ? 1
                             : leadMs < 5000  ? 2
                             : leadMs < 10000 ? 4
                             : BATCH;
        YT.firstBatchSize = firstBatchSize;
        YT.lastLeadMs     = leadMs;
        SK.sendLog('info', 'youtube', 'adaptive batch0', {
          leadMs: Math.round(leadMs), firstBatchSize, totalUnits: units.length,
        });
        const batches = [];
        if (units.length > 0) {
          batches.push(units.slice(0, Math.min(firstBatchSize, units.length)));
          for (let i = firstBatchSize; i < units.length; i += BATCH) {
            batches.push(units.slice(i, i + BATCH));
          }
        }

        // 2. 使用者還原時中止
        if (!YT.active) return;  // v1.3.5: try-finally 會清理

        // 3. 串流注入：各批次一完成立刻注入 captionMap。
        // v1.2.56: batch 0 先 await，再並行送其餘批次。
        // 根本原因：並行送出時所有批次同時命中 Gemini implicit cache 冷路徑，
        // 小批次（1-3 units）剛好 1.5s 跑完，大批次（8 units）冷路徑需 13s；
        // 讓 batch 0（adaptive size，1-4 units）先完成暖熱 cache，
        // 再並行送 batch 1+，使大批次走暖路徑（~2s）。
        // 效果：第一視窗首條字幕從 ~13s 降至 ~3.5s；後續視窗 cache 已熱，
        // batch 0（2s）+ batch 1+（2s 並行）= 4s，比純並行（2s）多 2s 但仍在
        // adaptive lookahead 預警範圍內，使用者感知不受影響。
        const _t0 = Date.now();
        // v1.2.43: 每個視窗重置 batchApiMs，預先填好 placeholder 確保順序對齊
        // v1.3.5: 使用局部 _batchApiMs 收集計時，視窗完成後才同步至 YT.batchApiMs，
        // 避免多視窗並行翻譯時互相覆蓋共用陣列。進行中各批次顯示 '…'，完成後顯示實際 ms。
        const _batchApiMs = new Array(batches.length).fill(0);

        // 批次處理器（每批完成後立刻注入 captionMap 並替換 DOM 字幕）
        const _runBatch = (batchUnits, b) =>
          chrome.runtime.sendMessage({
            type: 'TRANSLATE_SUBTITLE_BATCH',
            payload: { texts: batchUnits.map(u => u.text), glossary: null },
          }).then(res => {
            const elapsed = Date.now() - _t0;
            _batchApiMs[b] = elapsed;
            if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
            _logWindowUsage(batchUnits.length, res.usage);
            for (let j = 0; j < batchUnits.length; j++) {
              const unit     = batchUnits[j];
              const rawTrans = res.result[j] || unit.text;
              if (unit.keys.length === 1) {
                YT.captionMap.set(unit.keys[0], rawTrans);
              } else {
                // 多行群組：合併為單行顯示
                const merged = rawTrans.replace(/\\n/g, ' ').replace(/\n/g, ' ').trim();
                YT.captionMap.set(unit.keys[0], merged);
                for (let k = 1; k < unit.keys.length; k++) YT.captionMap.set(unit.keys[k], '');
              }
            }
            // 每批注入後立刻替換頁面上已顯示的字幕
            const domSegs = document.querySelectorAll('.ytp-caption-segment');
            domSegs.forEach(replaceSegmentEl);
            SK.sendLog('info', 'youtube', `batch done`, {
              batchIdx: b,
              batchSize: batchUnits.length,
              elapsedMs: elapsed,
              sessionOffsetMs: Date.now() - YT.sessionStartTime,
              domSegmentCount: domSegs.length,
              captionMapSize: YT.captionMap.size,
            });
          });

        // v1.2.56: batch 0 先 await（暖熱 cache），再並行送 batch 1+
        if (batches.length > 0) {
          await _runBatch(batches[0], 0);
          YT.lastApiMs = _batchApiMs[0]; // batch 0 是第一個完成的，記錄其耗時
          if (!YT.active) return;  // v1.3.5: try-finally 會清理
          if (batches.length > 1) {
            await Promise.all(batches.slice(1).map((bu, i) => _runBatch(bu, i + 1)));
          }
        }

        // v1.3.5: 所有批次完成，將局部計時陣列同步至共用狀態供 debug 面板讀取
        YT.batchApiMs = _batchApiMs;
      } catch (err) {
        SK.sendLog('error', 'youtube', 'window translation failed', { error: err.message });
      }
    }

    // v1.2.46/v1.2.48: 記錄此視窗已翻完
    YT.captionMapCoverageUpToMs = Math.max(YT.captionMapCoverageUpToMs, windowEndMs);
    YT.translatedWindows.add(windowStartMs); // Set 精確記錄，供 seek-back 跳過判斷用

    // v1.2.45: 過期視窗追趕機制——API 完成時若 video 已超過 translatedUpToMs（window end），
    // 代表這個視窗的字幕早就過了，直接把翻譯起點跳到 video 現在所在的視窗邊界，
    // 讓 translating = false 後 timeupdate 立刻觸發翻譯「現在」的內容，而不是繼續翻過期的視窗。
    // 不過期時此區塊完全不執行，對正常流程零影響。
    const catchUpVideoMs = YT.videoEl ? Math.floor(YT.videoEl.currentTime * 1000) : 0;
    if (catchUpVideoMs > YT.translatedUpToMs) {
      const catchUpNewStart = Math.floor(catchUpVideoMs / windowSizeMs) * windowSizeMs;
      YT.staleSkipCount++;
      SK.sendLog('warn', 'youtube', '⚠️ 視窗過期，跳位追趕', {
        videoNowMs: catchUpVideoMs,
        windowEnd:  YT.translatedUpToMs,
        jumpTo:     catchUpNewStart,
        staleSkipCount: YT.staleSkipCount,
      });
      YT.translatedUpToMs = catchUpNewStart;
      _debugUpdate(`⚠️ 過期跳位 → ${Math.round(catchUpNewStart / 1000)}s（第 ${YT.staleSkipCount} 次）`);
    }

    // v1.2.44: 自適應 lookahead——根據剛完成視窗的 API 耗時動態調整下次觸發點。
    // 若 lastApiMs > 設定值，下次提前觸發，確保 buffer 不會被 API 耗時吃光。
    // 取 lastApiMs × 1.3（安全餘量 30%）與設定值的較大者，上限 60 秒。
    if (YT.lastApiMs > 0) {
      const configLookaheadMs = (YT.config?.lookaheadS ?? DEFAULT_YT_CONFIG.lookaheadS) * 1000;
      const playbackRate = YT.videoEl?.playbackRate || 1;
      const needed = Math.ceil(YT.lastApiMs * 1.3 * playbackRate);
      YT.adaptiveLookaheadMs = Math.min(Math.max(needed, configLookaheadMs), 60000);
    }

    _debugUpdate(`視窗 ${Math.round(windowStartMs/1000)}–${Math.round(windowEndMs/1000)}s 完成（captionMap: ${YT.captionMap.size}）`);

    // 檢查是否還有未翻譯的字幕
    const maxMs = YT.rawSegments.length > 0
      ? YT.rawSegments[YT.rawSegments.length - 1].startMs
      : 0;
    if (YT.translatedUpToMs <= maxMs && YT.active) {
      SK.sendLog('info', 'youtube', 'more captions remain', {
        translatedUpToMs: YT.translatedUpToMs, maxMs,
      });
    }

    } finally {
      // v1.3.5: 統一清理——無論正常完成、!YT.active 提前 return 或例外，
      // 都確保此視窗從「翻譯中」Set 移除，防止 per-window 防重入鎖死。
      YT.translatingWindows.delete(windowStartMs);
    }
  }

  // ─── video.timeupdate 驅動（觸發下一視窗）────────────────

  function onVideoTimeUpdate() {
    const YT = SK.YT;
    // v1.2.54: 移除 translating guard — translateWindowFrom 內部用 translatingWindows Set 防重入，
    // 讓 timeupdate 可在當前視窗翻譯進行中提前啟動下一個視窗（消除英文字幕間隙）
    if (!YT.active || YT.rawSegments.length === 0) return;

    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    // v1.2.44: effectiveLookaheadMs 取設定值與自適應值的較大者。
    // 自適應值在每個視窗完成後根據上次 API 耗時 × 1.3 更新，確保下次觸發足夠早。
    // 速度愈快，play-time lookahead 也需要等比例放大，讓 real-time 餘量維持不變。
    const configLookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);
    const lookaheadMs = Math.max(configLookaheadMs, YT.adaptiveLookaheadMs || 0);

    const currentMs = video.currentTime * 1000;

    // 所有字幕都翻完了
    const maxMs = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    // 若距離已翻譯邊界不足 lookaheadMs，或已超過，立刻翻下一批
    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`timeupdate 觸發下一批（now: ${Math.round(currentMs/1000)}s，up to: ${Math.round(YT.translatedUpToMs/1000)}s）`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  // ─── video.ratechange 驅動（切換播放速度時重新檢查是否需要立刻翻譯）──
  // 切速後 lookaheadMs 改變（乘以新 playbackRate），當前位置可能已進入新的
  // 預警範圍但 timeupdate 還沒觸發；直接在 ratechange 時做一次檢查。

  function onVideoRateChange() {
    const YT = SK.YT;
    if (!YT.active || YT.rawSegments.length === 0) return;  // v1.2.54: 移除 translating guard
    const video = YT.videoEl;
    if (!video) return;

    const config = YT.config || DEFAULT_YT_CONFIG;
    const configLookaheadMs = (config.lookaheadS || 10) * 1000 * (video.playbackRate || 1);
    const lookaheadMs = Math.max(configLookaheadMs, YT.adaptiveLookaheadMs || 0);
    const currentMs   = video.currentTime * 1000;
    const maxMs       = YT.rawSegments[YT.rawSegments.length - 1].startMs;
    if (YT.translatedUpToMs > maxMs) return;

    if (currentMs >= YT.translatedUpToMs - lookaheadMs) {
      _debugUpdate(`ratechange(${video.playbackRate}x) 觸發下一批`);
      translateWindowFrom(YT.translatedUpToMs);
    }
  }

  // ─── video.seeked 驅動（跳轉後重設翻譯起點）──────────────
  // 向前跳：新位置超出 translatedUpToMs → captionMap 缺對應條目，需立刻翻譯。
  // 向後跳：新位置在已翻範圍內 → captionMap 仍有效，但 translatedUpToMs 須重置，
  //         否則 buffer 顯示暴衝（+1345s 等不合理數字）。
  // v1.2.46：統一重置 translatedUpToMs；translateWindowFrom 內有 captionMapCoverageUpToMs
  //          跳過判斷，向後拖後重播已翻範圍不會重複送 API。

  function onVideoSeeked() {
    const YT = SK.YT;
    if (!YT.active || YT.rawSegments.length === 0) return;
    const video = YT.videoEl;
    if (!video) return;

    const currentMs    = video.currentTime * 1000;
    const config       = YT.config || DEFAULT_YT_CONFIG;
    const windowSizeMs = (config.windowSizeS || 30) * 1000;
    const newWindowStart = Math.floor(currentMs / windowSizeMs) * windowSizeMs;

    // 不論向前或向後，一律重設翻譯起點（向後拖時讓 buffer 顯示回到合理值）
    YT.translatedUpToMs = newWindowStart;
    _debugUpdate(`seeked → 重設翻譯起點 ${Math.round(newWindowStart/1000)}s`);
    // v1.2.57: 若跳到尚未翻譯的視窗，立刻顯示「翻譯中…」提示
    // （translateWindowFrom 內部有防重入，已翻視窗會直接 return，不需要提示）
    if (!YT.translatedWindows.has(newWindowStart)) {
      showCaptionStatus('翻譯中…');
    }
    // v1.2.54: translateWindowFrom 內部用 translatingWindows Set 防重入，無需外部 guard
    translateWindowFrom(newWindowStart);
  }

  function attachVideoListener() {
    const YT = SK.YT;
    const video = document.querySelector('video');
    if (!video || YT.videoEl === video) return;
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate', onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',     onVideoSeeked);
      YT.videoEl.removeEventListener('ratechange', onVideoRateChange);
    }
    YT.videoEl = video;
    video.addEventListener('timeupdate', onVideoTimeUpdate);
    video.addEventListener('seeked',     onVideoSeeked);
    video.addEventListener('ratechange', onVideoRateChange);
  }

  // ─── MutationObserver：即時替換字幕 ──────────────────────

  // 判斷字串是否已含中日韓字元（表示已翻譯完成）
  // 用途：el.textContent 賦值會觸發 characterData mutation，若不跳過中文譯文會形成迴圈
  const RE_CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;


  // ─── 字幕行展開（防止長譯文折行 + 維持置中）──────────────────────
  // 注入中文譯文後無條件展開字幕框：
  //   方法 A：segment 設 nowrap，確保文字不在 segment 內折行
  //   方法 B：向上走遍所有 block 容器，全部設 width: max-content
  //   方法 C：到達 caption-window 時修正置中定位——
  //     YouTube 原本用「left: 50% + margin-left: -固定寬/2」置中，
  //     寬度改為 max-content 後 margin-left 算法失效導致偏右；
  //     改為清除 margin-left，改用 transform: translateX(-50%) 置中，
  //     讓容器永遠以自身寬度的一半為中心點對齊 left: 50%。

  function expandCaptionLine(el) {
    // 方法 A：segment 自身設 nowrap，覆蓋 YouTube 預設的 pre-wrap
    el.style.whiteSpace = 'nowrap';
    // 方法 B + C：向上走所有 block 容器
    let node = el.parentElement;
    while (node && !node.classList.contains('ytp-caption-window-container')) {
      const display = getComputedStyle(node).display;
      if (display !== 'inline' && display !== 'inline-block') {
        node.style.maxWidth = 'none';
        node.style.width = 'max-content';
        if (node.classList.contains('caption-window')) {
          // YouTube 的 margin-left 是 -固定寬/2，寬度改後不再準確；
          // 改用 transform 置中，自動適應任意寬度
          node.style.marginLeft = '0';
          node.style.transform = 'translateX(-50%)';
          break; // caption-window 是最外需修改的層，到此為止
        }
      }
      node = node.parentElement;
    }
  }

  function replaceSegmentEl(el) {
    if (!SK.YT.active) return;
    const original = el.textContent.trim();
    if (!original) return;
    // 已含中日韓字元 → 這是我們設置的譯文被 characterData mutation 觸發回呼，直接跳過
    if (RE_CJK.test(original)) return;
    const key = normText(original);

    // 快取命中 → 瞬間替換
    const cached = SK.YT.captionMap.get(key);
    if (cached !== undefined) {
      if (el.textContent !== cached) {
        // v1.2.51: 第一次 cache hit = 使用者第一次「看到」翻譯字幕的時刻
        const YT = SK.YT;
        if (cached && !YT._firstCacheHitLogged) {
          YT._firstCacheHitLogged = true;
          SK.sendLog('info', 'youtube', '🎯 first translated subtitle visible', {
            sessionOffsetMs: Date.now() - YT.sessionStartTime,  // 距 session 啟動幾 ms
            videoNowMs: Math.round((YT.videoEl?.currentTime || 0) * 1000),
            captionMapSize: YT.captionMap.size,
            key: key.slice(0, 40),
          });
        }
        // v1.2.58: 每次中文字幕出現都呼叫 hideCaptionStatus（冪等，無提示時直接 return）
        // 修正：seek 後 _firstCacheHitLogged 已為 true，但 showCaptionStatus 可能已再次顯示，
        // 只靠 !_firstCacheHitLogged gate 會導致新顯示的提示永遠不被移除。
        if (cached) hideCaptionStatus();
        el.textContent = cached;
        // 同步展開字幕框（不用 rAF——新版 expandCaptionLine 純設 style，不需量測 layout；
        // 若用 rAF，瀏覽器會先 paint 出「中文 + 舊 315px 容器」再展開，造成一幀閃爍）
        if (cached) expandCaptionLine(el);
      }
      return;
    }

    // 快取未命中（尚未翻譯到的視窗）→ on-the-fly 備案
    // v1.2.49: onTheFly 關閉時不送 API，等預翻完成自然命中快取即可
    if (!SK.YT.config?.onTheFly) return;

    // v1.2.40: 計入 debug 面板的 on-the-fly 累計（每個 key 只算一次，避免同一字幕重複計）
    if (!_debugMissedKeys.has(key)) SK.YT.onTheFlyTotal++;
    if (SK.YT.config?.debugToast && !_debugMissedKeys.has(key)) {
      _debugMissedKeys.add(key);
      SK.sendLog('warn', 'youtube-debug', 'captionMap miss → on-the-fly', {
        domText: original,
        normKey: key,
        captionMapSize: SK.YT.captionMap.size,
        rawSegCount: SK.YT.rawSegments.length,
      });
    }
    if (!SK.YT.pendingQueue.has(key)) SK.YT.pendingQueue.set(key, []);
    SK.YT.pendingQueue.get(key).push(el);
    clearTimeout(SK.YT.batchTimer);
    SK.YT.batchTimer = setTimeout(flushOnTheFly, 300);
  }

  async function flushOnTheFly() {
    const YT = SK.YT;
    if (YT.pendingQueue.size === 0 || YT.flushing) return;
    YT.flushing = true;

    const queue = new Map(YT.pendingQueue);
    YT.pendingQueue.clear();
    const texts = Array.from(queue.keys());

    if (YT.config?.debugToast) {
      SK.sendLog('info', 'youtube-debug', 'flushOnTheFly batch', {
        count: texts.length,
        texts,
      });
    }

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE_SUBTITLE_BATCH',
        payload: { texts, glossary: null },
      });
      if (!res?.ok) throw new Error(res?.error || '翻譯失敗');
      // v1.2.39: 累積並記錄 on-the-fly 批次用量
      _logWindowUsage(texts.length, res.usage);

      for (let i = 0; i < texts.length; i++) {
        const key = texts[i];
        const trans = res.result[i] || texts[i];
        YT.captionMap.set(key, trans);
        for (const el of (queue.get(key) || [])) {
          if (document.contains(el) && normText(el.textContent) === key) {
            el.textContent = trans;
          }
        }
      }
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'on-the-fly flush error', { error: err.message });
    }

    YT.flushing = false;
    if (YT.pendingQueue.size > 0) setTimeout(flushOnTheFly, 100);
  }

  function startCaptionObserver() {
    const YT = SK.YT;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }

    // 先替換現有字幕
    document.querySelectorAll('.ytp-caption-segment').forEach(replaceSegmentEl);

    YT.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.classList.contains('ytp-caption-segment')) {
            replaceSegmentEl(node);
          } else {
            node.querySelectorAll?.('.ytp-caption-segment').forEach(replaceSegmentEl);
          }
        }
        if (m.type === 'characterData') {
          const parent = m.target.parentElement;
          if (parent?.classList?.contains('ytp-caption-segment')) {
            replaceSegmentEl(parent);
          }
        }
      }
    });

    const root =
      document.querySelector('.ytp-caption-window-container') ||
      document.querySelector('#movie_player') ||
      document.body;

    YT.observer.observe(root, { childList: true, subtree: true, characterData: true });
    SK.sendLog('info', 'youtube', 'caption observer started', {
      root: root.className || root.tagName,
      translatedUpToMs: YT.translatedUpToMs,
    });
    _debugUpdate(`Observer 已啟動（root: ${root.className?.slice(0,30) || root.tagName}）`);
  }

  // ─── v1.2.39: 用量累積與紀錄 ──────────────────────────────
  // 每次 TRANSLATE_SUBTITLE_BATCH 回傳後，累積到 YT.sessionUsage；
  // 同時立刻送出 LOG_USAGE（逐批紀錄，方便查看每段字幕的費用細目）。

  function _logWindowUsage(batchTexts, usage) {
    if (!usage || (usage.inputTokens === 0 && usage.cacheHits === 0)) return;
    const YT = SK.YT;
    const u = usage;

    // 累積 session 合計
    YT.sessionUsage.inputTokens     += u.inputTokens     || 0;
    YT.sessionUsage.outputTokens    += u.outputTokens    || 0;
    YT.sessionUsage.cachedTokens    += u.cachedTokens    || 0;
    YT.sessionUsage.billedInputTokens += u.billedInputTokens || 0;
    YT.sessionUsage.billedCostUSD   += u.billedCostUSD   || 0;
    YT.sessionUsage.segments        += batchTexts;
    YT.sessionUsage.cacheHits       += u.cacheHits       || 0;

    // 取得本次使用的模型名稱（from config，若設定了 ytModel 就帶入）
    const model = (YT.config?.model) || undefined;

    chrome.runtime.sendMessage({
      type: 'LOG_USAGE',
      payload: {
        url:   location.href,
        title: document.title,
        source: 'youtube-subtitle',
        model,
        inputTokens:      u.inputTokens     || 0,
        outputTokens:     u.outputTokens    || 0,
        cachedTokens:     u.cachedTokens    || 0,
        billedInputTokens: u.billedInputTokens || 0,
        billedCostUSD:    u.billedCostUSD   || 0,
        segments:         batchTexts,
        cacheHits:        u.cacheHits       || 0,
        durationMs:       0,  // 字幕翻譯是串流式，不計整頁耗時
        timestamp:        Date.now(),
      },
    }).catch(() => {});
  }

  // ─── 停止 ─────────────────────────────────────────────────

  function stopYouTubeTranslation() {
    const YT = SK.YT;
    clearTimeout(YT.batchTimer);
    YT.batchTimer = null;
    if (YT.observer) { YT.observer.disconnect(); YT.observer = null; }
    if (YT.videoEl) {
      YT.videoEl.removeEventListener('timeupdate',  onVideoTimeUpdate);
      YT.videoEl.removeEventListener('seeked',      onVideoSeeked);    // v1.3.1: 補漏
      YT.videoEl.removeEventListener('ratechange',  onVideoRateChange); // v1.3.1: 補漏
      YT.videoEl = null;
    }
    YT.active             = false;
    YT.translatingWindows = new Set();  // v1.2.54
    YT.translatedWindows  = new Set();  // v1.3.5: 補齊（原僅在 translateYouTubeSubtitles 重置）
    YT.translatedUpToMs   = 0;
    YT.rawSegments        = [];         // v1.3.5: 補齊（原僅在 yt-navigate-finish 重置）
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();
    hideCaptionStatus(); // v1.2.55
    _debugRemove();
    SK.sendLog('info', 'youtube', 'stopped');
  }

  SK.stopYouTubeTranslation = stopYouTubeTranslation;

  // ─── 主入口：Alt+S ─────────────────────────────────────────

  SK.translateYouTubeSubtitles = async function translateYouTubeSubtitles() {
    const YT = SK.YT;

    // 切換：再按一次還原
    if (YT.active) {
      stopYouTubeTranslation();
      SK.showToast('success', '已還原原文字幕');
      setTimeout(() => SK.hideToast(), 2000);
      return;
    }

    YT.active  = true;
    YT.videoId = getVideoIdFromUrl();
    YT.config  = null; // 強制重新讀取設定
    // v1.2.39: 重置用量累積器
    YT.sessionUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, billedInputTokens: 0, billedCostUSD: 0, segments: 0, cacheHits: 0 };
    YT.sessionStartTime = Date.now();
    // v1.2.40: 重置 debug 診斷欄位
    YT.lastApiMs           = 0;
    YT.batchApiMs          = [];   // v1.2.43
    YT.adaptiveLookaheadMs = 0;    // v1.2.44
    YT.staleSkipCount            = 0;    // v1.2.45
    YT.captionMapCoverageUpToMs  = 0;    // v1.2.46
    YT.translatedWindows         = new Set(); // v1.2.48
    YT.translatingWindows        = new Set(); // v1.2.54
    YT.onTheFlyTotal             = 0;
    YT.firstBatchSize            = 8;         // v1.2.50
    YT.lastLeadMs                = 0;         // v1.2.50
    YT._firstCacheHitLogged      = false;     // v1.2.51

    // v1.3.9: 提前掛監聽器，不等字幕資料回來（使用者可能在抓取期間拖進度條）
    attachVideoListener();

    const config = await getYtConfig();
    _debugUpdate('字幕翻譯已啟動，取得字幕中…');

    // v1.3.9: observer 提前啟動，支援 on-the-fly 模式（即使主動抓取失敗也能運作）
    // captionMap 尚空時 replaceSegmentEl 會 cache miss → onTheFly=false → return，字幕保持原文
    startCaptionObserver();
    showCaptionStatus('取得字幕…');

    // v1.3.9: 主動抓取字幕（取代等待 MAIN world XHR 攔截）
    const segments = await fetchCaptionsForVideo(YT.videoId);

    if (!YT.active) return; // 使用者在抓取期間按下還原，直接中止

    if (segments && segments.length > 0) {
      YT.rawSegments = segments;
      // verbose log：列出全部 rawSegments 原文，供除錯比對 DOM 字幕用
      if (config.debugToast) {
        SK.sendLog('info', 'youtube-debug', 'rawSegments full list', {
          count: segments.length,
          segments: segments.map(s => ({ ms: s.startMs, text: s.text, norm: s.normText })),
        });
      }
      _debugUpdate(`取得 ${segments.length} 條字幕，開始翻譯`);
      const video = document.querySelector('video');
      const currentMs = video ? Math.floor(video.currentTime * 1000) : 0;
      const windowSizeMs = (config.windowSizeS || 30) * 1000;
      const windowStartMs = Math.floor(currentMs / windowSizeMs) * windowSizeMs;
      showCaptionStatus('翻譯中…');
      await translateWindowFrom(windowStartMs);
      // hideCaptionStatus 由第一條中文字幕出現時觸發（replaceSegmentEl 內呼叫）
    } else {
      // 主動抓取失敗或無字幕 → on-the-fly 模式仍然可用（若使用者已開啟 CC）
      _debugUpdate('字幕取得失敗，等待 on-the-fly');
      if (config.onTheFly) {
        hideCaptionStatus();
        // on-the-fly observer 已啟動，會在字幕出現時逐條即時翻譯
      } else {
        hideCaptionStatus();
        SK.showToast('success', '找不到字幕。請確認此影片有英文字幕（CC），或在設定中開啟「即時翻譯」。');
      }
    }

    SK.sendLog('info', 'youtube', 'activated', {
      videoId: YT.videoId,
      rawSegments: YT.rawSegments.length,
      windowSizeS: config.windowSizeS,
      lookaheadS:  config.lookaheadS,
    });
  };

  // ─── SPA 導航重置 ──────────────────────────────────────────

  window.addEventListener('yt-navigate-finish', async () => {
    const YT = SK.YT;
    const wasActive = YT.active;  // v1.3.1: 記錄是否需要在新影片自動重啟
    if (YT.active) stopYouTubeTranslation(); // stopYouTubeTranslation 內已呼叫 hideCaptionStatus + _debugRemove
    hideCaptionStatus(); // v1.2.55: 確保 SPA 導航後殘留的提示也清掉
    _debugRemove(); // 確保即使非 active 狀態也清掉面板（內含 _debugMissedKeys.clear()）
    YT.rawSegments        = [];
    YT.captionMap         = new Map();
    YT.pendingQueue       = new Map();      // v1.3.5: 確保清理 on-the-fly 佇列
    YT.translatedUpToMs   = 0;
    YT.translatedWindows  = new Set();      // v1.3.5: 明確重置（原在 translateYouTubeSubtitles 重置）
    YT.translatingWindows = new Set();      // v1.3.5: 防止 SPA nav 期間的殘留視窗阻塞
    YT.config             = null;
    YT.videoId            = getVideoIdFromUrl();
    SK.sendLog('info', 'youtube', 'SPA navigation reset', { wasActive, newVideoId: YT.videoId });

    // v1.3.1: SPA 導航後自動重啟字幕翻譯
    // 條件：之前字幕翻譯已啟動（wasActive），或 ytSubtitle.autoTranslate 設定開啟
    // 若導航到非 watch 頁（例如首頁），略過。
    // 延遲 500ms 等 YouTube 播放器初始化並發出新字幕 XHR
    if (!SK.isYouTubePage?.()) return;
    try {
      const saved = await chrome.storage.sync.get('ytSubtitle');
      const shouldRestart = wasActive || saved.ytSubtitle?.autoTranslate;
      if (shouldRestart) {
        SK.sendLog('info', 'youtube', 'SPA nav: will restart subtitle translation', {
          wasActive, autoTranslate: saved.ytSubtitle?.autoTranslate,
        });
        setTimeout(() => {
          // 若使用者在等待期間已手動操作（active 變 true），不重複啟動
          if (!SK.YT.active && SK.isYouTubePage?.()) {
            SK.translateYouTubeSubtitles?.().catch(err => {
              SK.sendLog('warn', 'youtube', 'SPA nav auto-subtitle restart failed', { error: err.message });
            });
          }
        }, 500);
      }
    } catch (err) {
      SK.sendLog('warn', 'youtube', 'SPA nav autoTranslate check failed', { error: err.message });
    }
  });

})(window.__SK);
