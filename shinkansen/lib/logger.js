// logger.js — Shinkansen 統一 Log 系統（v0.88 重構）
//
// 所有 log 一律寫入記憶體 buffer（上限 1000 筆），不寫 chrome.storage.local。
// 關分頁或 reload extension 即清空（符合「只存當次」設計）。
//
// debugLog 開關只控制「是否同時印到 DevTools console」，
// 不管開關如何，log 都會進記憶體 buffer 供設定頁 Log 分頁檢視。
//
// 分類（category）：
//   translate  — 翻譯流程（段落偵測、分批、注入）
//   api        — Gemini API 請求/回應
//   cache      — 快取命中/淘汰/配額
//   rate-limit — Rate limiter 配額/等待
//   glossary   — 術語表擷取
//   spa        — SPA 偵測/rescan/observer
//   system     — Extension 啟動/版本/設定變更/badge

import { getSettings } from './storage.js';

const MAX_LOGS = 1000;

/** 記憶體環形 buffer — background service worker 的全域狀態 */
const logBuffer = [];

/** 自增序號，供 polling 差量拉取 */
let logSeq = 0;

/**
 * 寫入一筆 log。不管 debugLog 開關都會進 buffer。
 *
 * @param {string} level   'info' | 'warn' | 'error'
 * @param {string} category 分類 key（translate / api / cache / rate-limit / glossary / spa / system）
 * @param {string} message  摘要訊息
 * @param {object} [data]   結構化附加資料
 */
export function debugLog(level, category, message, data) {
  const entry = {
    seq: ++logSeq,
    t: new Date().toISOString(),
    level,
    category: category || 'system',
    message,
    data: sanitize(data),
  };

  // 寫入記憶體 buffer（同步，保證不遺漏）
  logBuffer.push(entry);
  while (logBuffer.length > MAX_LOGS) logBuffer.shift();

  // 有開 debugLog 才印 console（非同步讀設定，不阻塞 buffer 寫入）
  getSettings().then(settings => {
    if (settings.debugLog) {
      const tag = `[Shinkansen][${category}]`;
      if (level === 'error') console.error(tag, message, data);
      else if (level === 'warn') console.warn(tag, message, data);
      else console.log(tag, message, data);
    }
  }).catch(() => {
    // getSettings 失敗不影響 buffer 寫入
  });
}

/**
 * 取得 buffer 中 seq > afterSeq 的所有 log（差量拉取）。
 * @param {number} [afterSeq=0] 上次拉到的最大 seq
 * @returns {{ logs: Array, latestSeq: number }}
 */
export function getLogs(afterSeq = 0) {
  const filtered = afterSeq > 0
    ? logBuffer.filter(e => e.seq > afterSeq)
    : logBuffer.slice();
  return {
    logs: filtered,
    latestSeq: logSeq,
  };
}

/** 清空 buffer（供設定頁「清除」按鈕使用）。 */
export function clearLogs() {
  logBuffer.length = 0;
  // 不重置 logSeq，避免 polling 端誤以為沒有新 log
}

function sanitize(data) {
  if (data == null) return undefined;
  try {
    const s = JSON.stringify(data);
    if (s.length > 3000) return JSON.parse(s.slice(0, 3000) + '…(截斷)');
    return JSON.parse(s);
  } catch {
    return String(data);
  }
}
