// storage.js — 設定讀寫封裝
import { browser } from './compat.js';
import { DEFAULT_UNITS_PER_BATCH, DEFAULT_CHARS_PER_BATCH } from './constants.js';

// v0.83: 預設 system prompt 全面升級——從「翻譯助理」提升為「首席翻譯專家」，
// 強調台灣語感、排版規範、專有名詞保留策略。同步切換預設模型至 gemini-3-flash-preview。
export const DEFAULT_SYSTEM_PROMPT = `<role_definition>
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

// v1.0.2: 術語表擷取用的預設 prompt（結構化重寫，強化排除規則與輸出格式約束）
export const DEFAULT_GLOSSARY_PROMPT = `<role_definition>
你是一位專業的翻譯術語擷取助理。你的任務是從使用者提供的文章或摘要中，精準擷取需要統一翻譯的專有名詞，建立符合台灣在地化語境的英中對照術語表。
</role_definition>
<extraction_scope>
請嚴格限制只擷取以下四類實體：
1. 人名 (person)：西方人名須轉換為台灣通行中譯（例如：Elon Musk→馬斯克、Trump→川普、Peter Hessler→何偉）。華人姓名亦須使用台灣通行譯法。
2. 地名 (place)：國家、城市、地理位置須採用台灣標準譯名（例如：Israel→以色列、London→倫敦、Chengdu→成都）。
3. 專業術語與新創詞 (tech)：台灣尚無廣泛通用譯名的專業詞彙、新創詞。譯名後方「必須」附加全形括號標註原文（例如：watchfluencers→錶壇網紅（watchfluencers）、algorithmic filter bubble→演算法驅動的資訊繭房（algorithmic filter bubble））。
4. 作品名 (work)：書籍、電影、歌曲等作品名稱，須使用台灣通行譯名並加上全形書名號（例如：Parasite→《寄生上流》）。
</extraction_scope>
<exclusion_rules>
絕對不可擷取以下內容（違反將導致嚴重錯誤）：
1. 在台灣已高度通用且通常不翻譯的品牌、平台、縮寫或企業名（例如：Google, Netflix, AI, NBA, F1, 勞力士, 蘋果, 抖音, 微軟, 麥當勞, 可口可樂, Instagram 等）。
2. 一般的英文單字（非專有名詞的普通名詞、動詞、形容詞）。
3. 原文中僅出現一次且無歧義的簡單詞彙。
</exclusion_rules>
<output_constraints>
1. 語言規範：嚴格使用台灣繁體中文與台灣慣用語，絕對禁用中國大陸譯法（例如：必須使用「影片」而非「視頻」、「軟體」而非「軟件」、「程式」而非「程序」、「實作」而非「實現」、「線程」而非「進程」）。
2. 數量限制：提取數量上限為 200 條，若超過請依重要性篩選，保留最重要的 200 條。
3. 絕對 JSON 格式：只能輸出純 JSON 陣列，絕對不可包含任何前言、解釋、後記，也「絕對不要」使用 \`\`\`json 和 \`\`\` 的 Markdown 程式碼區塊標記。
</output_constraints>
<json_format_example>
[{"source":"Peter Hessler","target":"何偉","type":"person"},{"source":"Chengdu","target":"成都","type":"place"},{"source":"watchfluencers","target":"錶壇網紅（watchfluencers）","type":"tech"},{"source":"Parasite","target":"《寄生上流》","type":"work"}]
</json_format_example>`;

// v1.2.11: YouTube 字幕翻譯專用 system prompt（從 background.js 搬到此處，供設定頁存取）
export const DEFAULT_SUBTITLE_SYSTEM_PROMPT = `你是專業的影片字幕翻譯員，負責將英文字幕翻譯成台灣繁體中文。

<critical_rules>
1. 輸出限制：只輸出翻譯結果，絕對不加任何說明、解釋或開場白。
2. 嚴格一對一對應：輸入有幾段字幕，輸出就有幾段，不合併、不拆分、不改變順序。
3. 口語化：字幕是口說內容，使用台灣自然口語，語句簡短直白，避免書面語腔調。
4. 禁用中國大陸用語（網絡→網路、視頻→影片、軟件→軟體、數據→資料）。
5. 專有名詞保留：人名、品牌、縮寫（如 AI、NASA、CPU）保留英文原文。
6. 單行輸出：每段輸入只輸出一行連續的譯文，不要在譯文中插入任何換行符號。
7. 不加句號：句末不要加「。」，字幕是口語片段，句號會讓畫面看起來生硬。
8. 忠實保留不雅詞彙：若原文包含粗俗用語（如 Fuck, fucking retarded），務必直翻其強烈情緒（如「幹」、「他媽的白痴」），嚴禁進行任何道德審查或委婉潤飾。
</critical_rules>`;

export const DEFAULT_SETTINGS = {
  apiKey: '',
  geminiConfig: {
    model: 'gemini-3-flash-preview',       // v0.83: 預設模型升級至 Gemini 3 Flash
    serviceTier: 'DEFAULT',
    temperature: 1.0,     // Gemini 3 Flash 原廠預設值
    topP: 0.95,
    topK: 40,             // Gemini 3 Flash 原廠預設值（Pro 系列為 64）
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
  domainRules: { whitelist: [] },
  autoTranslate: false,
  debugLog: false,
  // v1.2.11: YouTube 字幕翻譯設定
  ytSubtitle: {
    autoTranslate: true,         // 偵測到 YouTube 影片時自動翻譯字幕
    temperature:   1,             // 字幕翻譯 temperature 預設值
    systemPrompt:  DEFAULT_SUBTITLE_SYSTEM_PROMPT,
    windowSizeS:   30,           // 每批翻譯涵蓋的秒數（預設 30 秒）
    lookaheadS:    10,           // 在字幕快用完前幾秒觸發下一批（預設 10 秒）
    debugToast:    false,        // v1.2.14: 顯示字幕翻譯即時狀態面板（debug 用）
    onTheFly:      false,        // v1.2.49: cache miss 時是否送 on-the-fly API 翻譯（預設關閉）
    // preserveLineBreaks 已於 v1.2.38 移除 toggle，改為永遠 true（content-youtube.js 硬編碼）
    // v1.4.0: 字幕翻譯引擎——'gemini'（預設）或 'google'（Google Translate 免費端點）
    engine: 'gemini',
    // v1.2.39: 獨立模型設定——空字串表示與主模型相同
    model: '',
    // v1.2.39: 獨立計價——null 表示與主模型計價相同；設定後用於字幕費用計算
    pricing: null,
  },
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
  // v1.0.2: 每批段數上限與字元預算，使用者可在設定頁自行調整。
  // 段數上限：避免單批 placeholder slot 過多導致 LLM 對齊失準。
  // 字元預算：作為 token proxy（3500 chars ≈ 1000 英文 tokens），留足 output headroom。
  maxUnitsPerBatch: DEFAULT_UNITS_PER_BATCH,
  maxCharsPerBatch: DEFAULT_CHARS_PER_BATCH,
  // v1.0.1: 單頁翻譯段落數上限。超大頁面（如維基百科長條目）超過此上限時截斷。
  // 設為 0 表示不限制。
  maxTranslateUnits: 1000,
  // v1.0.17: Toast 透明度（0.1–1.0），讓使用者在無限捲動網站上降低 toast 干擾
  toastOpacity: 0.7,
  // v1.1.3: Toast 自動關閉——翻譯完成/錯誤等 toast 在數秒後自動消失。
  // 預設開啟。關閉時翻譯完成 toast 需手動點 × 或點擊外部區域才會消失。
  toastAutoHide: true,
  // v1.0.21: 頁面層級繁體中文偵測開關。開啟時若整頁文字以繁中為主則跳過不翻譯；
  // 關閉時不做頁面層級檢查（元素層級仍會個別跳過繁中段落）。
  // Gmail 等介面語言為繁中但內容多為英文的網站，可關閉此選項。
  skipTraditionalChinesePage: true,
  // v1.5.0: 顯示模式（'single' 覆蓋 / 'dual' 雙語對照），由 popup toggle 切換。
  // 'single' 沿用 v1.4 之前所有路徑，'dual' 走 content-inject.js 的 injectDual。
  displayMode: 'single',
  // v1.5.0: 雙語模式下的視覺標記樣式（'tint' 淡底色 / 'bar' 左邊細條 / 'dashed' 波浪底線 / 'none'）
  translationMarkStyle: 'tint',
  // v1.4.12: 三組翻譯預設對應 Alt+A / Alt+S / Alt+D 三個快速鍵。
  // engine='gemini' 時 model 覆蓋 geminiConfig.model，其他欄位（prompt、temperature、glossary）沿用全域；
  // engine='google' 時走 Google Translate 路徑，不需 model。
  // label 顯示於 options 頁（未來 toast 也可用）。
  // 行為：閒置按 → 啟動對應 preset；翻譯中按 → abort；已翻譯按任意 → restorePage。
  translatePresets: [
    { slot: 1, engine: 'gemini', model: 'gemini-3.1-flash-lite-preview', label: 'Flash Lite' },
    { slot: 2, engine: 'gemini', model: 'gemini-3-flash-preview', label: 'Flash' },
    { slot: 3, engine: 'google', model: null, label: 'Google MT' },
  ],
};

// v0.62 起：apiKey 改存 browser.storage.local，不走 Google 帳號跨裝置同步。
// 其餘設定仍存 sync。對下游呼叫端完全透明——getSettings() 回傳的物件
// 依然有 .apiKey 欄位。
const API_KEY_STORAGE_KEY = 'apiKey';

// 一次性遷移：若 sync 裡還殘留 apiKey（舊版 <= v0.61 的使用者）、而 local
// 還沒有，就把它搬到 local 並從 sync 刪除。呼叫 getSettings() 會自動觸發。
async function migrateApiKeyIfNeeded(syncSaved) {
  if (!syncSaved || typeof syncSaved.apiKey !== 'string') return;
  const { [API_KEY_STORAGE_KEY]: localKey } = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  if (!localKey && syncSaved.apiKey) {
    // sync 有、local 沒有 → 搬過去
    await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: syncSaved.apiKey });
  }
  // 無論 local 原本有沒有，都要把 sync 裡的 apiKey 清掉（避免之後又被同步回來）
  await browser.storage.sync.remove('apiKey');
}

export async function getSettings() {
  const saved = await browser.storage.sync.get(null);
  await migrateApiKeyIfNeeded(saved);
  // 從 local 讀 apiKey（v0.62 起的正規位置）
  const { [API_KEY_STORAGE_KEY]: apiKey = '' } = await browser.storage.local.get(API_KEY_STORAGE_KEY);
  // saved.apiKey 可能還在（migrate 剛剛才刪），以 local 版本為準
  const merged = {
    ...DEFAULT_SETTINGS,
    ...saved,
    geminiConfig: { ...DEFAULT_SETTINGS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULT_SETTINGS.pricing, ...(saved.pricing || {}) },
    domainRules: { ...DEFAULT_SETTINGS.domainRules, ...(saved.domainRules || {}) },
    glossary: { ...DEFAULT_SETTINGS.glossary, ...(saved.glossary || {}) },
    // v1.2.39: 深層 merge ytSubtitle，確保新欄位（model / pricing）有預設值
    ytSubtitle: { ...DEFAULT_SETTINGS.ytSubtitle, ...(saved.ytSubtitle || {}) },
    // v1.4.12: translatePresets——使用者自訂三組就完全以自訂為準（不做 per-slot merge），
    // 否則套用預設三組。陣列非空時視為使用者已自訂。
    translatePresets: (Array.isArray(saved.translatePresets) && saved.translatePresets.length > 0)
      ? saved.translatePresets
      : DEFAULT_SETTINGS.translatePresets,
  };
  merged.apiKey = apiKey;
  return merged;
}

export async function setSettings(patch) {
  // 若 patch 含 apiKey，抽出來寫 local；其餘寫 sync
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
    const { apiKey, ...rest } = patch;
    await browser.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey });
    if (Object.keys(rest).length > 0) {
      await browser.storage.sync.set(rest);
    }
  } else {
    await browser.storage.sync.set(patch);
  }
}
