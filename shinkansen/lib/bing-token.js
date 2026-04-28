// lib/bing-token.js — Bing Translate token 管理（Nozomi 獨立模組）
//
// Bing 翻譯端點（/ttranslatev3）需要 session token。
// 流程：GET bing.com/translator → 從 HTML 提取 IG/key/token → 快取 + 過期刷新。
// Token 持久化到 storage.session（Chrome）或 storage.local（Firefox fallback），
// 避免 MV3 Service Worker 掛起後丟失。
//
// 設計決定：
// - 並發鎖：多個 batch 同時翻譯時不重複刷新 token
// - endpointMode：auto（自動偵測）/ global（www.bing.com）/ china（cn.bing.com）
// - auth 失敗時由呼叫端（bing-translate.js）觸發 forceRefresh

import { browser } from './compat.js';

const HOSTS = {
  global: 'https://www.bing.com',
  china: 'https://cn.bing.com',
};

const STORAGE_KEY = '_sk_bing_token';
const DEFAULT_TTL_MS = 25 * 60 * 1000; // 25 分鐘（保守值，Bing token 通常 30 分鐘有效）

// ─── 持久化 storage ─────────────────────────────────────
// 延遲解析避免 compat.js Proxy 在 import 時就被綁定（Codex P3）
function _getStorage() {
  return browser.storage?.session ?? browser.storage?.local;
}

async function _loadCached() {
  try {
    const result = await _getStorage().get(STORAGE_KEY);
    return result[STORAGE_KEY] || null;
  } catch { return null; }
}

async function _saveCached(data) {
  try {
    await _getStorage().set({ [STORAGE_KEY]: data });
  } catch { /* 靜默失敗 */ }
}

async function _clearCached() {
  try {
    await _getStorage().remove(STORAGE_KEY);
  } catch { /* 靜默失敗 */ }
}

// ─── Token 提取 ──────────────────────────────────────────

/**
 * 從 Bing Translator 頁面 HTML 中提取 token 資訊。
 * @param {string} html — bing.com/translator 的完整 HTML
 * @returns {{ ig: string, iid: string, key: string, token: string, tokenTs: number, tokenExpiryInterval: number } | null}
 */
function _extractTokenFromHTML(html) {
  // IG — 頁面 session ID（格式可能是 IG:"xxx" 或 data-iid 格式）
  const igMatch = html.match(/IG:"([A-Fa-f0-9]+)"/) || html.match(/ig["\s]*[:=]["\s]*"?([A-Fa-f0-9]{32})"?/i);
  if (!igMatch) return null;
  const ig = igMatch[1];

  // IID — 通常是 translator.xxx 的 data-iid 屬性
  const iidMatch = html.match(/data-iid="([^"]+)"/);
  const iid = iidMatch ? iidMatch[1] : 'translator.5023';

  // key + token + tokenTs + tokenExpiryInterval
  // 格式：params_AbusePreventionHelper = [timestamp,"token",timeout,"key",...];
  // 參考 plainheart/bing-translate-api：提取整個陣列再 parse，不依賴精確欄位順序
  // Codex P2: \s* 允許任意空白；不用 JSON.parse 而用寬容的 JS 字面量解析
  const paramsMatch = html.match(/params_AbusePreventionHelper\s*=\s*([^\]]+\])/);
  if (!paramsMatch) return null;

  // 從 JS 陣列字面量中提取數字和字串，不依賴 JSON.parse（避免尾逗號、單引號等問題）
  const raw = paramsMatch[1];
  const numbers = [];
  const strings = [];
  // 提取數字
  for (const m of raw.matchAll(/(?:^|[,\[]\s*)(\d+(?:\.\d+)?)/g)) {
    numbers.push(Number(m[1]));
  }
  // 提取字串（支援雙引號和單引號）
  for (const m of raw.matchAll(/["']([^"']+)["']/g)) {
    strings.push(m[1]);
  }
  const params = [...numbers.map(n => n), ...strings]; // 合併供下方分類

  // 陣列格式：[timestamp, "token", expiryInterval, "key", ...]
  // 但欄位順序可能變動，用型別判斷而非固定索引
  let key = '', token = '', tokenTs = 0, tokenExpiryInterval = 0;
  for (const v of params) {
    if (typeof v === 'number' && v > 1e12) tokenTs = v; // 毫秒時間戳（13 位數）
    else if (typeof v === 'number' && v > 0 && v < 1e6) tokenExpiryInterval = v; // 過期秒數
    else if (typeof v === 'string' && v.length > 20) token = v; // token 通常較長
    else if (typeof v === 'string' && v.length > 0 && !key) key = v; // key 較短，取第一個
  }

  if (!key || !token) return null;

  return { ig, iid, key, token, tokenTs, tokenExpiryInterval };
}

// ─── 核心邏輯 ────────────────────────────────────────────

let _refreshPromise = null;

/**
 * 決定使用的域名。
 * @param {string} endpointMode — 'auto' | 'global' | 'china'
 * @param {string|null} lastGoodHost — 上次成功的域名
 * @returns {string[]} 要嘗試的域名列表（按優先順序）
 */
function _getHostsToTry(endpointMode, lastGoodHost) {
  if (endpointMode === 'global') return [HOSTS.global];
  if (endpointMode === 'china') return [HOSTS.china];
  // auto：上次成功的域名優先，另一個作 fallback
  if (lastGoodHost === HOSTS.china) return [HOSTS.china, HOSTS.global];
  return [HOSTS.global, HOSTS.china];
}

/**
 * 從 Bing 頁面獲取新 token。
 * @param {string} endpointMode
 * @returns {Promise<{ ig, iid, key, token, baseUrl, fetchedAt }>}
 */
async function _fetchNewToken(endpointMode) {
  const cached = await _loadCached();
  const hosts = _getHostsToTry(endpointMode, cached?.baseUrl || null);

  let lastError;
  for (const host of hosts) {
    try {
      const resp = await fetch(`${host}/translator`, {
        credentials: 'omit', // 不送 cookie（安全考量）
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      });
      if (!resp.ok) {
        lastError = new Error(`Bing Translator HTTP ${resp.status} from ${host}`);
        continue;
      }

      const html = await resp.text();
      const extracted = _extractTokenFromHTML(html);
      if (!extracted) {
        lastError = new Error(`Failed to extract token from ${host}/translator HTML`);
        continue;
      }

      const data = {
        ...extracted,
        baseUrl: host,
        fetchedAt: Date.now(),
      };

      await _saveCached(data);
      return data;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to get Bing token from all hosts');
}

/**
 * 取得有效的 Bing token。自動快取 + 過期刷新 + 並發鎖。
 *
 * @param {string} [endpointMode='auto'] — 'auto' | 'global' | 'china'
 * @param {boolean} [forceRefresh=false] — 強制刷新（auth 失敗重試用）
 * @returns {Promise<{ ig, iid, key, token, baseUrl }>}
 */
export async function getBingToken(endpointMode = 'auto', forceRefresh = false) {
  // 檢查快取（Codex P2：確認 cached host 符合 endpointMode）
  if (!forceRefresh) {
    const cached = await _loadCached();
    if (cached && cached.fetchedAt) {
      const ttl = (cached.tokenExpiryInterval || DEFAULT_TTL_MS / 1000) * 1000;
      const age = Date.now() - cached.fetchedAt;
      // 若 endpointMode 指定了特定域名，快取的 baseUrl 必須一致
      const hostOk = endpointMode === 'auto'
        || (endpointMode === 'global' && cached.baseUrl === HOSTS.global)
        || (endpointMode === 'china' && cached.baseUrl === HOSTS.china);
      if (age < ttl && hostOk) {
        return {
          ig: cached.ig,
          iid: cached.iid,
          key: cached.key,
          token: cached.token,
          baseUrl: cached.baseUrl,
        };
      }
    }
  }

  // 並發鎖：避免多個 batch 同時刷新
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = _fetchNewToken(endpointMode).finally(() => {
    _refreshPromise = null;
  });

  const data = await _refreshPromise;
  return {
    ig: data.ig,
    iid: data.iid,
    key: data.key,
    token: data.token,
    baseUrl: data.baseUrl,
  };
}

/**
 * 清除快取的 token（用於除錯或重置）。
 */
export async function clearBingToken() {
  _refreshPromise = null;
  await _clearCached();
}
