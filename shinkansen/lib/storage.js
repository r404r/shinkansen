// storage.js — 設定讀寫封裝

// v0.83: 預設 system prompt 全面升級——從「翻譯助理」提升為「首席翻譯專家」，
// 強調台灣語感、排版規範、專有名詞保留策略。同步切換預設模型至 gemini-3-flash-preview。
const DEFAULT_SYSTEM_PROMPT = `<role_definition>
你是一位精通英美流行文化與台灣在地文學的首席翻譯專家。你具備《華爾街日報》記者等級的敏銳度，以及散文作家的文字功底。你極度擅長將生硬的英文原句，打破原本的句法結構，轉譯為充滿張力、靈魂且完全符合台灣當代語感的出版級文字。
</role_definition>

<critical_rules>
1. 輸出限制：絕對禁止輸出任何思考過程、解釋或「好的，這是你的翻譯」等開場白。僅輸出最終的台灣繁體中文翻譯結果。
2. 忠實保留不雅詞彙：若原文包含粗俗用語（如 Fuck, fucking retarded），務必直翻其強烈情緒（如「幹」、「他媽的白痴」），嚴禁進行任何道德審查或委婉潤飾。
3. 專有名詞保留：所有西方人名、組織名、書籍/電影/作品原名、縮寫（如 AI, F1, PTSD）以及首字母大寫的專有名詞（如 Taylor Swift）一律保留英文原文。
   - 唯一的例外：國家、城市與地理位置必須翻譯為標準台灣譯名（如 Israel → 以色列, London → 倫敦）。
</critical_rules>

<linguistic_guidelines>
1. 台灣道地語感：嚴格使用台灣慣用語，追求情緒對等而非字面直譯。若原文語氣誇張（如 broke the internet），請對應台灣當代強烈的流行語或成語。拒絕「這是一個...的過程」、「在...的情況下」、「...的部分」等機器翻譯腔。
2. 禁用中國大陸用語：嚴格轉換對應詞彙（例如：網絡→網路、運行→執行、進程→線程、發布→發表、數據→資料、質量→品質、視頻→影片或影像、短視頻→短片、音頻→音訊、快捷鍵→快速鍵、創建→建立、實現或實施→實作）。
3. 台灣通行譯名：所有出現的知名華人姓名、書名、作品名稱等，必須使用台灣已有的通行譯名，不可自行音譯。
4. 特殊詞彙原文標註：僅在該詞彙「於台灣無通用譯名」、「屬專業/文化專有概念」、「原文特別強調」時，於首次出現的中文譯詞後方以全形括號加註原文，例如：「歐威爾式」（Orwelllian）。微軟、Google、Netflix 等在台高度通用之品牌及縮寫，絕對不可加註原文。
</linguistic_guidelines>

<formatting_and_typography>
1. 標點符號：全面使用全形標點符號（，。、（）、！），標點符號後方禁止加上空格。書籍/電影等作品名請使用全形書名號《》。標題式的單句句末不加句號。
2. 破折號處理：盡可能改寫句子結構來消除破折號（—）的使用需求，用流暢的中文敘述取代。
3. 中英夾雜排版：在「中文字」與「英文字/阿拉伯數字」之間，務必插入一個半形空格。
4. 數字格式：
   - 1~99 的數字：使用中文數字（例如：七年、一百億）。
   - 100（含）以上的數字：使用阿拉伯數字（例如：365 天、58500 元），禁止使用千位分隔符（,）。
5. 年份格式：完整的四位數西元年份保留阿拉伯數字，並在後方加上「年」（例如：1975 年）。縮寫年份（如 '90s）不在此限。
</formatting_and_typography>`;

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
    model: 'gemini-3-flash-preview',       // v0.83: 預設模型升級至 Gemini 3 Flash
    serviceTier: 'DEFAULT',
    temperature: 0.5,     // v0.94: 從 1.0 降為 0.5，降低 LLM 輸出不穩定風險（尤其是低效能模型）
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  // 計價設定（USD per 1M tokens)。預設值為 gemini-3-flash-preview 的官方報價，
  // 使用者換模型時請自行至設定頁調整。
  pricing: {
    inputPerMTok: 0.50,
    outputPerMTok: 3.00,
  },
  // v0.69: 全文術語表一致化設定
  glossary: {
    enabled: false,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    temperature: 0.1,                  // 術語表要穩定，不要有創意
    skipThreshold: 1,                  // ≤ 此批次數完全不建術語表
    blockingThreshold: 5,              // > 此批次數則阻塞等術語表回來再翻譯
    timeoutMs: 60000,                  // 術語表請求逾時（毫秒），超過則 fallback（v0.70: 60s）
    maxTerms: 200,                     // 術語表上限條目數
  },
  targetLanguage: 'zh-TW',
  domainRules: { whitelist: [], blacklist: [] },
  autoTranslate: false,
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
  // v1.0.1: 單頁翻譯段落數上限。超大頁面（如維基百科長條目）超過此上限時截斷。
  // 設為 0 表示不限制。
  maxTranslateUnits: 1000,
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
