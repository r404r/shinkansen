// background.js — Shinkansen Service Worker
// 職責：接收翻譯請求、呼叫 Gemini API、處理快取、處理快捷鍵、統一除錯 Log。

import { translateBatch, extractGlossary } from './lib/gemini.js';
import { getSettings, DEFAULT_SUBTITLE_SYSTEM_PROMPT } from './lib/storage.js';
import { debugLog, getLogs, clearLogs, getPersistedLogs, clearPersistedLogs } from './lib/logger.js';
import * as cache from './lib/cache.js';
import { RateLimiter } from './lib/rate-limiter.js';
import { getLimitsForSettings } from './lib/tier-limits.js';
import * as usageDB from './lib/usage-db.js'; // v0.86: 用量紀錄 IndexedDB

debugLog('info', 'system', 'service worker started', { version: chrome.runtime.getManifest().version });

// v1.2.11: SUBTITLE_SYSTEM_PROMPT 已移至 lib/storage.js（DEFAULT_SUBTITLE_SYSTEM_PROMPT）
// TRANSLATE_SUBTITLE_BATCH handler 從 ytSubtitle 設定讀取，不再使用硬碼常數。

// ─── Rate Limiter(全域 singleton) ──────────────────────
// 三維度 sliding window,同時約束 RPM / TPM / RPD。
// 設定變更時會透過 storage.onChanged 重新套用上限。
let limiter = null;

async function initLimiter() {
  const settings = await getSettings();
  const limits = getLimitsForSettings(settings);
  limiter = new RateLimiter(limits);
  debugLog('info', 'rate-limit', 'rate limiter initialized', {
    tier: settings.tier,
    model: settings.geminiConfig.model,
    rpm: limits.rpm,
    tpm: limits.tpm,
    rpd: limits.rpd,
    safetyMargin: limits.safetyMargin,
  });
}
initLimiter();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  // 只要設定類相關欄位變動就重新套用上限
  const relevant = ['tier', 'geminiConfig', 'safetyMargin', 'rpmOverride', 'tpmOverride', 'rpdOverride'];
  if (relevant.some(k => k in changes)) {
    getSettings().then(settings => {
      const limits = getLimitsForSettings(settings);
      if (limiter) {
        limiter.updateLimits(limits);
        debugLog('info', 'rate-limit', 'rate limiter limits updated', limits);
      } else {
        limiter = new RateLimiter(limits);
      }
    });
  }
});

/** 簡易 input token 估算:英文約 4 字元/token、中文約 1.5 字元/token,取中間值 3.5 偏保守。 */
function estimateInputTokens(texts) {
  let total = 0;
  for (const t of texts) total += t?.length || 0;
  return Math.ceil(total / 3.5);
}

// ─── 啟動時：版本檢查，版本變更則清空快取 ───────────────────
(async () => {
  const currentVersion = chrome.runtime.getManifest().version;
  const result = await cache.checkVersionAndClear(currentVersion);
  if (result.cleared) {
    debugLog('info', 'cache', 'cache cleared on version change', {
      oldVersion: result.oldVersion ?? '?',
      newVersion: currentVersion,
      removed: result.removed,
    });
  } else {
    debugLog('info', 'cache', 'cache up-to-date', { version: currentVersion });
  }
})();

// ─── 使用量累計（chrome.storage.local) ────────────────────
// 結構：
//   usageStats: {
//     totalInputTokens: number,
//     totalOutputTokens: number,
//     totalCostUSD: number,
//     since: ISO timestamp  // 最後一次重置時間
//   }
const USAGE_KEY = 'usageStats';

async function getUsageStats() {
  const { [USAGE_KEY]: s } = await chrome.storage.local.get(USAGE_KEY);
  return s || {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    since: new Date().toISOString(),
  };
}

async function addUsage(inputTokens, outputTokens, costUSD) {
  const s = await getUsageStats();
  s.totalInputTokens += inputTokens;
  s.totalOutputTokens += outputTokens;
  s.totalCostUSD += costUSD;
  await chrome.storage.local.set({ [USAGE_KEY]: s });
  return s;
}

async function resetUsageStats() {
  const fresh = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    since: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [USAGE_KEY]: fresh });
  return fresh;
}

function computeCostUSD(inputTokens, outputTokens, pricing) {
  const inRate = Number(pricing?.inputPerMTok) || 0;
  const outRate = Number(pricing?.outputPerMTok) || 0;
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/**
 * v0.48: 計算套用 Gemini implicit context cache 折扣後的實付費用。
 * Gemini 對 cache 命中部分只收原價 25%（省 75%），未命中部分與 output 全價。
 * 公式：effectiveInput = (inputTokens - cachedTokens) + cachedTokens × 0.25
 */
function computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing) {
  const uncached = Math.max(0, inputTokens - cachedTokens);
  const effectiveInput = uncached + cachedTokens * 0.25;
  return computeCostUSD(effectiveInput, outputTokens, pricing);
}

// ─── Extension icon badge(已翻譯紅點提示） ─────────────────
// 使用浮世繪圖示上的旭日紅 #cf3a2c，視覺上延續「太陽」的意象。
const BADGE_COLOR = '#cf3a2c';
const BADGE_TEXT = '●';

async function setTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    // 某些 Chrome 版本支援白色 badge 文字，舊版本會忽略此呼叫
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
    }
    await chrome.action.setBadgeText({ text: BADGE_TEXT, tabId });
  } catch (err) {
    debugLog('warn', 'system', 'setBadge failed', { error: err.message });
  }
}

async function clearTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await chrome.action.setBadgeText({ text: '', tabId });
  } catch (err) {
    debugLog('warn', 'system', 'clearBadge failed', { error: err.message });
  }
}

// 分頁重新導航時自動清掉 badge(SPA 同站導航除外，需依賴 content.js 重新通知）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTranslatedBadge(tabId);
  }
});

// ─── 訊息路由（handler map 取代 if-else 鏈） ──────────────────
const messageHandlers = {
  TRANSLATE_BATCH: {
    async: true,
    handler: (payload, sender) => handleTranslate(payload, sender),
  },
  // v1.2.10: 字幕翻譯專用——prompt / temperature / model 從 ytSubtitle 設定讀取（v1.2.11 改為動態載入）
  // v1.2.39: 支援 ytSubtitle.model（獨立模型）與 ytSubtitle.pricing（獨立計價）
  TRANSLATE_SUBTITLE_BATCH: {
    async: true,
    handler: async (payload, sender) => {
      // v1.2.51: 記錄 handler 收到訊息到真正呼叫 Gemini 的前置耗時
      // 包含：getSettings() + cache lookup + rate limiter 等待
      // 對照 api: translateBatch start 即可計算前置耗時
      const _tReceived = Date.now();
      const s = await getSettings();
      const _settingsMs = Date.now() - _tReceived;
      debugLog('info', 'youtube', 'subtitle batch received', {
        count: payload?.texts?.length || 0,
        settingsMs: _settingsMs,   // getSettings() 耗時（首次可能較慢）
      });
      const yt = s.ytSubtitle || {};
      const geminiOverrides = {
        systemInstruction: yt.systemPrompt || DEFAULT_SUBTITLE_SYSTEM_PROMPT,
        temperature: yt.temperature ?? 0.1,
      };
      // 若使用者設定了獨立 YouTube 模型，覆蓋 geminiConfig.model
      if (yt.model) geminiOverrides.model = yt.model;
      // ytSubtitle.pricing 非空時傳入，讓 handleTranslate 用正確計價計算費用
      const pricingOverride = (yt.pricing && yt.pricing.inputPerMTok != null) ? yt.pricing : null;
      return handleTranslate(payload, sender, geminiOverrides, pricingOverride);
    },
  },
  EXTRACT_GLOSSARY: {
    async: true,
    handler: (payload, sender) => handleExtractGlossary(payload, sender),
  },
  CLEAR_CACHE: {
    async: true,
    handler: () => cache.clearAll().then(removed => ({ removed })),
  },
  CACHE_STATS: {
    async: true,
    handler: () => cache.stats(),
  },
  USAGE_STATS: {
    async: true,
    handler: () => getUsageStats(),
  },
  RESET_USAGE: {
    async: true,
    handler: () => resetUsageStats(),
  },
  SET_BADGE_TRANSLATED: {
    async: true,
    handler: (_, sender) => setTranslatedBadge(sender?.tab?.id),
  },
  CLEAR_BADGE: {
    async: true,
    handler: (_, sender) => clearTranslatedBadge(sender?.tab?.id),
  },
  LOG: {
    async: false,
    handler: (payload, sender) => {
      const { level, category, message: msg, data } = payload || {};
      const enrichedData = { ...data, _tab: sender?.tab?.url || sender?.url };
      debugLog(level || 'info', category || 'system', msg || '', enrichedData);
    },
  },
  GET_LOGS: {
    async: false,
    handler: (payload) => getLogs(payload?.afterSeq || 0),
  },
  CLEAR_LOGS: {
    async: false,
    handler: () => { clearLogs(); },
  },
  // v1.2.52: 持久化 log（跨 service worker 重啟）
  GET_PERSISTED_LOGS: {
    async: true,
    handler: async () => {
      const logs = await getPersistedLogs();
      return { logs, count: logs.length };
    },
  },
  CLEAR_PERSISTED_LOGS: {
    async: true,
    handler: async () => {
      await clearPersistedLogs();
      return { ok: true };
    },
  },
  // v1.0.7: Google Docs — 在新分頁開啟 mobilebasic 版本並自動觸發翻譯
  OPEN_GDOC_MOBILE: {
    async: true,
    handler: async (payload) => {
      const url = payload?.url;
      if (!url) throw new Error('missing url');
      const tab = await chrome.tabs.create({ url });
      debugLog('info', 'system', 'opened Google Docs mobilebasic tab', { url, tabId: tab.id });

      // 等待新分頁載入完成後自動觸發翻譯
      // 透過 onUpdated 監聽 tab 的 complete 狀態，再送 TOGGLE_TRANSLATE 訊息
      return new Promise((resolve) => {
        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            // 小延遲確保 content script 已完成初始化
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' }).catch(() => {});
            }, 500);
            resolve({ tabId: tab.id });
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);

        // 安全閥：30 秒後若尚未 complete，移除 listener 避免洩漏
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve({ tabId: tab.id, timeout: true });
        }, 30000);
      });
    },
  },
  CLEAR_RPD: {
    async: true,
    handler: async () => {
      const all = await chrome.storage.local.get(null);
      const rpdKeys = Object.keys(all).filter(k => k.startsWith('rateLimit_rpd_'));
      if (rpdKeys.length) await chrome.storage.local.remove(rpdKeys);
      if (limiter) {
        limiter.rpdCount = 0;
        limiter.rpdLoaded = false;
        limiter.rpdLoadingPromise = null;
      }
      debugLog('info', 'rate-limit', 'RPD cleared via debug bridge', { removedKeys: rpdKeys });
      return { removedKeys: rpdKeys };
    },
  },
  LOG_USAGE: {
    async: true,
    handler: async (payload) => {
      const settings = await getSettings();
      const record = {
        ...payload,
        // v1.2.39: payload.model 優先（例如 YouTube 字幕用獨立模型時由 content 端傳入）
        model: payload.model || settings.geminiConfig?.model || 'unknown',
      };
      await usageDB.logTranslation(record);
    },
  },
  QUERY_USAGE: {
    async: true,
    handler: async (payload) => ({ records: await usageDB.query(payload || {}) }),
  },
  QUERY_USAGE_STATS: {
    async: true,
    handler: async (payload) => ({ stats: await usageDB.getStats(payload || {}) }),
  },
  QUERY_USAGE_CHART: {
    async: true,
    handler: async (payload) => ({ data: await usageDB.getAggregated(payload || {}) }),
  },
  EXPORT_USAGE_CSV: {
    async: true,
    handler: async (payload) => ({ csv: await usageDB.exportCSV(payload || {}) }),
  },
  CLEAR_USAGE: {
    async: true,
    handler: (payload) => {
      return payload?.beforeTimestamp
        ? usageDB.clearBefore(payload.beforeTimestamp)
        : usageDB.clearAll();
    },
  },

  // v1.3.9: Innertube 重構——從 YouTube 頁面 HTML 解析字幕軌道清單
  // 用於 SPA 導航後 content script 無法從 <script> 標籤取得最新資料的 fallback 路徑
  FETCH_YT_CAPTION_TRACKS: {
    async: true,
    handler: async (payload) => {
      const { videoId } = payload || {};
      if (!videoId) return { ok: false, error: 'missing videoId' };
      try {
        const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        const resp = await fetch(url, {
          headers: {
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const html = await resp.text();

        // 從 HTML 原始文字解析 captionTracks 陣列（與 extractCaptionTracksFromPage 邏輯相同）
        const ctIdx = html.indexOf('"captionTracks"');
        if (ctIdx === -1) return { ok: true, tracks: [] };
        const arrStart = html.indexOf('[', ctIdx);
        if (arrStart === -1) return { ok: true, tracks: [] };
        let depth = 0, i = arrStart;
        while (i < html.length) {
          if (html[i] === '[' || html[i] === '{') depth++;
          else if (html[i] === ']' || html[i] === '}') {
            depth--;
            if (depth === 0) break;
          }
          i++;
        }
        const tracks = JSON.parse(html.slice(arrStart, i + 1));
        return { ok: true, tracks: Array.isArray(tracks) ? tracks : [] };
      } catch (e) {
        debugLog('warn', 'youtube', 'FETCH_YT_CAPTION_TRACKS failed', { error: e.message });
        return { ok: false, error: e.message };
      }
    },
  },

  // v1.3.9: Innertube 重構——取得字幕原文（timedtext URL → responseText）
  // content script 負責挑選最佳軌道後把 baseUrl 傳過來，background 負責 fetch
  FETCH_YT_CAPTIONS: {
    async: true,
    handler: async (payload) => {
      const { url } = payload || {};
      if (!url) return { ok: false, error: 'missing url' };
      try {
        // 確保回傳 JSON3 格式（現有 parseJson3 解析器相容）
        const fetchUrl = url.includes('fmt=') ? url : `${url}&fmt=json3`;
        const resp = await fetch(fetchUrl, {
          headers: {
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com',
          },
          credentials: 'include',
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const responseText = await resp.text();
        if (!responseText || responseText.length < 10) {
          return { ok: false, error: 'empty response' };
        }
        return { ok: true, responseText };
      } catch (e) {
        debugLog('warn', 'youtube', 'FETCH_YT_CAPTIONS failed', { error: e.message });
        return { ok: false, error: e.message };
      }
    },
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  const entry = messageHandlers[type];
  if (!entry) return; // 不認識的訊息類型，不處理

  if (entry.async) {
    entry.handler(message.payload, sender)
      .then((result) => sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) }))
      .catch((err) => {
        debugLog('error', 'system', `${type} failed`, { error: err?.message || String(err) });
        sendResponse({ ok: false, error: err?.message || String(err) });
      });
    return true; // 保留 sendResponse 通道
  } else {
    // 同步 handler
    const result = entry.handler(message.payload, sender);
    sendResponse({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
    return false;
  }
});

// pricingOverride：傳入時（如 YouTube 獨立計價）使用；null 則沿用 settings.pricing
async function handleTranslate(payload, sender, geminiOverrides = {}, pricingOverride = null) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error('尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const texts = payload.texts;
  const glossary = payload.glossary || null;  // v0.69: 可選的術語對照表

  // 若呼叫端傳入 geminiOverrides（如字幕模式），覆蓋 geminiConfig 對應欄位。
  // pricingOverride（v1.2.39）：字幕模式可傳入獨立計價，否則沿用主設定 pricing。
  const effectiveSettings = Object.keys(geminiOverrides).length > 0
    ? { ...settings, geminiConfig: { ...settings.geminiConfig, ...geminiOverrides } }
    : settings;
  const effectivePricing = pricingOverride || settings.pricing;

  // v1.0.29: 讀取固定術語表（全域 + 當前網域），合併後傳給 translateBatch
  let fixedGlossaryEntries = null;
  const fg = settings.fixedGlossary;
  if (fg) {
    const globalEntries = Array.isArray(fg.global) ? fg.global.filter(e => e.source && e.target) : [];
    let domainEntries = [];
    if (fg.byDomain && sender?.tab?.url) {
      try {
        const hostname = new URL(sender.tab.url).hostname;
        domainEntries = Array.isArray(fg.byDomain[hostname]) ? fg.byDomain[hostname].filter(e => e.source && e.target) : [];
      } catch { /* 無效 URL，略過 */ }
    }
    // 合併：全域先、網域後（網域覆蓋全域同名術語——用 Map 去重，後出現的覆蓋前面的）
    if (globalEntries.length > 0 || domainEntries.length > 0) {
      const merged = new Map();
      for (const e of globalEntries) merged.set(e.source, e.target);
      for (const e of domainEntries) merged.set(e.source, e.target); // 網域覆蓋全域
      fixedGlossaryEntries = [...merged.entries()].map(([source, target]) => ({ source, target }));
    }
  }

  // v0.70: 若有術語表，快取 key 加上 glossary hash 後綴，
  // 確保「有術語表」與「無術語表」的翻譯分開快取。
  // 字幕模式加 '_yt' 後綴，確保字幕翻譯快取與文章翻譯快取分開存放。
  let glossaryKeySuffix = Object.keys(geminiOverrides).length > 0 ? '_yt' : '';
  const allGlossaryForHash = [
    ...(glossary || []).map(e => `${e.source}:${e.target}`),
    ...(fixedGlossaryEntries || []).map(e => `F:${e.source}:${e.target}`),
  ];
  if (allGlossaryForHash.length > 0) {
    const fullHash = await cache.hashText(allGlossaryForHash.join('|'));
    glossaryKeySuffix = '_g' + fullHash.slice(0, 12);
  }

  // 1. 先撈快取
  const cached = await cache.getBatch(texts, glossaryKeySuffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });

  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'batch cache lookup', {
    total: texts.length,
    hits: cacheHits,
    misses: missingTexts.length,
  });

  // 2. 缺的部分送 Gemini(透過 rate limiter 節流)
  let fresh = [];
  let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let batchCostUSD = 0;
  // v0.48: hoist 到 if 外面，讓後面組 return usage 能讀到
  let billedInputTokens = 0;
  let billedCostUSD = 0;
  let acquireResult = null; // v0.90: hoist 到 if 外面，讓 return 讀得到 rpdExceeded
  let batchHadMismatch = false; // v0.94: hoist 到 if 外面，讓 return 讀得到 hadMismatch
  if (missingTexts.length) {
    // 先過 rate limiter 取得一個 slot（RPM/TPM 硬限制；RPD 只回傳警告旗標）
    if (!limiter) await initLimiter();
    const estTokens = estimateInputTokens(missingTexts);
    debugLog('info', 'rate-limit', 'acquire start', { estTokens, limiterExists: !!limiter });
    const tAcq0 = Date.now();
    acquireResult = await limiter.acquire(estTokens, /* priority */ 1);
    const acquireMs = Date.now() - tAcq0;
    if (acquireMs > 50) {
      debugLog('info', 'rate-limit', 'rate limiter waited', { waitMs: acquireMs, estTokens });
    }

    const t0 = Date.now();
    const totalChars = missingTexts.reduce((s, t) => s + (t?.length || 0), 0);
    debugLog('info', 'api', 'translateBatch start', { texts: missingTexts.length, chars: totalChars });
    const res = await translateBatch(missingTexts, effectiveSettings, glossary, fixedGlossaryEntries);
    fresh = res.translations;
    batchUsage = res.usage;
    batchHadMismatch = res.hadMismatch || false; // v0.94: mismatch 旗標
    batchCostUSD = computeCostUSD(batchUsage.inputTokens, batchUsage.outputTokens, effectivePricing);
    const batchMs = Date.now() - t0;
    debugLog('info', 'api', 'translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: batchMs,
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      tabUrl: sender?.tab?.url,
    });
    // 3. 寫回快取（帶 glossary suffix 確保有/無術語表分開存）
    await cache.setBatch(missingTexts, fresh, glossaryKeySuffix);
    // 3.5 累計到全域使用量統計
    // v0.48: 改為累計「實付」值（套用 implicit cache 折扣後的等效 input tokens
    // 與實付費用），讓 popup 累計顯示的 token / 費用等於 Gemini 帳單實際扣款。
    // billedInputTokens = inputTokens - cachedTokens × 0.75
    //   （未命中的 token 全價 + 命中的 token 25% 折扣 → 等效 token 數）
    billedInputTokens = Math.max(
      0,
      Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * 0.75),
    );
    billedCostUSD = computeBilledCostUSD(
      batchUsage.inputTokens,
      batchUsage.cachedTokens || 0,
      batchUsage.outputTokens,
      effectivePricing,
    );
    await addUsage(billedInputTokens, batchUsage.outputTokens, billedCostUSD);
  }

  // 4. 合併結果（快取 + 新翻譯）按原順序回傳
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => {
    result[idx] = fresh[k];
  });
  return {
    result,
    usage: {
      // 原始（未套 implicit cache 折扣）數字，保留給 content 端算 hit% / saved%
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      // Gemini implicit context cache 命中的輸入 token 數（v0.46 新增）。
      // 注意這跟下面的 `cacheHits`(本地 tc_<sha1> 翻譯快取命中段數) 是兩回事。
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      // v0.48: 套 implicit cache 折扣後的「實付」數字。toast 與 popup 都顯示這組
      billedInputTokens,
      billedCostUSD,
      cacheHits,
    },
    // v0.90: RPD 軟性預算警告（不阻擋翻譯，只通知 content 端顯示提示）
    rpdExceeded: acquireResult?.rpdExceeded || false,
    // v0.94: 本批翻譯是否觸發了 segment mismatch fallback
    hadMismatch: batchHadMismatch,
  };
}

// ─── v0.70: 術語表擷取處理（v0.69 建立，v0.70 加強除錯與容錯） ──
async function handleExtractGlossary(payload, sender) {
  debugLog('info', 'glossary', 'glossary extraction start', { inputHash: payload.inputHash, chars: payload.compressedText?.length });
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error('尚未設定 Gemini API Key，請至設定頁填入。');
  }
  const { compressedText, inputHash } = payload;

  // 1. 先查術語表快取
  const cached = await cache.getGlossary(inputHash);
  if (cached) {
    debugLog('info', 'glossary', 'glossary cache hit', { inputHash, terms: cached.length });
    return { glossary: cached, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, fromCache: true };
  }

  // 2. v0.70: 跳過 rate limiter — 術語表是 best-effort 單次請求，
  //    不走 limiter 避免被卡住（之前因 limiter 或 retry 導致 15 秒 timeout）。
  //    extractGlossary 內部已改用 AbortController 自帶 20 秒 fetch timeout。
  debugLog('info', 'glossary', 'calling Gemini (bypassing rate limiter)');

  // 3. 呼叫 Gemini 擷取術語表
  const result = await extractGlossary(compressedText, settings);
  const { glossary, usage, _diag } = result;
  debugLog('info', 'glossary', 'Gemini returned glossary', { terms: glossary.length, usage, diag: _diag || null });

  // 4. 寫入快取（只快取有內容的術語表；空結果不快取，讓下次重試有機會成功）
  if (glossary.length > 0) {
    await cache.setGlossary(inputHash, glossary);
  }

  // 5. 累計使用量統計
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const billedInput = Math.max(
      0,
      Math.round(usage.inputTokens - (usage.cachedTokens || 0) * 0.75),
    );
    const billedCost = computeBilledCostUSD(
      usage.inputTokens,
      usage.cachedTokens || 0,
      usage.outputTokens,
      settings.pricing,
    );
    await addUsage(billedInput, usage.outputTokens, billedCost);
  }

  debugLog('info', 'glossary', 'glossary extraction complete', {
    terms: glossary.length,
    inputHash,
    tabUrl: sender?.tab?.url,
  });

  return { glossary, usage, fromCache: false, _diag: _diag || null };
}

// ─── 快捷鍵 ────────────────────────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-translate') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    // 在 chrome://、Chrome Web Store、新分頁等頁面按快捷鍵時,該 tab 沒有
    // content script listening,sendMessage 會 reject:
    //   "Could not establish connection. Receiving end does not exist."
    // 這是預期情境（使用者可能不小心按到快捷鍵),靜默吞掉即可,不讓它冒成
    // uncaught promise rejection 污染 background.js 的錯誤面板。
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' }).catch(() => {});
  }
});

// ─── 安裝/更新事件 ─────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  debugLog('info', 'system', `extension ${reason}`, { version: chrome.runtime.getManifest().version });
  // 安裝/更新時也檢查一次版本（雙重保險，SW 啟動時已經跑過一次）
  const currentVersion = chrome.runtime.getManifest().version;
  await cache.checkVersionAndClear(currentVersion);

  // v0.62 起：API Key 從 chrome.storage.sync 搬到 chrome.storage.local，
  // 避免跨 Google 帳號同步。這裡做一次主動遷移：若 sync 裡還殘留舊的 apiKey，
  // 搬到 local（沒 local 版本才搬，已經有就尊重 local）然後從 sync 刪除。
  // lib/storage.js::getSettings 也有 lazy migration 作為雙重保險。
  if (reason === 'update' || reason === 'install') {
    try {
      const { apiKey: syncKey } = await chrome.storage.sync.get('apiKey');
      if (typeof syncKey === 'string') {
        const { apiKey: localKey } = await chrome.storage.local.get('apiKey');
        if (!localKey && syncKey) {
          await chrome.storage.local.set({ apiKey: syncKey });
          debugLog('info', 'system', 'apiKey migrated from sync → local');
        }
        await chrome.storage.sync.remove('apiKey');
      }
    } catch (err) {
      debugLog('warn', 'system', 'apiKey migration failed', { error: err.message });
    }
  }
});
