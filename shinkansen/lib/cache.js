// cache.js — 持久化翻譯快取
// 存在 chrome.storage.local,key 為 SHA-1(原文） 加 'tc_' 前綴。
// 版本變更時會由 background.js 主動呼叫 clearAll() 清空。
//
// v0.85: 新增 LRU 淘汰機制。快取值從純字串改為 { v: 譯文, t: 時間戳 } 結構，
// 寫入時若 chrome.storage.local 配額滿，依時間戳排序刪除最舊的條目騰出空間。
// 讀取時向下相容舊格式（純字串）。

const KEY_PREFIX = 'tc_';
const GLOSSARY_PREFIX = 'gloss_';   // v0.69: 術語表快取
const VERSION_KEY = '__cacheVersion';

// chrome.storage.local 預設配額 10MB。保留 512KB 給非快取資料（設定、使用量統計、
// API key、RPD 計數、debug log 等），快取最多佔 9.5MB。
const CACHE_QUOTA_BYTES = 9.5 * 1024 * 1024; // 9,961,472
// 每次 LRU 淘汰時一次性騰出的目標空間（避免每次寫入都觸發淘汰）
const EVICTION_TARGET_BYTES = 1 * 1024 * 1024; // 1MB

async function hashText(text) {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 估算一個 storage entry 的大小（bytes）。
 * chrome.storage.local 的計費方式是 JSON.stringify(key) + JSON.stringify(value)。
 */
function estimateEntrySize(key, value) {
  const valStr = typeof value === 'string' ? value : JSON.stringify(value);
  return key.length + valStr.length;
}

/**
 * 從快取值中提取譯文。
 * 向下相容：v0.85 以前存的是純字串，v0.85 起存 { v, t }。
 */
function extractValue(stored) {
  if (stored == null) return null;
  if (typeof stored === 'string') return stored; // 舊格式
  if (typeof stored === 'object' && stored.v != null) return stored.v; // 新格式
  return null;
}

/**
 * 包裝快取值為 LRU 結構。
 */
function wrapValue(translation) {
  return { v: translation, t: Date.now() };
}

/**
 * 提取 entry 的時間戳（用於 LRU 排序）。
 * 舊格式（純字串）沒有時間戳，視為最舊（t = 0）。
 */
function extractTimestamp(stored) {
  if (stored != null && typeof stored === 'object' && typeof stored.t === 'number') {
    return stored.t;
  }
  return 0; // 舊格式，最先被淘汰
}

/**
 * LRU 淘汰：刪除最舊的快取條目，騰出至少 targetBytes 空間。
 * 只淘汰 tc_ 和 gloss_ 前綴的快取條目，不動其他 storage 資料。
 */
async function evictOldest(targetBytes) {
  const all = await chrome.storage.local.get(null);
  const cacheEntries = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX)) {
      cacheEntries.push({
        key,
        size: estimateEntrySize(key, value),
        t: extractTimestamp(value),
      });
    }
  }
  // 依時間戳升序排列（最舊的在前面）
  cacheEntries.sort((a, b) => a.t - b.t);

  let freed = 0;
  const toRemove = [];
  for (const entry of cacheEntries) {
    if (freed >= targetBytes) break;
    toRemove.push(entry.key);
    freed += entry.size;
  }

  if (toRemove.length > 0) {
    await chrome.storage.local.remove(toRemove);
    console.log(`[Shinkansen] cache LRU eviction: removed ${toRemove.length} entries, freed ~${(freed / 1024).toFixed(1)}KB`);
  }
  return { removed: toRemove.length, freedBytes: freed };
}

/**
 * 計算目前快取佔用的大致 bytes。
 */
async function getCacheUsageBytes() {
  const all = await chrome.storage.local.get(null);
  let bytes = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(KEY_PREFIX) || key.startsWith(GLOSSARY_PREFIX)) {
      bytes += estimateEntrySize(key, value);
    }
  }
  return bytes;
}

/**
 * 包裝 chrome.storage.local.set() 的寫入，處理配額滿的情況。
 * 若寫入失敗且錯誤訊息包含 QUOTA_BYTES，觸發 LRU 淘汰後重試一次。
 */
async function safeStorageSet(updates) {
  try {
    await chrome.storage.local.set(updates);
  } catch (err) {
    const msg = err?.message || '';
    // chrome.storage 配額滿的錯誤訊息包含 "QUOTA_BYTES" 或 "quota"
    if (msg.includes('QUOTA_BYTES') || msg.toLowerCase().includes('quota')) {
      console.warn('[Shinkansen] storage quota exceeded, triggering LRU eviction');
      await evictOldest(EVICTION_TARGET_BYTES);
      // 重試一次
      try {
        await chrome.storage.local.set(updates);
      } catch (retryErr) {
        // 淘汰後仍然寫不進去（可能單筆就超過上限）→ 靜默放棄，不 crash
        console.error('[Shinkansen] storage write failed after eviction:', retryErr.message);
      }
    } else {
      // 非配額問題 → 靜默放棄，不讓快取寫入問題中斷翻譯流程
      console.error('[Shinkansen] storage write failed:', msg);
    }
  }
}

/**
 * 主動檢查：若快取已超過配額的 90%，提前淘汰，避免下次寫入才觸發。
 * 在 setBatch 之後呼叫（非同步，不阻塞翻譯流程）。
 */
async function proactiveEvictionCheck() {
  try {
    const usage = await getCacheUsageBytes();
    if (usage > CACHE_QUOTA_BYTES * 0.9) {
      console.log(`[Shinkansen] cache usage ${(usage / 1024 / 1024).toFixed(2)}MB > 90% threshold, proactive eviction`);
      await evictOldest(EVICTION_TARGET_BYTES);
    }
  } catch (err) {
    // 檢查失敗不要影響正常流程
    console.warn('[Shinkansen] proactive eviction check failed:', err.message);
  }
}

/**
 * 一次取多段譯文。回傳與輸入等長的陣列，缺的位置為 null。
 * @param {string[]} texts 原文陣列
 * @param {string} [keySuffix=''] 可選的 key 後綴（v0.70: 用來區分有/無術語表的快取）
 */
export async function getBatch(texts, keySuffix = '') {
  if (!texts.length) return [];
  const hashes = await Promise.all(texts.map(hashText));
  const keys = hashes.map(h => KEY_PREFIX + h + keySuffix);
  const stored = await chrome.storage.local.get(keys);
  // v0.85: 讀取時更新命中條目的時間戳（延遲寫入，不阻塞回傳）
  const touchUpdates = {};
  const results = keys.map(k => {
    if (!(k in stored)) return null;
    const val = extractValue(stored[k]);
    if (val != null) {
      // 更新時間戳（讓常用的條目不會被 LRU 淘汰）
      touchUpdates[k] = wrapValue(val);
    }
    return val;
  });
  // 非同步更新時間戳，不等待完成
  if (Object.keys(touchUpdates).length > 0) {
    chrome.storage.local.set(touchUpdates).catch(() => {}); // fire-and-forget
  }
  return results;
}

/**
 * 一次寫多段譯文。texts 與 translations 必須等長。
 * @param {string[]} texts 原文陣列
 * @param {string[]} translations 譯文陣列
 * @param {string} [keySuffix=''] 可選的 key 後綴（v0.70: 用來區分有/無術語表的快取）
 */
export async function setBatch(texts, translations, keySuffix = '') {
  if (!texts.length) return;
  const hashes = await Promise.all(texts.map(hashText));
  const updates = {};
  for (let i = 0; i < texts.length; i++) {
    if (translations[i]) {
      updates[KEY_PREFIX + hashes[i] + keySuffix] = wrapValue(translations[i]);
    }
  }
  if (Object.keys(updates).length) {
    await safeStorageSet(updates);
    // 非同步檢查是否需要提前淘汰（不阻塞翻譯流程）
    proactiveEvictionCheck().catch(() => {});
  }
}

/**
 * v0.69: 取得術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @returns {Promise<Array|null>} 快取命中時回傳術語陣列，否則 null
 */
export async function getGlossary(inputHash) {
  const key = GLOSSARY_PREFIX + inputHash;
  const stored = await chrome.storage.local.get(key);
  if (!(key in stored)) return null;
  const entry = stored[key];
  // v0.85: 向下相容 — 舊格式直接是 Array，新格式是 { v: Array, t: number }
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === 'object' && Array.isArray(entry.v)) {
    // 更新時間戳（fire-and-forget）
    chrome.storage.local.set({ [key]: { v: entry.v, t: Date.now() } }).catch(() => {});
    return entry.v;
  }
  return null;
}

/**
 * v0.69: 寫入術語表快取。
 * @param {string} inputHash 壓縮後輸入文字的 SHA-1 hash
 * @param {Array} glossary 術語陣列
 */
export async function setGlossary(inputHash, glossary) {
  const key = GLOSSARY_PREFIX + inputHash;
  await safeStorageSet({ [key]: { v: glossary, t: Date.now() } });
}

/** v0.69: 計算文字 SHA-1（匯出給 background 使用）。 */
export { hashText };

/**
 * 清除所有翻譯快取與術語表快取（保留版本標記等其他 local storage 內容）。
 */
export async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const toRemove = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX) || k.startsWith(GLOSSARY_PREFIX));
  if (toRemove.length) {
    await chrome.storage.local.remove(toRemove);
  }
  return toRemove.length;
}

/**
 * 取得目前快取的條目數與大致大小（bytes)。
 * v0.69: 新增 glossaryCount / glossaryBytes 分開統計術語表快取。
 * v0.85: 向下相容新舊格式的大小估算。
 */
export async function stats() {
  const all = await chrome.storage.local.get(null);
  const tcEntries = Object.keys(all).filter(k => k.startsWith(KEY_PREFIX));
  const glossEntries = Object.keys(all).filter(k => k.startsWith(GLOSSARY_PREFIX));
  let bytes = 0;
  for (const k of tcEntries) {
    bytes += estimateEntrySize(k, all[k]);
  }
  let glossaryBytes = 0;
  for (const k of glossEntries) {
    glossaryBytes += estimateEntrySize(k, all[k]);
  }
  return {
    count: tcEntries.length,
    bytes,
    glossaryCount: glossEntries.length,
    glossaryBytes,
  };
}

/**
 * 比對 manifest 版本與儲存版本，若不同則清空快取並更新版本標記。
 * 回傳 true 代表有清空動作。
 */
export async function checkVersionAndClear(currentVersion) {
  const stored = await chrome.storage.local.get(VERSION_KEY);
  if (stored[VERSION_KEY] !== currentVersion) {
    const removed = await clearAll();
    await chrome.storage.local.set({ [VERSION_KEY]: currentVersion });
    return { cleared: true, removed, oldVersion: stored[VERSION_KEY] };
  }
  return { cleared: false };
}
