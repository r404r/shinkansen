// options.js — 設定頁邏輯

// v0.83: 預設 prompt 同步 lib/storage.js
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

// v0.75: 術語表擷取預設 prompt（與 lib/storage.js 同步）
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

const DEFAULTS = {
  apiKey: '',
  geminiConfig: {
    model: 'gemini-3-flash-preview',
    serviceTier: 'DEFAULT',
    temperature: 0.5,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  pricing: {
    inputPerMTok: 0.50,
    outputPerMTok: 3.00,
  },
  // v0.69: 術語表一致化
  glossary: {
    enabled: false,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    temperature: 0.1,
    skipThreshold: 1,
    blockingThreshold: 5,
    timeoutMs: 60000,
    maxTerms: 200,
  },
  targetLanguage: 'zh-TW',
  domainRules: { whitelist: [], blacklist: [] },
  autoTranslate: false,
  debugLog: false,
  tier: 'tier1',
  safetyMargin: 0.1,
  maxRetries: 3,
  rpmOverride: null,
  tpmOverride: null,
  rpdOverride: null,
  maxConcurrentBatches: 10,
  maxTranslateUnits: 1000,
};

// 模型參考價（Standard tier，每 1M tokens USD）— v0.64 更新
// 來源：https://ai.google.dev/gemini-api/docs/pricing（2026-04-09 擷取）
const MODEL_PRICING = {
  'gemini-3.1-flash-lite-preview': { input: 0.10, output: 0.30 },
  'gemini-3-flash-preview':      { input: 0.50, output: 3.00 },
  'gemini-3.1-pro-preview':      { input: 2.00, output: 12.00 },
};

// Tier 對照表(與 lib/tier-limits.js 內容一致。options.js 是普通 script 不走 ES module,
// 只能複製一份)。v0.96：依 2026-04 AI Studio 實際數值全面更新。
// Unlimited RPD 以 Infinity 表示。
const TIER_LIMITS = {
  free: {
    'gemini-3-flash-preview':        { rpm: 10,   tpm: 250000,   rpd: 250 },
    'gemini-3.1-flash-lite-preview': { rpm: 15,   tpm: 250000,   rpd: 1000 },
    'gemini-3.1-pro-preview':        { rpm: 5,    tpm: 250000,   rpd: 100 },
  },
  tier1: {
    'gemini-3-flash-preview':        { rpm: 1000, tpm: 2000000,  rpd: 10000 },
    'gemini-3.1-flash-lite-preview': { rpm: 4000, tpm: 4000000,  rpd: 150000 },
    'gemini-3.1-pro-preview':        { rpm: 225,  tpm: 2000000,  rpd: 250 },
  },
  tier2: {
    'gemini-3-flash-preview':        { rpm: 2000,  tpm: 3000000,  rpd: 100000 },
    'gemini-3.1-flash-lite-preview': { rpm: 10000, tpm: 10000000, rpd: 350000 },
    'gemini-3.1-pro-preview':        { rpm: 1000,  tpm: 5000000,  rpd: 50000 },
  },
};

function getSelectedModel() {
  const sel = $('model').value;
  if (sel === '__custom__') {
    return ($('custom-model-input').value || '').trim() || DEFAULTS.geminiConfig.model;
  }
  return sel;
}

// v0.64：切換自行輸入欄位的可見性
function toggleCustomModelInput() {
  const isCustom = $('model').value === '__custom__';
  $('custom-model-row').hidden = !isCustom;
}

// Service Tier 價格倍率（以 Standard 為基準）
// 來源：https://ai.google.dev/gemini-api/docs/flex-inference / priority-inference（2026-04-09）
// Flex = 50% 折扣 → 0.5 倍；Priority = 最高 200% → 2.0 倍（保守估計）
const SERVICE_TIER_MULTIPLIER = {
  DEFAULT:  1.0,
  STANDARD: 1.0,
  FLEX:     0.5,
  PRIORITY: 2.0,
};

// v0.64：模型變更 / Service Tier 變更 → 自動帶入參考價到模型計價欄位
function applyModelPricing(model, tierOverride) {
  const baseModel = model;
  const p = MODEL_PRICING[baseModel];
  if (!p) return; // 自行輸入或查不到參考價時不動現有值
  const tier = tierOverride || $('serviceTier').value || 'DEFAULT';
  const mult = SERVICE_TIER_MULTIPLIER[tier] ?? 1.0;
  // 保留兩位小數，避免浮點誤差
  $('inputPerMTok').value = +(p.input * mult).toFixed(2);
  $('outputPerMTok').value = +(p.output * mult).toFixed(2);
}

function applyTierToInputs(tier, model) {
  const rpmEl = $('rpm');
  const tpmEl = $('tpm');
  const rpdEl = $('rpd');
  if (tier === 'custom') {
    rpmEl.readOnly = false;
    tpmEl.readOnly = false;
    rpdEl.readOnly = false;
    return;
  }
  rpmEl.readOnly = true;
  tpmEl.readOnly = true;
  rpdEl.readOnly = true;
  const table = TIER_LIMITS[tier] || {};
  const limits = table[model] || { rpm: 60, tpm: 1000000, rpd: 1000 };
  rpmEl.value = limits.rpm;
  tpmEl.value = limits.tpm;
  rpdEl.value = limits.rpd === Infinity ? '無限制' : limits.rpd;
}

const $ = (id) => document.getElementById(id);

async function load() {
  const saved = await chrome.storage.sync.get(null);
  // v0.62 起：apiKey 改存 chrome.storage.local，不跟 Google 帳號同步
  const { apiKey: localApiKey = '' } = await chrome.storage.local.get('apiKey');
  const s = {
    ...DEFAULTS,
    ...saved,
    geminiConfig: { ...DEFAULTS.geminiConfig, ...(saved.geminiConfig || {}) },
    pricing: { ...DEFAULTS.pricing, ...(saved.pricing || {}) },
    apiKey: localApiKey,
  };
  $('apiKey').value = s.apiKey;
  const modelSelect = $('model');
  const savedModel = s.geminiConfig.model;
  const hasOption = [...modelSelect.options].some((o) => o.value === savedModel);
  if (hasOption) {
    modelSelect.value = savedModel;
  } else {
    modelSelect.value = '__custom__';
    $('custom-model-input').value = savedModel;
  }
  toggleCustomModelInput();
  $('serviceTier').value = s.geminiConfig.serviceTier;
  $('temperature').value = s.geminiConfig.temperature;
  $('topP').value = s.geminiConfig.topP;
  $('topK').value = s.geminiConfig.topK;
  $('maxOutputTokens').value = s.geminiConfig.maxOutputTokens;
  $('systemInstruction').value = s.geminiConfig.systemInstruction;
  $('inputPerMTok').value = s.pricing.inputPerMTok;
  $('outputPerMTok').value = s.pricing.outputPerMTok;
  $('whitelist').value = (s.domainRules.whitelist || []).join('\n');
  $('blacklist').value = (s.domainRules.blacklist || []).join('\n');
  $('debugLog').checked = s.debugLog;

  // 效能與配額
  $('tier').value = s.tier || 'tier1';
  applyTierToInputs($('tier').value, s.geminiConfig.model);
  // 若有 override 則把 override 填進去覆蓋 tier 預設
  if (s.rpmOverride) $('rpm').value = s.rpmOverride;
  if (s.tpmOverride) $('tpm').value = s.tpmOverride;
  if (s.rpdOverride) $('rpd').value = s.rpdOverride;
  const marginPct = Math.round((s.safetyMargin || 0.1) * 100);
  $('safetyMargin').value = marginPct;
  $('safetyMarginLabel').textContent = marginPct;
  $('maxConcurrentBatches').value = s.maxConcurrentBatches || 10;
  $('maxTranslateUnits').value = s.maxTranslateUnits ?? 1000;
  $('maxRetries').value = s.maxRetries || 3;

  // v0.69: 術語表一致化設定
  const gl = { ...DEFAULTS.glossary, ...(s.glossary || {}) };
  $('glossaryEnabled').checked = gl.enabled !== false;
  $('glossaryTemperature').value = gl.temperature;
  $('glossaryTimeout').value = gl.timeoutMs;
  $('glossaryPrompt').value = gl.prompt;
}

async function save() {
  // v0.62 起：apiKey 單獨寫到 chrome.storage.local，不進 sync
  const apiKeyValue = $('apiKey').value.trim();
  await chrome.storage.local.set({ apiKey: apiKeyValue });
  const settings = {
    geminiConfig: {
      model: getSelectedModel(),
      serviceTier: $('serviceTier').value,
      temperature: Number($('temperature').value),
      topP: Number($('topP').value),
      topK: Number($('topK').value),
      maxOutputTokens: Number($('maxOutputTokens').value),
      systemInstruction: $('systemInstruction').value,
    },
    pricing: {
      inputPerMTok: Number($('inputPerMTok').value) || 0,
      outputPerMTok: Number($('outputPerMTok').value) || 0,
    },
    domainRules: {
      whitelist: $('whitelist').value.split('\n').map(s => s.trim()).filter(Boolean),
      blacklist: $('blacklist').value.split('\n').map(s => s.trim()).filter(Boolean),
    },
    debugLog: $('debugLog').checked,
    tier: $('tier').value,
    safetyMargin: Number($('safetyMargin').value) / 100,
    maxRetries: Number($('maxRetries').value) || 3,
    maxConcurrentBatches: Number($('maxConcurrentBatches').value) || 10,
    maxTranslateUnits: Number($('maxTranslateUnits').value) ?? 1000,
    // 只有 custom tier 才寫入 override(其他 tier 的數字從對照表讀,不存)
    rpmOverride: $('tier').value === 'custom' ? (Number($('rpm').value) || null) : null,
    tpmOverride: $('tier').value === 'custom' ? (Number($('tpm').value) || null) : null,
    rpdOverride: $('tier').value === 'custom' ? (Number($('rpd').value) || null) : null,
    // v0.69: 術語表一致化
    glossary: {
      enabled: $('glossaryEnabled').checked,
      prompt: $('glossaryPrompt').value,
      temperature: Number($('glossaryTemperature').value) || 0.1,
      skipThreshold: DEFAULTS.glossary.skipThreshold,
      blockingThreshold: DEFAULTS.glossary.blockingThreshold,
      timeoutMs: Number($('glossaryTimeout').value) || 60000,
      maxTerms: DEFAULTS.glossary.maxTerms,
    },
  };
  await chrome.storage.sync.set(settings);
  $('save-status').textContent = '✓ 已儲存';
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  // v0.94: 顯示綠色已儲存提示條
  showSaveBar('saved', '設定已儲存');
}

$('save').addEventListener('click', save);

// ─── v0.94: 儲存狀態提示條 ──────────────────────────────────
let saveBarHideTimer = null;
function showSaveBar(state, text) {
  const bar = $('save-bar');
  bar.textContent = text;
  bar.className = 'save-bar ' + state; // 'dirty' 或 'saved'
  bar.hidden = false;
  if (saveBarHideTimer) clearTimeout(saveBarHideTimer);
  if (state === 'saved') {
    saveBarHideTimer = setTimeout(() => { bar.hidden = true; }, 3000);
  }
}
function markDirty() {
  const bar = $('save-bar');
  // 若目前是「已儲存」狀態，不立即覆蓋（等它自己消失）
  if (bar.classList.contains('saved') && !bar.hidden) return;
  showSaveBar('dirty', '有未儲存的變更');
}
// 監聽設定分頁內所有 input / select / textarea 的變更
document.getElementById('tab-settings').addEventListener('input', markDirty);
document.getElementById('tab-settings').addEventListener('change', markDirty);

// 顯示/隱藏 API Key 切換（v0.63）— 讓使用者能確認貼上去的 key 沒有貼錯
$('toggle-api-key').addEventListener('click', () => {
  const input = $('apiKey');
  const btn = $('toggle-api-key');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '隱藏';
    btn.setAttribute('aria-label', '隱藏 API Key');
  } else {
    input.type = 'password';
    btn.textContent = '顯示';
    btn.setAttribute('aria-label', '顯示 API Key');
  }
});

// Tier 或 Model 變更 → 自動更新 RPM/TPM/RPD 顯示
$('tier').addEventListener('change', () => {
  applyTierToInputs($('tier').value, getSelectedModel());
});
// v0.64：Model 變更 → 更新 rate limit + 自動帶入參考價 + 切換自行輸入欄位
$('model').addEventListener('change', () => {
  toggleCustomModelInput();
  const model = getSelectedModel();
  applyTierToInputs($('tier').value, model);
  applyModelPricing(model);
});
// Service Tier 變更 → 重新計算模型計價（Flex 半價、Priority 兩倍）
$('serviceTier').addEventListener('change', () => {
  applyModelPricing(getSelectedModel());
});
$('safetyMargin').addEventListener('input', () => {
  $('safetyMarginLabel').textContent = $('safetyMargin').value;
});

$('reset-defaults').addEventListener('click', async () => {
  if (!confirm('確定要回復所有預設設定嗎？\n\nAPI Key 會被保留，翻譯快取與累計使用統計不受影響。\n此操作無法復原。')) return;
  // v0.62 起：apiKey 在 chrome.storage.local，不在 sync 裡，
  // 所以直接 clear sync 即可；apiKey 自然不受影響。
  await chrome.storage.sync.clear();
  await load();
  $('save-status').textContent = '✓ 已回復預設設定';
  $('save-status').style.color = '#34c759';
  setTimeout(() => {
    $('save-status').textContent = '';
    $('save-status').style.color = '';
  }, 3000);
});

// v0.88: 舊的 view-logs 按鈕已移除，Log 改為獨立分頁

$('export-settings').addEventListener('click', async () => {
  const all = await chrome.storage.sync.get(null);
  // apiKey 不納入匯出（apiKey 本來就存在 local 不在 sync，defensive 再 delete 一次）
  delete all.apiKey;
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  // 檔名含時間到秒，避免同一天多次匯出檔名重複
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  a.href = url;
  a.download = `shinkansen-settings-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── 匯入驗證 ────────────────────────────────────────
// 對照 DEFAULTS 結構，只保留已知欄位，並檢查型別與範圍。
// 不認識的 key 直接丟掉，不合法的值回退為預設值。
function sanitizeImport(raw) {
  const clean = {};
  const warnings = [];

  // 頂層純量欄位：型別 + 範圍
  const topRules = {
    autoTranslate:       { type: 'boolean' },
    debugLog:            { type: 'boolean' },
    targetLanguage:      { type: 'string' },
    tier:                { type: 'string', oneOf: ['free', 'tier1', 'tier2', 'custom'] },
    safetyMargin:        { type: 'number', min: 0, max: 0.5 },
    maxRetries:          { type: 'number', min: 0, max: 10, int: true },
    maxConcurrentBatches:{ type: 'number', min: 1, max: 50, int: true },
    maxTranslateUnits:   { type: 'number', min: 0, max: 10000, int: true },
    rpmOverride:         { type: 'number', min: 1, nullable: true },
    tpmOverride:         { type: 'number', min: 1, nullable: true },
    rpdOverride:         { type: 'number', min: 1, nullable: true },
  };

  for (const [key, rule] of Object.entries(topRules)) {
    if (!(key in raw)) continue;
    const v = raw[key];
    if (rule.nullable && (v === null || v === undefined)) { clean[key] = null; continue; }
    if (typeof v !== rule.type) { warnings.push(`${key}：型別錯誤，已略過`); continue; }
    if (rule.type === 'number') {
      if (!Number.isFinite(v)) { warnings.push(`${key}：非有效數字，已略過`); continue; }
      if (rule.min !== undefined && v < rule.min) { warnings.push(`${key}：${v} 低於下限 ${rule.min}，已略過`); continue; }
      if (rule.max !== undefined && v > rule.max) { warnings.push(`${key}：${v} 超過上限 ${rule.max}，已略過`); continue; }
      if (rule.int && !Number.isInteger(v)) { warnings.push(`${key}：需為整數，已略過`); continue; }
    }
    if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(`${key}：「${v}」不在允許值內，已略過`); continue; }
    clean[key] = v;
  }

  // geminiConfig 子物件
  if (raw.geminiConfig && typeof raw.geminiConfig === 'object') {
    const gc = raw.geminiConfig;
    const gcClean = {};
    const gcRules = {
      model:            { type: 'string' },
      serviceTier:      { type: 'string', oneOf: ['DEFAULT', 'FLEX', 'STANDARD', 'PRIORITY'] },
      temperature:      { type: 'number', min: 0, max: 2 },
      topP:             { type: 'number', min: 0, max: 1 },
      topK:             { type: 'number', min: 1, max: 100, int: true },
      maxOutputTokens:  { type: 'number', min: 256, max: 65535, int: true },
      systemInstruction:{ type: 'string' },
    };
    for (const [key, rule] of Object.entries(gcRules)) {
      if (!(key in gc)) continue;
      const v = gc[key];
      if (typeof v !== rule.type) { warnings.push(`geminiConfig.${key}：型別錯誤，已略過`); continue; }
      if (rule.type === 'number') {
        if (!Number.isFinite(v)) { warnings.push(`geminiConfig.${key}：非有效數字，已略過`); continue; }
        if (rule.min !== undefined && v < rule.min) { warnings.push(`geminiConfig.${key}：${v} 低於下限 ${rule.min}，已略過`); continue; }
        if (rule.max !== undefined && v > rule.max) { warnings.push(`geminiConfig.${key}：${v} 超過上限 ${rule.max}，已略過`); continue; }
        if (rule.int && !Number.isInteger(v)) { warnings.push(`geminiConfig.${key}：需為整數，已略過`); continue; }
      }
      if (rule.oneOf && !rule.oneOf.includes(v)) { warnings.push(`geminiConfig.${key}：「${v}」不在允許值內，已略過`); continue; }
      gcClean[key] = v;
    }
    if (Object.keys(gcClean).length > 0) clean.geminiConfig = gcClean;
  }

  // pricing 子物件
  if (raw.pricing && typeof raw.pricing === 'object') {
    const pr = raw.pricing;
    const prClean = {};
    for (const key of ['inputPerMTok', 'outputPerMTok']) {
      if (!(key in pr)) continue;
      const v = pr[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        warnings.push(`pricing.${key}：需為非負數字，已略過`); continue;
      }
      prClean[key] = v;
    }
    if (Object.keys(prClean).length > 0) clean.pricing = prClean;
  }

  // v0.69: glossary 子物件
  if (raw.glossary && typeof raw.glossary === 'object') {
    const gl = raw.glossary;
    const glClean = {};
    if (typeof gl.enabled === 'boolean') glClean.enabled = gl.enabled;
    if (typeof gl.prompt === 'string') glClean.prompt = gl.prompt;
    if (typeof gl.temperature === 'number' && gl.temperature >= 0 && gl.temperature <= 2) glClean.temperature = gl.temperature;
    if (typeof gl.timeoutMs === 'number' && gl.timeoutMs >= 3000 && gl.timeoutMs <= 60000) glClean.timeoutMs = gl.timeoutMs;
    if (typeof gl.skipThreshold === 'number' && Number.isInteger(gl.skipThreshold) && gl.skipThreshold >= 0) glClean.skipThreshold = gl.skipThreshold;
    if (typeof gl.blockingThreshold === 'number' && Number.isInteger(gl.blockingThreshold) && gl.blockingThreshold >= 1) glClean.blockingThreshold = gl.blockingThreshold;
    if (typeof gl.maxTerms === 'number' && Number.isInteger(gl.maxTerms) && gl.maxTerms >= 1 && gl.maxTerms <= 500) glClean.maxTerms = gl.maxTerms;
    if (Object.keys(glClean).length > 0) clean.glossary = glClean;
  }

  // domainRules 子物件
  if (raw.domainRules && typeof raw.domainRules === 'object') {
    const dr = raw.domainRules;
    const drClean = {};
    for (const key of ['whitelist', 'blacklist']) {
      if (!(key in dr)) continue;
      if (Array.isArray(dr[key]) && dr[key].every(x => typeof x === 'string')) {
        drClean[key] = dr[key];
      } else {
        warnings.push(`domainRules.${key}：需為字串陣列，已略過`);
      }
    }
    if (Object.keys(drClean).length > 0) clean.domainRules = drClean;
  }

  return { clean, warnings };
}

$('import-file').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    // v0.62 起：匯入時若備份檔含 apiKey（例如舊版本匯出的檔），一律忽略
    if (Object.prototype.hasOwnProperty.call(data, 'apiKey')) {
      delete data.apiKey;
    }
    const { clean, warnings } = sanitizeImport(data);
    if (Object.keys(clean).length === 0) {
      alert('匯入失敗：檔案中沒有任何有效的設定欄位');
      return;
    }
    await chrome.storage.sync.set(clean);
    await load();
    const msg = warnings.length > 0
      ? '匯入完成，但部分欄位被略過：\n\n' + warnings.join('\n')
      : '匯入成功';
    alert(msg + '\n\n（API Key 不在匯入範圍，請自行輸入）');
  } catch (err) {
    alert('匯入失敗：' + err.message);
  }
});

$('open-shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ═══════════════════════════════════════════════════════════
// v0.86: Tab 切換 + 用量紀錄頁面
// ═══════════════════════════════════════════════════════════

// ─── Tab 切換 ────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = $('tab-' + btn.dataset.tab);
    if (panel) panel.classList.add('active');
    // 切到用量頁時載入資料
    if (btn.dataset.tab === 'usage') loadUsageData();
    // 切到 Log 頁時開始 polling
    if (btn.dataset.tab === 'log') startLogPolling();
    else stopLogPolling();
  });
});

// ─── 用量頁面狀態 ────────────────────────────────────────
let usageChart = null;
let currentGranularity = 'day';

// 預設日期範圍：近 30 天
function initUsageDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  $('usage-from').value = fmtDateInput(from);
  $('usage-to').value = fmtDateInput(to);
}

function fmtDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getUsageDateRange() {
  const fromStr = $('usage-from').value;
  const toStr = $('usage-to').value;
  const from = fromStr ? new Date(fromStr + 'T00:00:00').getTime() : Date.now() - 30 * 86400000;
  const to = toStr ? new Date(toStr + 'T23:59:59.999').getTime() : Date.now();
  return { from, to };
}

// ─── 格式化工具 ──────────────────────────────────────────
function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n) {
  if (n >= 1) return '$' + n.toFixed(2);
  if (n >= 0.01) return '$' + n.toFixed(3);
  return '$' + n.toFixed(4);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

// ─── 載入用量資料 ────────────────────────────────────────
async function loadUsageData() {
  const { from, to } = getUsageDateRange();

  // 同時載入彙總、圖表、明細
  const [statsRes, chartRes, recordsRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'QUERY_USAGE_STATS', payload: { from, to } }),
    chrome.runtime.sendMessage({ type: 'QUERY_USAGE_CHART', payload: { from, to, groupBy: currentGranularity } }),
    chrome.runtime.sendMessage({ type: 'QUERY_USAGE', payload: { from, to } }),
  ]);

  // 彙總卡片
  if (statsRes?.ok) {
    const s = statsRes.stats;
    $('usage-total-cost').textContent = fmtUSD(s.totalBilledCostUSD);
    // v0.99: 思考 token 以 output 費率計費，加入總計
    $('usage-total-tokens').textContent = fmtTokens(s.totalBilledInputTokens + s.totalOutputTokens);
    $('usage-total-count').textContent = String(s.count);
    // 找最常用模型
    let topModel = '—';
    let topCount = 0;
    for (const [m, info] of Object.entries(s.byModel || {})) {
      if (info.count > topCount) { topCount = info.count; topModel = m; }
    }
    $('usage-top-model').textContent = topModel;
  }

  // 折線圖
  if (chartRes?.ok) renderChart(chartRes.data);

  // 明細表格
  if (recordsRes?.ok) renderTable(recordsRes.records);
}

// ─── 折線圖 ──────────────────────────────────────────────
function renderChart(data) {
  const ctx = $('usage-chart').getContext('2d');

  if (usageChart) {
    usageChart.destroy();
    usageChart = null;
  }

  const labels = data.map(d => d.period);
  const tokenData = data.map(d => d.totalTokens);
  const costData = data.map(d => d.billedCostUSD);

  // 計算期間合計，顯示在圖表右上角
  const totalTokens = tokenData.reduce((s, v) => s + v, 0);
  const totalCost = costData.reduce((s, v) => s + v, 0);

  usageChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Tokens',
          data: tokenData,
          borderColor: '#0071e3',
          backgroundColor: 'rgba(0, 113, 227, 0.08)',
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
          pointRadius: data.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
        },
        {
          label: '費用（USD）',
          data: costData,
          borderColor: '#34c759',
          backgroundColor: 'rgba(52, 199, 89, 0.08)',
          fill: true,
          tension: 0.3,
          yAxisID: 'y1',
          pointRadius: data.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { font: { size: 11 }, boxWidth: 12, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: function(ctx) {
              if (ctx.datasetIndex === 0) return `Tokens: ${fmtTokens(ctx.parsed.y)}`;
              return `費用: ${fmtUSD(ctx.parsed.y)}`;
            },
          },
        },
        // Chart.js subtitle 用作期間累計顯示
        subtitle: {
          display: true,
          text: `期間合計：${fmtTokens(totalTokens)} tokens / ${fmtUSD(totalCost)}`,
          align: 'end',
          font: { size: 11, weight: 'normal' },
          color: '#86868b',
          padding: { bottom: 8 },
        },
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10 },
            maxTicksLimit: 12,
            maxRotation: 0,
          },
          grid: { display: false },
        },
        y: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          ticks: {
            font: { size: 10 },
            callback: (v) => fmtTokens(v),
          },
          title: { display: true, text: 'Tokens', font: { size: 10 }, color: '#0071e3' },
        },
        y1: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          grid: { drawOnChartArea: false },
          ticks: {
            font: { size: 10 },
            callback: (v) => '$' + v.toFixed(2),
          },
          title: { display: true, text: 'USD', font: { size: 10 }, color: '#34c759' },
        },
      },
    },
  });
}

// ─── 明細表格 ────────────────────────────────────────────
function renderTable(records) {
  const tbody = $('usage-tbody');
  const emptyMsg = $('usage-empty');

  if (!records || records.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;

  tbody.innerHTML = records.map(r => {
    // v0.99: 思考 token 以 output 費率計費，加入明細計算
    const billedTokens = (r.billedInputTokens || 0) + (r.outputTokens || 0);
    const shortModel = (r.model || '').replace('gemini-', '').replace('-preview', '');
    const title = escapeHtml(r.title || '(無標題)');
    const urlDisplay = escapeHtml(shortenUrl(r.url || ''));
    return `<tr>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${title}<span class="site-url">${urlDisplay}</span></td>
      <td>${shortModel}</td>
      <td class="num">${fmtTokens(billedTokens)}</td>
      <td class="num">${fmtUSD(r.billedCostUSD || 0)}</td>
    </tr>`;
  }).join('');
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? u.pathname.slice(0, 30) + '…' : u.pathname;
    return u.hostname + path;
  } catch { return url; }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── 事件綁定 ────────────────────────────────────────────
$('usage-from').addEventListener('change', loadUsageData);
$('usage-to').addEventListener('change', loadUsageData);

// 粒度切換
document.querySelectorAll('.gran-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gran-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentGranularity = btn.dataset.gran;
    loadUsageData();
  });
});

// 匯出 CSV
$('usage-export-csv').addEventListener('click', async () => {
  const { from, to } = getUsageDateRange();
  const res = await chrome.runtime.sendMessage({ type: 'EXPORT_USAGE_CSV', payload: { from, to } });
  if (!res?.ok) { alert('匯出失敗：' + (res?.error || '未知錯誤')); return; }
  const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const fromStr = $('usage-from').value.replace(/-/g, '');
  const toStr = $('usage-to').value.replace(/-/g, '');
  a.href = url;
  a.download = `shinkansen-usage-${fromStr}-${toStr}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// 清除紀錄
$('usage-clear').addEventListener('click', async () => {
  if (!confirm('確定要清除所有翻譯用量紀錄嗎？\n此操作無法復原。')) return;
  const res = await chrome.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  if (res?.ok) {
    loadUsageData();
  } else {
    alert('清除失敗：' + (res?.error || '未知錯誤'));
  }
});

// ═══════════════════════════════════════════════════════════
// v0.88: Log 分頁
// ═══════════════════════════════════════════════════════════

let logPollingTimer = null;
let logLatestSeq = 0;
let allLogs = [];          // 累積收到的全部 log entries

// ─── Polling ────────────────────────────────────────────
function startLogPolling() {
  if (logPollingTimer) return;
  fetchLogs();  // 立即拉一次
  logPollingTimer = setInterval(fetchLogs, 2000);
}

function stopLogPolling() {
  if (logPollingTimer) {
    clearInterval(logPollingTimer);
    logPollingTimer = null;
  }
}

async function fetchLogs() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_LOGS',
      payload: { afterSeq: logLatestSeq },
    });
    if (!res?.ok) return;
    if (res.logs && res.logs.length > 0) {
      allLogs = allLogs.concat(res.logs);
      // 前端也限制 buffer 上限，避免記憶體無限成長
      if (allLogs.length > 2000) {
        allLogs = allLogs.slice(allLogs.length - 2000);
      }
    }
    if (res.latestSeq) logLatestSeq = res.latestSeq;
    renderLogTable();
  } catch {
    // extension context invalidated 等情況，靜默
  }
}

// ─── 篩選 ───────────────────────────────────────────────
function getFilteredLogs() {
  const catFilter = $('log-category-filter').value;
  const lvlFilter = $('log-level-filter').value;
  const search = ($('log-search').value || '').trim().toLowerCase();

  return allLogs.filter(entry => {
    if (catFilter && entry.category !== catFilter) return false;
    if (lvlFilter && entry.level !== lvlFilter) return false;
    if (search) {
      const msg = (entry.message || '').toLowerCase();
      const cat = (entry.category || '').toLowerCase();
      const dataStr = entry.data ? JSON.stringify(entry.data).toLowerCase() : '';
      if (!msg.includes(search) && !cat.includes(search) && !dataStr.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

// ─── 渲染 ───────────────────────────────────────────────
const LOG_CAT_LABELS = {
  translate:   'translate',
  api:         'api',
  cache:       'cache',
  'rate-limit':'rate-limit',
  glossary:    'glossary',
  spa:         'spa',
  system:      'system',
};

function renderLogTable() {
  const tbody = $('log-tbody');
  const emptyMsg = $('log-empty');
  const filtered = getFilteredLogs();

  // 更新計數
  $('log-count').textContent = `${allLogs.length} 筆`;
  const filteredCountEl = $('log-filtered-count');
  if (filtered.length !== allLogs.length) {
    filteredCountEl.textContent = `（篩選後 ${filtered.length} 筆）`;
    filteredCountEl.hidden = false;
  } else {
    filteredCountEl.hidden = true;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyMsg.hidden = allLogs.length > 0 ? true : false;
    if (allLogs.length > 0 && filtered.length === 0) {
      emptyMsg.textContent = '沒有符合篩選條件的 Log';
      emptyMsg.hidden = false;
    } else if (allLogs.length === 0) {
      emptyMsg.textContent = '尚無 Log。翻譯一個頁面後，Log 會自動出現在這裡';
      emptyMsg.hidden = false;
    }
    return;
  }
  emptyMsg.hidden = true;

  // 只渲染最近 500 筆（避免 DOM 太大）
  const visible = filtered.slice(-500);

  // 記住哪些 data detail 是展開的，渲染後還原
  const openSet = new Set();
  for (const el of tbody.querySelectorAll('.log-data-detail.open')) {
    openSet.add(el.id);
  }

  tbody.innerHTML = visible.map(entry => {
    const time = formatLogTime(entry.t);
    const catClass = `log-cat log-cat-${entry.category || 'system'}`;
    const catLabel = LOG_CAT_LABELS[entry.category] || entry.category || 'system';
    const lvlClass = `log-lvl log-lvl-${entry.level || 'info'}`;
    const lvlLabel = (entry.level || 'info').toUpperCase();
    const rowClass = entry.level === 'error' ? 'log-row-error' :
                     entry.level === 'warn'  ? 'log-row-warn'  : '';
    const msg = escapeHtml(entry.message || '');

    // data 展開按鈕
    let dataHtml = '';
    if (entry.data && Object.keys(entry.data).length > 0) {
      const dataJson = JSON.stringify(entry.data, null, 2);
      const dataId = `log-data-${entry.seq}`;
      const isOpen = openSet.has(dataId);
      dataHtml = `<button class="log-data-toggle" data-target="${dataId}">${isOpen ? '收合' : '{…}'}</button>` +
        `<div class="log-data-detail${isOpen ? ' open' : ''}" id="${dataId}">${escapeHtml(dataJson)}</div>`;
    }

    return `<tr class="${rowClass}">` +
      `<td class="log-col-time">${time}</td>` +
      `<td class="log-col-cat"><span class="${catClass}">${catLabel}</span></td>` +
      `<td class="log-col-lvl"><span class="${lvlClass}">${lvlLabel}</span></td>` +
      `<td class="log-col-msg"><span class="log-msg-text">${msg}</span>${dataHtml}</td>` +
      `</tr>`;
  }).join('');

  // 自動捲動到底部
  if ($('log-autoscroll').checked) {
    const wrapper = $('log-table-wrapper');
    wrapper.scrollTop = wrapper.scrollHeight;
  }
}

function formatLogTime(isoStr) {
  try {
    const d = new Date(isoStr);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '??:??:??';
  }
}

// ─── 使用者手動捲動時自動關閉 autoscroll ────────────────
// 判斷邏輯：若使用者往上捲（不在底部），取消勾選；捲回底部則重新勾選
$('log-table-wrapper').addEventListener('scroll', () => {
  const w = $('log-table-wrapper');
  // 距離底部 30px 以內視為「在底部」
  const atBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 30;
  $('log-autoscroll').checked = atBottom;
});

// ─── Log 事件綁定 ───────────────────────────────────────
$('log-category-filter').addEventListener('change', renderLogTable);
$('log-level-filter').addEventListener('change', renderLogTable);
$('log-search').addEventListener('input', renderLogTable);

// 清除
$('log-clear').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  } catch { /* 靜默 */ }
  allLogs = [];
  logLatestSeq = 0;
  renderLogTable();
});

// 匯出 JSON
$('log-export').addEventListener('click', () => {
  const filtered = getFilteredLogs();
  const data = filtered.length !== allLogs.length ? filtered : allLogs;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  a.href = url;
  a.download = `shinkansen-log-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// Data 展開/收合（event delegation）
$('log-tbody').addEventListener('click', (e) => {
  const toggle = e.target.closest('.log-data-toggle');
  if (!toggle) return;
  const targetId = toggle.dataset.target;
  const detail = document.getElementById(targetId);
  if (detail) {
    detail.classList.toggle('open');
    toggle.textContent = detail.classList.contains('open') ? '收合' : '{…}';
  }
});

// ─── 初始化 ──────────────────────────────────────────────
initUsageDateRange();
load();
