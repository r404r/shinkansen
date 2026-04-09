// options.js — 設定頁邏輯

const DEFAULT_SYSTEM_PROMPT = `你是一位專業的翻譯助理。請將使用者提供的文字翻譯成繁體中文（台灣用語），遵守以下規則：
1. 只輸出譯文，不要加任何解釋、前言或後記。
2. 保留原文中的專有名詞、產品名、人名、程式碼、網址、數字與符號。
3. 使用台灣慣用的翻譯（例如 software → 軟體、而非「軟件」;database → 資料庫、而非「數據庫」)。
4. 若輸入包含多段文字（以特定分隔符號區隔），請逐段翻譯並以相同分隔符號輸出。
5. 語氣自然流暢，避免直譯與機械感。`;

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
    model: 'gemini-2.5-flash',
    serviceTier: 'DEFAULT',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    useThinking: false,
    systemInstruction: DEFAULT_SYSTEM_PROMPT,
  },
  pricing: {
    inputPerMTok: 0.30,
    outputPerMTok: 2.50,
  },
  // v0.69: 術語表一致化
  glossary: {
    enabled: true,
    prompt: DEFAULT_GLOSSARY_PROMPT,
    temperature: 0.1,
    skipThreshold: 1,
    blockingThreshold: 5,
    timeoutMs: 60000,
    maxTerms: 200,
  },
  targetLanguage: 'zh-TW',
  domainRules: { whitelist: [], blacklist: [] },
  autoTranslate: true,
  debugLog: false,
  tier: 'tier1',
  safetyMargin: 0.1,
  maxRetries: 3,
  rpmOverride: null,
  tpmOverride: null,
  rpdOverride: null,
  maxConcurrentBatches: 10,
};

// 模型參考價（Standard tier，每 1M tokens USD）— v0.64 更新
// 來源：https://ai.google.dev/gemini-api/docs/pricing（2026-04-09 擷取）
const MODEL_PRICING = {
  'gemini-2.5-flash-lite':       { input: 0.10, output: 0.40 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-2.5-flash':            { input: 0.30, output: 2.50 },
  'gemini-3-flash-preview':      { input: 0.50, output: 3.00 },
  'gemini-2.5-pro':              { input: 1.25, output: 10.00 },
  'gemini-3.1-pro-preview':      { input: 2.00, output: 12.00 },
};

// Tier 對照表(與 lib/tier-limits.js 內容一致。options.js 是普通 script 不走 ES module,
// 只能複製一份)。v0.64：移除 gemini-2.0-flash，新增 3 / 3.1 系列（preview 模型
// 暫用保守估計值，rate limit 可能隨正式版調整）。
const TIER_LIMITS = {
  free: {
    'gemini-2.5-pro':                { rpm: 5,   tpm: 250000,   rpd: 100 },
    'gemini-2.5-flash':              { rpm: 10,  tpm: 250000,   rpd: 250 },
    'gemini-2.5-flash-lite':         { rpm: 15,  tpm: 250000,   rpd: 1000 },
    'gemini-3-flash-preview':        { rpm: 10,  tpm: 250000,   rpd: 250 },
    'gemini-3.1-flash-lite-preview': { rpm: 15,  tpm: 250000,   rpd: 1000 },
    'gemini-3.1-pro-preview':        { rpm: 5,   tpm: 250000,   rpd: 100 },
  },
  tier1: {
    'gemini-2.5-pro':                { rpm: 150, tpm: 1000000,  rpd: 1000 },
    'gemini-2.5-flash':              { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-2.5-flash-lite':         { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-3-flash-preview':        { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-3.1-flash-lite-preview': { rpm: 300, tpm: 2000000,  rpd: 1500 },
    'gemini-3.1-pro-preview':        { rpm: 150, tpm: 1000000,  rpd: 1000 },
  },
  tier2: {
    'gemini-2.5-pro':                { rpm: 1000, tpm: 2000000, rpd: 10000 },
    'gemini-2.5-flash':              { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-2.5-flash-lite':         { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-3-flash-preview':        { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-3.1-flash-lite-preview': { rpm: 2000, tpm: 4000000, rpd: 10000 },
    'gemini-3.1-pro-preview':        { rpm: 1000, tpm: 2000000, rpd: 10000 },
  },
};

// v0.64：取得實際模型字串（處理自行輸入的情況）
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
  const p = MODEL_PRICING[model];
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
  rpdEl.value = limits.rpd;
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
  // v0.64：若存的模型不在 dropdown 選項裡（例如舊版的 gemini-2.0-flash 或使用者
  // 自行輸入過的自訂模型），自動切到「自行輸入」並填入值
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
  $('useThinking').checked = s.geminiConfig.useThinking === true;
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
      useThinking: $('useThinking').checked,
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
}

$('save').addEventListener('click', save);

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

$('view-logs').addEventListener('click', async () => {
  const { shinkansenLogs = [] } = await chrome.storage.local.get('shinkansenLogs');
  const view = $('log-view');
  view.hidden = false;
  view.textContent = shinkansenLogs.length
    ? shinkansenLogs.slice(-100).map(l => JSON.stringify(l)).join('\n')
    : '(尚無 Log)';
});

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
      useThinking:      { type: 'boolean' },
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

load();
