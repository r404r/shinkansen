// background.js — Shinkansen Service Worker
// 職責：接收翻譯請求、呼叫 Gemini API、處理快取、處理快捷鍵、統一除錯 Log。

import { browser } from './lib/compat.js';
import { translateBatch, extractGlossary } from './lib/gemini.js';
import { translateBatch as translateBatchCustom } from './lib/openai-compat.js'; // v1.5.7
import { translateGoogleBatch } from './lib/google-translate.js';
import { getSettings, DEFAULT_SUBTITLE_SYSTEM_PROMPT } from './lib/storage.js';
import { debugLog, getLogs, clearLogs, getPersistedLogs, clearPersistedLogs } from './lib/logger.js';
import * as cache from './lib/cache.js';
import { RateLimiter } from './lib/rate-limiter.js';
import { getLimitsForSettings } from './lib/tier-limits.js';
import * as usageDB from './lib/usage-db.js'; // v0.86: 用量紀錄 IndexedDB
import { getPricingForModel } from './lib/model-pricing.js';  // v1.4.12: preset 依 model 查定價
import { sessionStore } from './lib/session-storage.js';  // v1.5: 跨平台 session storage
import { detectForbiddenTermLeaks } from './lib/forbidden-terms.js'; // v1.5.6

debugLog('info', 'system', 'service worker started', { version: browser.runtime.getManifest().version });

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

browser.storage.onChanged.addListener((changes, area) => {
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
  const currentVersion = browser.runtime.getManifest().version;
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

// ─── 使用量累計（browser.storage.local) ────────────────────
// 結構：
//   usageStats: {
//     totalInputTokens: number,
//     totalOutputTokens: number,
//     totalCostUSD: number,
//     since: ISO timestamp  // 最後一次重置時間
//   }
const USAGE_KEY = 'usageStats';

async function getUsageStats() {
  const { [USAGE_KEY]: s } = await browser.storage.local.get(USAGE_KEY);
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
  await browser.storage.local.set({ [USAGE_KEY]: s });
  return s;
}

async function resetUsageStats() {
  const fresh = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUSD: 0,
    since: new Date().toISOString(),
  };
  await browser.storage.local.set({ [USAGE_KEY]: fresh });
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
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    // 某些 Chrome 版本支援白色 badge 文字，舊版本會忽略此呼叫
    if (browser.action.setBadgeTextColor) {
      await browser.action.setBadgeTextColor({ color: '#ffffff', tabId });
    }
    await browser.action.setBadgeText({ text: BADGE_TEXT, tabId });
  } catch (err) {
    debugLog('warn', 'system', 'setBadge failed', { error: err.message });
  }
}

async function clearTranslatedBadge(tabId) {
  if (tabId == null) return;
  try {
    await browser.action.setBadgeText({ text: '', tabId });
  } catch (err) {
    debugLog('warn', 'system', 'clearBadge failed', { error: err.message });
  }
}

// 分頁重新導航時自動清掉 badge(SPA 同站導航除外，需依賴 content.js 重新通知）
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTranslatedBadge(tabId);
  }
});

// ─── v1.4.11 跨 tab sticky 翻譯（v1.4.12 改存 preset slot） ──────────
// 使用者在 tab A 按任一 preset 快速鍵翻譯後，從 A 點連結開到 tab B 會自動翻譯，
// 跟著 openerTabId 樹傳遞。跳到無 opener 的新 tab（手動打網址 / bookmark）不繼承。
// 每個 tab 記錄自己當時用的 preset slot（1/2/3），新 tab 繼承相同 slot——
// 尊重使用者當時按的引擎+模型（Flash / Flash Lite / Google MT 各自繼承）。
// 按任意 preset 快速鍵在已翻譯狀態 → restorePage → STICKY_CLEAR 只清當前 tab。
// 持久化於 chrome.storage.session，service worker 休眠重啟後仍保留。

const stickyTabs = new Map(); // tabId → slot (number)
let _stickyHydrated = false;

// v1.5.4: storage.session 是 Chrome 102+ / Firefox 129+ 才有的 in-memory storage。
// 舊版 Firefox（< 129）沒有此 API → fallback 到 storage.local（會 disk-persist，
// 但 onCreated/onRemoved listener 會自動同步，stale 資料風險可接受）。
// Chrome 端 storage.session 一定存在 → 行為跟修改前完全一致，效能 0 影響。
const _stickyStorage = (browser.storage && browser.storage.session) ?? browser.storage.local;

async function hydrateStickyTabs() {
  if (_stickyHydrated) return;
  _stickyHydrated = true;
  // Firefox fallback: 先清除上次 session 殘留，再讀取（Chrome 為 no-op）
  await sessionStore.clearOnStartup();
  try {
    const saved = await sessionStore.get('stickyTabs');
    if (saved && typeof saved === 'object') {
      for (const [tabId, slot] of Object.entries(saved)) {
        // v1.4.12 前的舊值是 'gemini'/'google' 字串，重啟後忽略舊格式避免誤觸發
        if (typeof slot === 'number') stickyTabs.set(Number(tabId), slot);
      }
    }
  } catch (err) {
    debugLog('warn', 'system', 'hydrateStickyTabs failed', { error: err.message });
  }
}

async function persistStickyTabs() {
  try {
    const obj = {};
    stickyTabs.forEach((slot, tabId) => { obj[tabId] = slot; });
    await sessionStore.set('stickyTabs', obj);
  } catch (err) {
    debugLog('warn', 'system', 'persistStickyTabs failed', { error: err.message });
  }
}

browser.tabs.onCreated.addListener(async (tab) => {
  await hydrateStickyTabs();
  const openerId = tab.openerTabId;
  if (openerId == null) return;
  const slot = stickyTabs.get(openerId);
  if (slot == null) return;
  stickyTabs.set(tab.id, slot);
  await persistStickyTabs();
  debugLog('info', 'system', 'sticky inherited from opener', {
    newTabId: tab.id, openerTabId: openerId, slot,
  });
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  if (!stickyTabs.has(tabId)) return;
  stickyTabs.delete(tabId);
  await persistStickyTabs();
});

// ─── 訊息路由（handler map 取代 if-else 鏈） ──────────────────
const messageHandlers = {
  TRANSLATE_BATCH: {
    async: true,
    handler: (payload, sender) => {
      // v1.4.12: preset 快速鍵可傳 modelOverride 覆蓋 geminiConfig.model，
      // 其他欄位（prompt、temperature）沿用全域設定。沿用既有 geminiOverrides 機制。
      const overrides = payload?.modelOverride ? { model: payload.modelOverride } : {};
      return handleTranslate(payload, sender, overrides);
    },
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
      return handleTranslate(payload, sender, geminiOverrides, pricingOverride, '_yt');
    },
  },
  // v1.4.0: Google Translate 網頁翻譯（不需 API Key，不走 rate limiter，快取 key 用 _gt 後綴）
  TRANSLATE_BATCH_GOOGLE: {
    async: true,
    handler: (payload, sender) => handleTranslateGoogle(payload, sender, '_gt'),
  },
  // v1.5.7: OpenAI-compatible 自訂 Provider 翻譯（chat.completions endpoint）
  // 不走 rate limiter，cache key 加 baseUrl hash + model 分區。
  TRANSLATE_BATCH_CUSTOM: {
    async: true,
    handler: (payload, sender) => handleTranslateCustom(payload, sender),
  },
  // v1.5.7: API Key 測試 — 設定頁「測試」按鈕觸發。
  // Gemini 走 GET models/<model>?key=<key> 不耗 token；
  // OpenAI-compat 走 POST /chat/completions max_tokens=1 ping，耗 ~1 token。
  TEST_GEMINI_KEY: {
    async: true,
    handler: (payload) => testGeminiKey(payload),
  },
  TEST_CUSTOM_PROVIDER: {
    async: true,
    handler: (payload) => testCustomProvider(payload),
  },
  // v1.4.0: Google Translate 字幕翻譯（快取 key 用 _gt_yt 後綴）
  TRANSLATE_SUBTITLE_BATCH_GOOGLE: {
    async: true,
    handler: (payload, sender) => handleTranslateGoogle(payload, sender, '_gt_yt'),
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
  // v1.4.11 跨 tab sticky 翻譯（v1.4.12 起 value = preset slot number）
  STICKY_QUERY: {
    async: true,
    handler: async (_, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: true, shouldTranslate: false };
      const slot = stickyTabs.get(tabId);
      return { ok: true, shouldTranslate: slot != null, slot: slot ?? null };
    },
  },
  STICKY_SET: {
    async: true,
    handler: async (payload, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'no tab id' };
      const slot = Number(payload?.slot);
      if (!Number.isInteger(slot) || slot < 1) return { ok: false, error: 'invalid slot' };
      stickyTabs.set(tabId, slot);
      await persistStickyTabs();
      return { ok: true };
    },
  },
  STICKY_CLEAR: {
    async: true,
    handler: async (_, sender) => {
      await hydrateStickyTabs();
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false };
      stickyTabs.delete(tabId);
      await persistStickyTabs();
      return { ok: true };
    },
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
      const tab = await browser.tabs.create({ url });
      debugLog('info', 'system', 'opened Google Docs mobilebasic tab', { url, tabId: tab.id });

      // 等待新分頁載入完成後自動觸發翻譯
      // 透過 onUpdated 監聽 tab 的 complete 狀態，再送 TOGGLE_TRANSLATE 訊息
      return new Promise((resolve) => {
        const onUpdated = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            browser.tabs.onUpdated.removeListener(onUpdated);
            // 小延遲確保 content script 已完成初始化
            setTimeout(() => {
              browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' }).catch(() => {});
            }, 500);
            resolve({ tabId: tab.id });
          }
        };
        browser.tabs.onUpdated.addListener(onUpdated);

        // 安全閥：30 秒後若尚未 complete，移除 listener 避免洩漏
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve({ tabId: tab.id, timeout: true });
        }, 30000);
      });
    },
  },
  CLEAR_RPD: {
    async: true,
    handler: async () => {
      const all = await browser.storage.local.get(null);
      const rpdKeys = Object.keys(all).filter(k => k.startsWith('rateLimit_rpd_'));
      if (rpdKeys.length) await browser.storage.local.remove(rpdKeys);
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
      // v1.5.7: 依 payload.engine 決定 model 該從哪裡取——這樣 Alt+A/S 切不同 preset
      // 寫入紀錄的 model 才會是該批 API 真實使用的模型。
      // - 'openai-compat'：自訂模型，model 從 settings.customProvider.model
      // - 其他（gemini）：優先 payload.model（preset modelOverride），否則 fallback 全域
      let resolvedModel;
      if (payload.engine === 'openai-compat') {
        resolvedModel = settings.customProvider?.model || 'unknown';
      } else {
        resolvedModel = payload.model || settings.geminiConfig?.model || 'unknown';
      }
      const record = {
        ...payload,
        engine: payload.engine || 'gemini',
        model: resolvedModel,
      };
      // v1.4.18: YouTube 字幕一支影片會分成多批翻譯，逐批寫入會變幾十筆。
      // 改由 upsertYouTubeUsage 以 (videoId + model, 1 小時視窗) 合併成一筆；
      // 換模型或超過 1 小時才拆新筆。網頁翻譯仍走 logTranslation。
      if (record.source === 'youtube-subtitle' && record.videoId) {
        await usageDB.upsertYouTubeUsage(record);
      } else {
        await usageDB.logTranslation(record);
      }
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

  // v1.3.12: FETCH_YT_CAPTIONS 已移除。
  // YouTube 字幕資料由 content-youtube-main.js 的 XHR monkey-patch 攔截取得，
  // 不再透過 background 主動 fetch（YouTube timedtext URL 即使 same-origin 也因 exp=xpv 需要 POT）。
};

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
async function handleTranslate(payload, sender, geminiOverrides = {}, pricingOverride = null, cacheTag = '') {
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
  // v1.4.12: preset 帶 modelOverride 時，從內建表查對應 model 的 pricing，
  // 確保 toast / usage log 的費用與 model 一致（Flash Lite $0.10/$0.30、Flash $0.50/$3.00）。
  // 優先順序：pricingOverride（字幕獨立計價） > modelOverride 查表 > settings.pricing
  let effectivePricing = pricingOverride;
  if (!effectivePricing && geminiOverrides.model) {
    effectivePricing = getPricingForModel(geminiOverrides.model);
  }
  if (!effectivePricing) {
    effectivePricing = settings.pricing;
  }

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

  // v1.5.6: 中國用語黑名單。從 settings 讀清單後一路傳到 translateBatch（注入到 systemInstruction），
  // 同時計算 hash 加進 cache key 後綴，讓使用者修改清單後既有快取自動失效。
  // 空清單時 hash 為空字串，不附加後綴，向下相容既有 v1.5.5 之前的快取 key。
  const forbiddenTermsList = Array.isArray(settings.forbiddenTerms) ? settings.forbiddenTerms : [];

  // v0.70: 若有術語表，快取 key 加上 glossary hash 後綴，
  // 確保「有術語表」與「無術語表」的翻譯分開快取。
  // v1.4.12: cacheTag 由呼叫端明確指定（'_yt' = 字幕模式 / '' = 網頁翻譯含 preset）。
  // 不再用 geminiOverrides 是否有值來判斷，因為 preset 快速鍵也會傳 { model } override，
  // 會被誤判為字幕模式污染快取。
  let glossaryKeySuffix = cacheTag;
  const allGlossaryForHash = [
    ...(glossary || []).map(e => `${e.source}:${e.target}`),
    ...(fixedGlossaryEntries || []).map(e => `F:${e.source}:${e.target}`),
  ];
  if (allGlossaryForHash.length > 0) {
    const fullHash = await cache.hashText(allGlossaryForHash.join('|'));
    glossaryKeySuffix = '_g' + fullHash.slice(0, 12);
  }
  // v1.5.6: 黑名單 hash。空清單時回傳 ''，不附加後綴。
  const forbiddenHash = await cache.hashForbiddenTerms(forbiddenTermsList);
  if (forbiddenHash) {
    glossaryKeySuffix += '_b' + forbiddenHash;
  }
  // v1.4.12: 把 model 字串納入 cache key，避免同段文字在不同 preset 之間共用快取
  // （例如先按 Alt+A 走 Flash Lite 翻過，再按 Alt+S 走 Flash 應該重新打 API，不該命中 Flash Lite 的舊譯文）。
  const modelStr = effectiveSettings.geminiConfig?.model || 'unknown';
  glossaryKeySuffix += '_m' + modelStr.replace(/[^a-z0-9.\-]/gi, '_');

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
    const res = await translateBatch(missingTexts, effectiveSettings, glossary, fixedGlossaryEntries, forbiddenTermsList);
    fresh = res.translations;
    batchUsage = res.usage;
    batchHadMismatch = res.hadMismatch || false; // v0.94: mismatch 旗標

    // v1.5.6: 翻譯成功後掃描黑名單詞，命中時用 debugLog 寫一條 forbidden-term-leak warn。
    // 純記錄、不修改譯文（修改交給 prompt，硬規則 §7）。adapter 把 detect 函式的
    // logger.warn(category, message, data) 介面轉成 debugLog('warn', category, message, data)。
    detectForbiddenTermLeaks(fresh, missingTexts, forbiddenTermsList, {
      warn: (category, message, data) => debugLog('warn', category, message, data),
    });
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

// ─── v1.5.7: API Key 測試（設定頁「測試」按鈕觸發）─────────────
//
// 設計：兩條 endpoint 各有對應的最便宜驗證方式。回傳統一結構
// { ok: boolean, status?: number, message: string }，options 端只看訊息顯示綠/紅。

/**
 * 測試 Gemini API Key 有效性。
 * 走 `GET models/<model>?key=<apiKey>`——不耗 token，能驗 key 有效 + model 存在。
 */
async function testGeminiKey(payload) {
  const apiKey = (payload?.apiKey || '').trim();
  const model = (payload?.model || 'gemini-3-flash-preview').trim();
  if (!apiKey) return { ok: false, message: 'API Key 為空，請先填入再測試。' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}?key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      return { ok: true, status: resp.status, message: `連線成功（model: ${j?.name || model}）` };
    }
    let errMsg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); errMsg = j?.error?.message || errMsg; } catch { /* noop */ }
    return { ok: false, status: resp.status, message: errMsg };
  } catch (err) {
    return { ok: false, message: '網路錯誤：' + (err?.message || String(err)) };
  }
}

/**
 * 測試自訂 OpenAI-compatible Provider。
 * 走 `POST /chat/completions` 帶 max_tokens=1 + 「ping」訊息——耗 ~1 token，
 * 同時驗證 baseUrl / model / apiKey 三者皆正確。比 GET /models 通用（部分
 * provider 不支援 GET /models）。
 */
async function testCustomProvider(payload) {
  const baseUrl = (payload?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = (payload?.model || '').trim();
  const apiKey = (payload?.apiKey || '').trim();
  if (!baseUrl) return { ok: false, message: 'Base URL 為空。' };
  if (!model) return { ok: false, message: '模型 ID 為空。' };
  if (!apiKey) return { ok: false, message: 'API Key 為空。' };

  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    });
    if (resp.ok) {
      const j = await resp.json().catch(() => ({}));
      const used = j?.usage?.total_tokens || j?.usage?.prompt_tokens || 0;
      return { ok: true, status: resp.status, message: `連線成功（${model}，本次用量約 ${used} tokens）` };
    }
    let errMsg = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      errMsg = j?.error?.message || j?.message || errMsg;
    } catch { /* noop */ }
    return { ok: false, status: resp.status, message: errMsg };
  } catch (err) {
    return { ok: false, message: '網路錯誤：' + (err?.message || String(err)) };
  }
}

// ─── v1.5.7: OpenAI-compatible 自訂 Provider 批次處理 ─────────
// 與 handleTranslate（Gemini）不同：bypass rate limiter（OpenRouter 等
// provider 自己處理配額；既有 fetchWithRetry 的 429 退避已能應付），cache key
// 用 _oc base tag + baseUrl hash + safe model 分區，計價來自 customProvider 自填。
// 與 Gemini 共用：fixedGlossary、forbiddenTerms、自動 glossary 注入、cache module。
async function handleTranslateCustom(payload, sender) {
  const settings = await getSettings();
  const cp = settings.customProvider || {};
  if (!cp.apiKey) throw new Error('尚未設定自訂 Provider 的 API Key，請至設定頁填入。');
  if (!cp.baseUrl) throw new Error('尚未設定自訂 Provider 的 Base URL。');
  if (!cp.model) throw new Error('尚未設定自訂 Provider 的模型 ID。');

  const texts = payload.texts;
  const glossary = payload.glossary || null;

  // 重用 handleTranslate 內的 fixedGlossary 合併邏輯
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
    if (globalEntries.length > 0 || domainEntries.length > 0) {
      const merged = new Map();
      for (const e of globalEntries) merged.set(e.source, e.target);
      for (const e of domainEntries) merged.set(e.source, e.target);
      fixedGlossaryEntries = [...merged.entries()].map(([source, target]) => ({ source, target }));
    }
  }

  const forbiddenTermsList = Array.isArray(settings.forbiddenTerms) ? settings.forbiddenTerms : [];

  // Cache key：'_oc' base tag + glossary/forbidden hash + baseUrl hash + safe model
  let suffix = '_oc';
  const allGlossaryForHash = [
    ...(glossary || []).map(e => `${e.source}:${e.target}`),
    ...(fixedGlossaryEntries || []).map(e => `F:${e.source}:${e.target}`),
  ];
  if (allGlossaryForHash.length > 0) {
    const fullHash = await cache.hashText(allGlossaryForHash.join('|'));
    suffix += '_g' + fullHash.slice(0, 12);
  }
  const forbiddenHash = await cache.hashForbiddenTerms(forbiddenTermsList);
  if (forbiddenHash) {
    suffix += '_b' + forbiddenHash;
  }
  // baseUrl hash 6 字元 + safe model — 避免不同 provider 同 model name 共用快取
  const baseUrlHash = (await cache.hashText(cp.baseUrl)).slice(0, 6);
  const safeModel = String(cp.model).replace(/[^a-z0-9.\-]/gi, '_');
  suffix += `_m${baseUrlHash}_${safeModel}`;

  // 1. 撈快取
  const cached = await cache.getBatch(texts, suffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });
  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'openai-compat batch cache lookup', {
    total: texts.length, hits: cacheHits, misses: missingTexts.length,
  });

  // 2. 缺的部分送 OpenAI-compat
  let fresh = [];
  let batchUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  let batchCostUSD = 0;
  let batchHadMismatch = false;
  if (missingTexts.length) {
    const t0 = Date.now();
    const totalChars = missingTexts.reduce((s, t) => s + (t?.length || 0), 0);
    debugLog('info', 'api', 'openai-compat translateBatch start', {
      texts: missingTexts.length, chars: totalChars, baseUrl: cp.baseUrl, model: cp.model,
    });
    const res = await translateBatchCustom(missingTexts, settings, glossary, fixedGlossaryEntries, forbiddenTermsList);
    fresh = res.translations;
    batchUsage = res.usage;
    batchHadMismatch = res.hadMismatch || false;
    batchCostUSD = computeCostUSD(batchUsage.inputTokens, batchUsage.outputTokens, {
      inputPerMTok: cp.inputPerMTok || 0,
      outputPerMTok: cp.outputPerMTok || 0,
    });
    const batchMs = Date.now() - t0;
    debugLog('info', 'api', 'openai-compat translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: batchMs,
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
    });

    // 3. 翻譯成功後掃黑名單漏網（純記錄）
    detectForbiddenTermLeaks(fresh, missingTexts, forbiddenTermsList, {
      warn: (category, message, data) => debugLog('warn', category, message, data),
    });

    // 4. 寫回快取
    await cache.setBatch(missingTexts, fresh, suffix);

    // 5. 累計用量（cachedTokens 走 25% 折扣與 Gemini 同邏輯——OpenAI cache 命中折扣率類似）
    const billedInput = Math.max(
      0, Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * 0.75),
    );
    const billedCost = computeBilledCostUSD(
      batchUsage.inputTokens,
      batchUsage.cachedTokens || 0,
      batchUsage.outputTokens,
      { inputPerMTok: cp.inputPerMTok || 0, outputPerMTok: cp.outputPerMTok || 0 },
    );
    await addUsage(billedInput, batchUsage.outputTokens, billedCost);
  }

  // 6. 合併結果
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });

  return {
    result,
    usage: {
      inputTokens: batchUsage.inputTokens,
      outputTokens: batchUsage.outputTokens,
      cachedTokens: batchUsage.cachedTokens || 0,
      costUSD: batchCostUSD,
      billedInputTokens: Math.max(
        0, Math.round(batchUsage.inputTokens - (batchUsage.cachedTokens || 0) * 0.75),
      ),
      billedCostUSD: computeBilledCostUSD(
        batchUsage.inputTokens,
        batchUsage.cachedTokens || 0,
        batchUsage.outputTokens,
        { inputPerMTok: cp.inputPerMTok || 0, outputPerMTok: cp.outputPerMTok || 0 },
      ),
      cacheHits,
    },
    rpdExceeded: false, // 不走 rate limiter
    hadMismatch: batchHadMismatch,
  };
}

// ─── v1.4.0: Google Translate 批次處理 ────────────────────────
// 與 handleTranslate 不同：不走 rate limiter、不走術語表、費用 $0。
// cacheSuffix：網頁翻譯用 '_gt'，字幕翻譯用 '_gt_yt'，確保快取與 Gemini 分開存放。
async function handleTranslateGoogle(payload, sender, cacheSuffix) {
  const texts = payload?.texts;
  if (!Array.isArray(texts) || texts.length === 0) {
    return { result: [], usage: { engine: 'google', chars: 0 } };
  }

  // v1.6: 根據 uiLocale 決定 Google Translate 目標語言
  const settings = await getSettings();
  const targetLang = settings.uiLocale || 'zh-TW';

  // 1. 先查快取（與 Gemini 快取共用 cache module，但 key suffix 不同）
  const cached = await cache.getBatch(texts, cacheSuffix);
  const missingIdxs = [];
  const missingTexts = [];
  cached.forEach((tr, i) => {
    if (tr == null) {
      missingIdxs.push(i);
      missingTexts.push(texts[i]);
    }
  });

  const cacheHits = texts.length - missingTexts.length;
  debugLog('info', 'cache', 'google batch cache lookup', {
    total: texts.length, hits: cacheHits, misses: missingTexts.length,
  });

  // 2. 缺失的部分呼叫 Google Translate
  let fresh = [];
  let totalChars = 0;
  if (missingTexts.length > 0) {
    const t0 = Date.now();
    debugLog('info', 'api', 'google translateBatch start', { count: missingTexts.length });
    const res = await translateGoogleBatch(missingTexts, targetLang);
    fresh = res.translations;
    totalChars = res.chars;
    debugLog('info', 'api', 'google translateBatch done', {
      count: missingTexts.length,
      chars: totalChars,
      elapsed: Date.now() - t0,
    });

    // 3. 寫回快取
    await cache.setBatch(missingTexts, fresh, cacheSuffix);

    // 4. 記錄用量（費用 $0，以字元計）
    // v1.5.7: 走 upsertGoogleUsage 合併同一篇 URL 一小時內的批次到單一紀錄，
    // 避免一篇 BBC 長文炸出 5–20 筆同 URL Google MT entry。
    await usageDB.upsertGoogleUsage({
      url: sender?.tab?.url || '',
      title: '',
      engine: 'google',
      model: 'google-translate',
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      billedInputTokens: 0,
      billedCostUSD: 0,
      chars: totalChars,
      segments: missingTexts.length,
      cacheHits,
      durationMs: 0,
      timestamp: Date.now(),
    });
  }

  // 5. 合併結果
  const result = cached.slice();
  missingIdxs.forEach((idx, k) => { result[idx] = fresh[k]; });

  return {
    result,
    usage: { engine: 'google', chars: totalChars, cacheHits },
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
// v1.4.12: 三個 preset 快捷鍵（Alt+A/S/D 預設，可在 chrome://extensions/shortcuts 改）。
// 每個對應 translatePresets[slot-1]，由 content.js 依 preset.engine/model 派送。
browser.commands.onCommand.addListener(async (command) => {
  const match = command.match(/^translate-preset-(\d+)$/);
  if (!match) return;
  const slot = Number(match[1]);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // 在 chrome://、Chrome Web Store、新分頁等頁面按快捷鍵時,該 tab 沒有
  // content script listening,sendMessage 會 reject:
  //   "Could not establish connection. Receiving end does not exist."
  // 這是預期情境（使用者可能不小心按到快捷鍵),靜默吞掉即可,不讓它冒成
  // uncaught promise rejection 污染 background.js 的錯誤面板。
  browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PRESET', payload: { slot } }).catch(() => {});
});

// ─── 安裝/更新事件 ─────────────────────────────────────────
browser.runtime.onInstalled.addListener(async ({ reason }) => {
  debugLog('info', 'system', `extension ${reason}`, { version: browser.runtime.getManifest().version });
  // 安裝/更新時也檢查一次版本（雙重保險，SW 啟動時已經跑過一次）
  const currentVersion = browser.runtime.getManifest().version;
  await cache.checkVersionAndClear(currentVersion);

  // v0.62 起：API Key 從 browser.storage.sync 搬到 browser.storage.local，
  // 避免跨 Google 帳號同步。這裡做一次主動遷移：若 sync 裡還殘留舊的 apiKey，
  // 搬到 local（沒 local 版本才搬，已經有就尊重 local）然後從 sync 刪除。
  // lib/storage.js::getSettings 也有 lazy migration 作為雙重保險。
  if (reason === 'update' || reason === 'install') {
    try {
      const { apiKey: syncKey } = await browser.storage.sync.get('apiKey');
      if (typeof syncKey === 'string') {
        const { apiKey: localKey } = await browser.storage.local.get('apiKey');
        if (!localKey && syncKey) {
          await browser.storage.local.set({ apiKey: syncKey });
          debugLog('info', 'system', 'apiKey migrated from sync → local');
        }
        await browser.storage.sync.remove('apiKey');
      }
    } catch (err) {
      debugLog('warn', 'system', 'apiKey migration failed', { error: err.message });
    }
  }
});
