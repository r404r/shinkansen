// lib/bing-token.js — Microsoft Translator token 管理（Nozomi 獨立模組）
//
// 使用 Microsoft Edge Translator 的免費認證端點取得 JWT Bearer token。
// 流程：GET edge.microsoft.com/translate/auth → 直接返回 JWT 字串。
// 翻譯端點：POST api.cognitive.microsofttranslator.com/translate
//
// 不需要 API Key、不需要 bing.com HTML 解析、中國大陸可用。
// Token 持久化到 storage.session（Chrome）或 storage.local（Firefox fallback），
// 避免 MV3 Service Worker 掛起後丟失。

import { browser } from './compat.js';

const AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const STORAGE_KEY = '_sk_bing_token';
const DEFAULT_TTL_MS = 8 * 60 * 1000; // 8 分鐘（JWT 有效期約 10 分鐘，保守值）

// ─── 持久化 storage ─────────────────────────────────────
// 延遲解析避免 compat.js Proxy 在 import 時就被綁定
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

// ─── JWT 過期解析 ─────────────────────────────────────────

/**
 * 從 JWT token 中提取過期時間（exp 欄位）。
 * @param {string} jwt
 * @returns {number} 過期時間戳（毫秒），解析失敗返回 0
 */
function _getJwtExpiry(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return 0;
    // JWT payload 是 base64url 編碼
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.exp || 0) * 1000; // exp 是秒，轉毫秒
  } catch { return 0; }
}

// ─── 核心邏輯 ────────────────────────────────────────────

let _refreshPromise = null;

/**
 * 從 Microsoft Edge 認證端點獲取新 JWT token。
 * @returns {Promise<{ token: string, expiresAt: number, fetchedAt: number }>}
 */
async function _fetchNewToken() {
  const resp = await fetch(AUTH_URL, {
    credentials: 'omit',
  });

  if (!resp.ok) {
    throw new Error(`Microsoft Translator auth HTTP ${resp.status}`);
  }

  const token = await resp.text();
  if (!token || token.length < 10) {
    throw new Error('Microsoft Translator auth returned empty token');
  }

  const expiresAt = _getJwtExpiry(token);
  const data = {
    token: token.trim(),
    expiresAt,
    fetchedAt: Date.now(),
  };

  await _saveCached(data);
  return data;
}

/**
 * 取得有效的 Microsoft Translator Bearer token。
 * 自動快取 + 過期刷新 + 並發鎖。
 *
 * @param {boolean} [forceRefresh=false] — 強制刷新（auth 失敗重試用）
 * @returns {Promise<string>} — Bearer token 字串
 */
export async function getBingToken(forceRefresh = false) {
  // 檢查快取
  if (!forceRefresh) {
    const cached = await _loadCached();
    if (cached && cached.token) {
      // 用 JWT exp 判斷是否過期（提前 60 秒刷新）
      const now = Date.now();
      const expiresAt = cached.expiresAt || (cached.fetchedAt + DEFAULT_TTL_MS);
      if (now < expiresAt - 60_000) {
        return cached.token;
      }
    }
  }

  // 並發鎖：避免多個 batch 同時刷新
  if (_refreshPromise) {
    const data = await _refreshPromise;
    return data.token;
  }

  _refreshPromise = _fetchNewToken().finally(() => {
    _refreshPromise = null;
  });

  const data = await _refreshPromise;
  return data.token;
}

/**
 * 清除快取的 token（用於除錯或重置）。
 */
export async function clearBingToken() {
  _refreshPromise = null;
  await _clearCached();
}
