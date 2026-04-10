// options.js — 設定頁邏輯
// v1.0.4: 改為 ES module，從 lib/ 匯入共用常數與工具函式，消除重複程式碼。

import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GLOSSARY_PROMPT } from '../lib/storage.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { formatTokens, formatUSD } from '../lib/format.js';

// 向下相容：舊程式碼大量使用 DEFAULTS，保留別名避免大範圍搜尋取代
const DEFAULTS = DEFAULT_SETTINGS;

// 模型參考價（Standard tier，每 1M tokens USD）— v0.64 更新
// 來源：https://ai.google.dev/gemini-api/docs/pricing（2026-04-09 擷取）
const MODEL_PRICING = {
  'gemini-3.1-flash-lite-preview': { input: 0.10, output: 0.30 },
  'gemini-3-flash-preview':      { input: 0.50, output: 3.00 },
  'gemini-3.1-pro-preview':      { input: 2.00, output: 12.00 },
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
  $('maxUnitsPerBatch').value = s.maxUnitsPerBatch ?? 12;
  $('maxCharsPerBatch').value = s.maxCharsPerBatch ?? 3500;
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
    maxUnitsPerBatch: Number($('maxUnitsPerBatch').value) || 12,
    maxCharsPerBatch: Number($('maxCharsPerBatch').value) || 3500,
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
    tier:                { type: 'string', oneOf: ['free', 'tier1', 'tier2', 'custom'] },
    safetyMargin:        { type: 'number', min: 0, max: 0.5 },
    maxRetries:          { type: 'number', min: 0, max: 10, int: true },
    maxConcurrentBatches:{ type: 'number', min: 1, max: 50, int: true },
    maxUnitsPerBatch:    { type: 'number', min: 1, max: 100, int: true },
    maxCharsPerBatch:    { type: 'number', min: 500, max: 20000, int: true },
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
    $('usage-total-cost').textContent = formatUSD(s.totalBilledCostUSD);
    // v0.99: 思考 token 以 output 費率計費，加入總計
    $('usage-total-tokens').textContent = formatTokens(s.totalBilledInputTokens + s.totalOutputTokens);
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
              if (ctx.datasetIndex === 0) return `Tokens: ${formatTokens(ctx.parsed.y)}`;
              return `費用: ${formatUSD(ctx.parsed.y)}`;
            },
          },
        },
        // Chart.js subtitle 用作期間累計顯示
        subtitle: {
          display: true,
          text: `期間合計：${formatTokens(totalTokens)} tokens / ${formatUSD(totalCost)}`,
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
            callback: (v) => formatTokens(v),
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
      <td class="num">${formatTokens(billedTokens)}</td>
      <td class="num">${formatUSD(r.billedCostUSD || 0)}</td>
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
