// storage.js — 設定讀寫封裝

const DEFAULT_SYSTEM_PROMPT = `你是一位專業的翻譯助理。請將使用者提供的文字翻譯成繁體中文（台灣用語），遵守以下規則：
1. 只輸出譯文，不要加任何解釋、前言或後記。
2. 保留原文中的專有名詞、產品名、人名、程式碼、網址、數字與符號。
3. 使用台灣慣用的翻譯（例如 software → 軟體、而非「軟件」;database → 資料庫、而非「數據庫」)。
4. 若輸入包含多段文字（以特定分隔符號區隔），請逐段翻譯並以相同分隔符號輸出。
5. 語氣自然流暢，避免直譯與機械感。`;

// v0.75: 術語表擷取用的預設 system prompt（根據使用者翻譯 prompt 提煉）
const DEFAULT_GLOSSARY_PROMPT = `你是一位專業的翻譯術語擷取助理。請從使用者提供的文章摘要中，擷取需要統一翻譯的專有名詞，建立英中對照術語表。

擷取範圍（只擷取這四類）：
1. 人名：西方人名→台灣通行中譯（例如 Elon Musk→馬斯克、Trump→川普、Peter Hessler→何偉）。華人姓名使用台灣通行譯法。
2. 地名：國家、城市、地理位置→台灣標準譯名（例如 Israel→以色列、London→倫敦、Chengdu→成都）
3. 專業術語／新創詞：台灣尚無通用譯名的詞彙，譯名後須加全形括號標註原文（例如 watchfluencers→錶壇網紅（watchfluencers）、algorithmic filter bubble→演算法驅動的資訊繭房（algorithmic filter bubble））
4. 作品名：書籍、電影、歌曲→台灣通行譯名加全形書名號（例如 Parasite→《寄生上流》）

不要擷取（非常重要）：
- 在台灣已高度通用的品牌／平台／縮寫（Google、Netflix、AI、NBA、F1、勞力士、蘋果、抖音、微軟、麥當勞、可口可樂、Instagram 等）
- 一般英文單字（不是專有名詞的普通名詞／動詞）
- 原文中只出現一次且無歧義的簡單詞彙

輸出規則：
1. 嚴格使用繁體中文（台灣用語），禁用中國大陸譯法（例如：川普而非特朗普、軟體而非軟件、影片而非視頻）
2. 只輸出 JSON 陣列，不加任何解釋、前言或 markdown 格式
3. 上限 200 條，超過則只保留最重要的 200 條
4. 每個條目必須包含 source（原文）、target（譯名）、type（person/place/tech/work 四擇一）

輸出格式範例：
[{"source":"Peter Hessler","target":"乙乙","type":"person"},{"source":"Chengdu","target":"成都","type":"place"},{"source":"watchfluencers","target":"錶壇網紅（watchfluencers）","type":"tech"}]`;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  geminiConfig: {
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    useThinking: false,    // v0.79: 是否啟用 Gemini thinking model 思考功能
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  // 計價設定（USD per 1M tokens)。預設值為 gemini-2.5-flash 的官方報價，
  // 使用者換模型時請自行至設定頁調整。
  pricing: {
    inputPerMTok: 0.30,
    outputPerMTok: 2.50,
  },
  // v0.69: 全文術語表一致化設定
  glossary: {
    enabled: true,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    temperature: 0.1,                  // 術語表要穩定，不要有創意
    skipThreshold: 1,                  // ≤ 此批次數完全不建術語表
    blockingThreshold: 5,              // > 此批次數則阻塞等術語表回來再翻譯
    timeoutMs: 60000,                  // 術語表請求逾時（毫秒），超過則 fallback（v0.70: 60s）
    maxTerms: 200,                     // 術語表上限條目數
  },
  targetLanguage: 'zh-TW',
  domainRules: { whitelist: [], blacklist: [] },
  autoTranslate: true,
  debugLog: false,
  // v0.35 新增：並行翻譯 rate limiter 設定
  // tier 對應 Gemini API 付費層級(free / tier1 / tier2),決定 RPM/TPM/RPD 上限
  // override 欄位若為 null 則使用 tier 對照表的值,非 null 時覆寫
  tier: 'tier1',
  safetyMargin: 0.1,
  maxRetries: 3,
  rpmOverride: null,
  tpmOverride: null,
  rpdOverride: null,
  // 每個 tab 同時最多飛出幾個翻譯批次(content.js 側的並發上限,與 limiter 雙重保險)
  maxConcurrentBatches: 10,
};

// v0.62 起：apiKey 改存 chrome.storage.local，不走 Google 帳號跨裝置同步。
// 其餘設定仍存 sync。對下游呼叫端完全透明——getSettings() 回傳的物件
// 依然有 .apiKey 欄位。
const API_KEY_STORAGE_KEY = 'apiKey';

// 一次性遷移：若 sync 裡還殘留 apiKey（舊版 <= v0.61 的使用者）、而 local
// 還沒有，就把它搬到 local 並從 sync 刪除。呼叫 getSettings() 會自動觸發。
async function migrateApiKeyIfNeeded(syncSaved) {
  if (!syncSaved || typeof syncSaved.apiKey !== 'string') return;
  const { [API_KEY_STORAGE_KEY]: localKey } = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  if (!localKey && syncSaved.apiKey) {
    // sync 有、local 沒有 → 搬過去
    await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: syncSaved.apiKey });
  }
  // 無論 local 原本有沒有，都要把 sync 裡的 apiKey 清掉（避免之後又被同步回來）
  await chrome.storage.sync.remove('apiKey');
}

export async function getSettings() {
  const saved = await chrome.storage.sync.get(null);
  await migrateApiKeyIfNeeded(saved);
  // 從 local 讀 apiKey（v0.62 起的正規位置）
  const { [API_KEY_STORAGE_KEY]: apiKey = '' } = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  // saved.apiKey 可能還在（migrate 剛剛才刪），以 local 版本為準
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    geminiConfig: { ...DEFAULT_SETTINGS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULT_SETTINGS.pricing, ...(saved.pricing || {}) },
    domainRules: { ...DEFAULT_SETTINGS.domainRules, ...(saved.domainRules || {}) },
    glossary: { ...DEFAULT_SETTINGS.glossary, ...(saved.glossary || {}) },
  };
  merged.apiKey = apiKey;
  return merged;
}

export async function setSettings(patch) {
  // 若 patch 含 apiKey，抽出來寫 local；其餘寫 sync
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    const { apiKey, ...rest } = patch;
    await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey });
    if (Object.keys(rest).length > 0) {
      await chrome.storage.sync.set(rest);
    }
  } else {
    await chrome.storage.sync.set(patch);
  }
}
