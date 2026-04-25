// options.js — 設定頁邏輯
// v1.0.4: 改為 ES module，從 lib/ 匯入共用常數與工具函式，消除重複程式碼。

import { browser } from '../lib/compat.js';
import { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GLOSSARY_PROMPT, DEFAULT_SUBTITLE_SYSTEM_PROMPT, getDefaultPromptsForLocale } from '../lib/storage.js';
import { TIER_LIMITS } from '../lib/tier-limits.js';
import { formatTokens, formatUSD } from '../lib/format.js';
import { t, setLocale, initLocale, applyLocale, getLocale } from '../lib/i18n.js';

// 向下相容：舊程式碼大量使用 DEFAULTS，保留別名避免大範圍搜尋取代
const DEFAULTS = DEFAULT_SETTINGS;

// v1.4.12: 模型參考價統一由 lib/model-pricing.js 提供，與 background.js 共用同一份，
// 避免兩邊不同步（以前 background 用 settings.pricing 單一值，options 用 local 表，
// preset 切換 model 時 toast 會算錯）。此處做 input/output key 轉換保留原 options.js 介面。
import { MODEL_PRICING as LIB_MODEL_PRICING } from '../lib/model-pricing.js';
const MODEL_PRICING = Object.fromEntries(
  Object.entries(LIB_MODEL_PRICING).map(([model, p]) => [model, { input: p.inputPerMTok, output: p.outputPerMTok }])
);


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

function clearChildren(el) {
  el.replaceChildren();
}

async function load() {
  const saved = await browser.storage.sync.get(null);
  // v0.62 起：apiKey 改存 browser.storage.local，不跟 Google 帳號同步
  const { apiKey: localApiKey = '' } = await browser.storage.local.get('apiKey');
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

  // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
  const opacityPct = Math.round((s.toastOpacity ?? 0.7) * 100);
  $('toastOpacity').value = opacityPct;
  $('toastOpacityLabel').textContent = opacityPct;
  $('toastPosition').value = s.toastPosition || 'bottom-right';
  // v1.1.3: Toast 自動關閉
  $('toastAutoHide').checked = s.toastAutoHide !== false;

  // v1.0.21: 頁面層級繁中偵測開關
  $('skipTraditionalChinesePage').checked = s.skipTraditionalChinesePage !== false;

  // v1.0.29: 固定術語表
  fixedGlossary = {
    global: Array.isArray(s.fixedGlossary?.global) ? s.fixedGlossary.global : [],
    byDomain: (s.fixedGlossary?.byDomain && typeof s.fixedGlossary.byDomain === 'object') ? s.fixedGlossary.byDomain : {},
  };
  currentDomain = '';
  renderGlobalTable();
  updateDomainSelect();
  showDomainPanel('');

  // v1.2.11: YouTube 字幕設定
  const yt = { ...DEFAULTS.ytSubtitle, ...(s.ytSubtitle || {}) };
  // v1.4.0: 字幕翻譯引擎
  const ytEngineEl = $('ytEngine');
  if (ytEngineEl) ytEngineEl.value = yt.engine || 'gemini';
  $('ytAutoTranslate').checked       = yt.autoTranslate       === true;
  $('ytDebugToast').checked          = yt.debugToast          === true;
  $('ytOnTheFly').checked            = yt.onTheFly            === true;  // v1.2.49
  // ytPreserveLineBreaks 已於 v1.2.38 移除（功能改為永遠開啟）
  $('ytWindowSizeS').value           = yt.windowSizeS ?? 30;
  $('ytLookaheadS').value            = yt.lookaheadS  ?? 10;
  $('ytTemperature').value           = yt.temperature  ?? 1;
  $('ytSystemPrompt').value          = yt.systemPrompt || DEFAULT_SUBTITLE_SYSTEM_PROMPT;
  // v1.2.39: 獨立模型 + 計價
  const ytModelSel = $('ytModel');
  const savedYtModel = yt.model || '';
  if ([...ytModelSel.options].some(o => o.value === savedYtModel)) {
    ytModelSel.value = savedYtModel;
  } else {
    ytModelSel.value = '';
  }
  const ytPricing = yt.pricing;
  $('ytInputPerMTok').value  = ytPricing?.inputPerMTok  != null ? ytPricing.inputPerMTok  : '';
  $('ytOutputPerMTok').value = ytPricing?.outputPerMTok != null ? ytPricing.outputPerMTok : '';

  // v1.4.13: 三組 preset 快速鍵
  const presets = Array.isArray(s.translatePresets) && s.translatePresets.length > 0
    ? s.translatePresets
    : DEFAULTS.translatePresets;
  for (const slot of [1, 2, 3]) {
    const p = presets.find(x => x.slot === slot) || DEFAULTS.translatePresets.find(x => x.slot === slot);
    $(`preset-label-${slot}`).value = p.label || '';
    $(`preset-engine-${slot}`).value = p.engine === 'google' ? 'google' : 'gemini';
    const modelSel = $(`preset-model-${slot}`);
    if (p.model && [...modelSel.options].some(o => o.value === p.model)) {
      modelSel.value = p.model;
    } else {
      modelSel.value = 'gemini-3-flash-preview';
    }
    updatePresetModelVisibility(slot);
  }
  refreshPresetKeyBindings();
}

// v1.4.13: engine='google' 時隱藏 model 欄
function updatePresetModelVisibility(slot) {
  const engine = $(`preset-engine-${slot}`).value;
  const row = $(`preset-model-row-${slot}`);
  if (row) row.hidden = engine === 'google';
}

// v1.4.13: 從 chrome.commands.getAll() 讀取實際綁定鍵位顯示在每張 card 右上角
async function refreshPresetKeyBindings() {
  try {
    const cmds = await browser.commands.getAll();
    for (const slot of [1, 2, 3]) {
      const cmd = cmds.find(c => c.name === `translate-preset-${slot}`);
      const keyEl = $(`preset-key-${slot}`);
      if (!keyEl) continue;
      if (cmd?.shortcut) {
        keyEl.textContent = cmd.shortcut;
        keyEl.removeAttribute('data-unset');
      } else {
        keyEl.textContent = t('opt_preset_key_unset');
        keyEl.setAttribute('data-unset', '1');
      }
    }
  } catch { /* Safari / 舊瀏覽器不支援 commands API，欄位維持 '—' */ }
}

async function save() {
  // v0.62 起：apiKey 單獨寫到 browser.storage.local，不進 sync
  const apiKeyValue = $('apiKey').value.trim();
  await browser.storage.local.set({ apiKey: apiKeyValue });
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
    // v1.0.17: Toast 透明度 / v1.0.31: Toast 位置
    toastOpacity: Number($('toastOpacity').value) / 100,
    toastPosition: $('toastPosition').value,
    // v1.1.3: Toast 自動關閉
    toastAutoHide: $('toastAutoHide').checked,
    // v1.0.21: 頁面層級繁中偵測開關
    skipTraditionalChinesePage: $('skipTraditionalChinesePage').checked,
    // v1.2.11: YouTube 字幕設定
    ytSubtitle: {
      engine: ($('ytEngine')?.value || 'gemini'),  // v1.4.0
      autoTranslate:      $('ytAutoTranslate').checked,
      debugToast:         $('ytDebugToast').checked,
      onTheFly:           $('ytOnTheFly').checked,          // v1.2.49
      // preserveLineBreaks: 已移除 toggle，永遠 true（content-youtube.js 硬編碼）
      windowSizeS:  Number($('ytWindowSizeS').value)  || 30,
      lookaheadS:   Number($('ytLookaheadS').value)   || 10,
      temperature:  Number($('ytTemperature').value)  ?? 1,
      systemPrompt: $('ytSystemPrompt').value || DEFAULT_SUBTITLE_SYSTEM_PROMPT,
      // v1.2.39: 獨立模型 + 計價
      model: $('ytModel').value || '',
      pricing: (() => {
        const inp = parseFloat($('ytInputPerMTok').value);
        const out = parseFloat($('ytOutputPerMTok').value);
        if (isNaN(inp) && isNaN(out)) return null; // 空白 → 與主模型相同，null 表示不覆蓋
        return {
          inputPerMTok:  isNaN(inp) ? null : inp,
          outputPerMTok: isNaN(out) ? null : out,
        };
      })(),
    },
    // v1.4.13: 三組 preset 快速鍵
    translatePresets: [1, 2, 3].map(slot => {
      const engine = $(`preset-engine-${slot}`).value === 'google' ? 'google' : 'gemini';
      const model = engine === 'google' ? null : ($(`preset-model-${slot}`).value || null);
      const label = ($(`preset-label-${slot}`).value || '').trim() || `預設 ${slot}`;
      return { slot, engine, model, label };
    }),
    // v1.0.29: 固定術語表（save 前先同步 UI → 記憶體）
    fixedGlossary: (() => {
      // 同步全域表格的最新 UI 值
      fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
      // 同步當前網域表格的最新 UI 值
      if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
        fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
      }
      // 過濾掉空的 entries（source 和 target 都為空）
      const cleanGlobal = fixedGlossary.global.filter(e => e.source || e.target);
      const cleanByDomain = {};
      for (const [domain, entries] of Object.entries(fixedGlossary.byDomain)) {
        const clean = entries.filter(e => e.source || e.target);
        if (clean.length > 0) cleanByDomain[domain] = clean;
      }
      return { global: cleanGlobal, byDomain: cleanByDomain };
    })(),
  };
  await browser.storage.sync.set(settings);
  $('save-status').textContent = t('opt_saved');
  setTimeout(() => { $('save-status').textContent = ''; }, 2000);
  // v0.94: 顯示綠色已儲存提示條
  showSaveBar('saved', t('opt_saved'));
}

$('save').addEventListener('click', save);
// v1.0.28: Gemini 分頁也共用同一個 save()
$('save-gemini').addEventListener('click', save);
// v1.0.29: 術語表分頁也共用同一個 save()
$('save-glossary').addEventListener('click', save);
// v1.2.11: YouTube 字幕分頁
$('save-youtube').addEventListener('click', save);
// Debug 分頁
$('save-debug').addEventListener('click', save);
$('yt-reset-prompt').addEventListener('click', () => {
  $('ytSystemPrompt').value = getDefaultPromptsForLocale(getLocale()).subtitlePrompt;
  markDirty(); // 值已變更，標記為未儲存
});

// v1.4.13: preset engine 下拉切換時隱藏/顯示 model row
for (const slot of [1, 2, 3]) {
  $(`preset-engine-${slot}`).addEventListener('change', () => updatePresetModelVisibility(slot));
}

// v1.2.39: 切換 YouTube 模型時自動帶入參考計價（與主模型的邏輯相同）
$('ytModel').addEventListener('change', () => {
  const model = $('ytModel').value;
  if (!model) {
    // 空 = 與主模型相同，清空計價欄位讓 placeholder 顯示
    $('ytInputPerMTok').value  = '';
    $('ytOutputPerMTok').value = '';
    return;
  }
  const p = MODEL_PRICING[model];
  if (p) {
    $('ytInputPerMTok').value  = p.input;
    $('ytOutputPerMTok').value = p.output;
  }
});

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
// 監聽設定分頁與 Gemini 分頁內所有 input / select / textarea 的變更
document.getElementById('tab-settings').addEventListener('input', markDirty);
document.getElementById('tab-settings').addEventListener('change', markDirty);
document.getElementById('tab-gemini').addEventListener('input', markDirty);
document.getElementById('tab-gemini').addEventListener('change', markDirty);
document.getElementById('tab-glossary').addEventListener('input', markDirty);
document.getElementById('tab-glossary').addEventListener('change', markDirty);
// v1.2.13: YouTube 字幕分頁也需要 dirty 偵測
document.getElementById('tab-youtube').addEventListener('input', markDirty);
document.getElementById('tab-youtube').addEventListener('change', markDirty);
// tab-log 的 debugLog checkbox 是真實設定，需要單獨監聽
// （tab-log 不在 tab-level delegation 內，因為其他 log 控制項是純 UI 不需要 dirty）
// 只有實際需要存的 checkbox 才個別掛 markDirty
$('debugLog').addEventListener('change', markDirty);
$('ytDebugToast').addEventListener('change', markDirty);
$('ytOnTheFly').addEventListener('change', markDirty);

// 顯示/隱藏 API Key 切換（v0.63）— 讓使用者能確認貼上去的 key 沒有貼錯
$('toggle-api-key').addEventListener('click', () => {
  const input = $('apiKey');
  const btn = $('toggle-api-key');
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = t('opt_api_key_hide');
    btn.setAttribute('aria-label', t('opt_api_key_hide') + ' API Key');
  } else {
    input.type = 'password';
    btn.textContent = t('opt_api_key_show');
    btn.setAttribute('aria-label', t('opt_api_key_show') + ' API Key');
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
$('toastOpacity').addEventListener('input', () => {
  $('toastOpacityLabel').textContent = $('toastOpacity').value;
});
$('toastPosition').addEventListener('change', markDirty);

$('reset-defaults').addEventListener('click', async () => {
  if (!confirm(t('opt_confirm_reset'))) return;
  // v0.62 起：apiKey 在 browser.storage.local，不在 sync 裡，
  // 所以直接 clear sync 即可；apiKey 自然不受影響。
  await browser.storage.sync.clear();
  await load();
  $('save-status').textContent = t('opt_reset_done');
  $('save-status').style.color = '#34c759';
  setTimeout(() => {
    $('save-status').textContent = '';
    $('save-status').style.color = '';
  }, 3000);
});

// v0.88: 舊的 view-logs 按鈕已移除，Log 改為獨立分頁

$('export-settings').addEventListener('click', async () => {
  const all = await browser.storage.sync.get(null);
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
    toastAutoHide:       { type: 'boolean' },
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
    for (const key of ['whitelist']) {
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
      alert(t('opt_import_fail_empty'));
      return;
    }
    await browser.storage.sync.set(clean);
    await load();
    const msg = warnings.length > 0
      ? t('opt_import_partial') + '\n\n' + warnings.join('\n')
      : t('opt_import_success');
    alert(msg + '\n\n' + t('opt_import_apikey_note'));
  } catch (err) {
    alert(t('opt_import_fail', err.message));
  }
});

// v1.5: 快捷鍵設定連結——Chrome / Firefox / Safari 三分支
const _isFirefox = typeof globalThis.browser !== 'undefined'
  && typeof globalThis.browser.runtime?.getBrowserInfo === 'function';
const _isChrome = typeof globalThis.chrome !== 'undefined' && !_isFirefox;

if (_isChrome) {
  $('open-shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
} else if (_isFirefox) {
  $('open-shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    browser.tabs.create({ url: 'about:addons' });
  });
} else {
  // Safari：隱藏快捷鍵設定連結
  const shortcutsLink = $('open-shortcuts');
  if (shortcutsLink) shortcutsLink.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// v1.0.29: 固定術語表 CRUD
// ═══════════════════════════════════════════════════════════

// 記憶體中的固定術語表資料（load 時從 storage 讀入，save 時寫回）
let fixedGlossary = { global: [], byDomain: {} };
let currentDomain = ''; // 目前選中的網域

function renderGlossaryTable(tbody, entries) {
  const rows = entries.map((e, i) => {
    const row = document.createElement('tr');
    row.dataset.idx = String(i);

    const sourceCell = document.createElement('td');
    const sourceInput = document.createElement('input');
    sourceInput.type = 'text';
    sourceInput.className = 'fg-source';
    sourceInput.value = e.source || '';
    sourceInput.placeholder = '英文原文';
    sourceCell.appendChild(sourceInput);

    const targetCell = document.createElement('td');
    const targetInput = document.createElement('input');
    targetInput.type = 'text';
    targetInput.className = 'fg-target';
    targetInput.value = e.target || '';
    targetInput.placeholder = '中文譯文';
    targetCell.appendChild(targetInput);

    const actionCell = document.createElement('td');
    actionCell.className = 'glossary-col-action';
    const deleteButton = document.createElement('button');
    deleteButton.className = 'glossary-delete-row';
    deleteButton.dataset.idx = String(i);
    deleteButton.title = '刪除';
    deleteButton.textContent = '×';
    actionCell.appendChild(deleteButton);

    row.append(sourceCell, targetCell, actionCell);
    return row;
  });
  tbody.replaceChildren(...rows);
}

function readGlossaryTableEntries(tbody) {
  const rows = tbody.querySelectorAll('tr');
  const entries = [];
  for (const row of rows) {
    const source = (row.querySelector('.fg-source')?.value || '').trim();
    const target = (row.querySelector('.fg-target')?.value || '').trim();
    if (source || target) entries.push({ source, target });
  }
  return entries;
}

// 全域術語表
function renderGlobalTable() {
  renderGlossaryTable($('fixed-global-tbody'), fixedGlossary.global);
}

$('fixed-global-add').addEventListener('click', () => {
  fixedGlossary.global.push({ source: '', target: '' });
  renderGlobalTable();
  // 自動 focus 新增列的 source 欄
  const rows = $('fixed-global-tbody').querySelectorAll('tr');
  if (rows.length) rows[rows.length - 1].querySelector('.fg-source')?.focus();
  markDirty();
});

$('fixed-global-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.glossary-delete-row');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  // 先把目前 UI 的值同步回記憶體
  fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
  fixedGlossary.global.splice(idx, 1);
  renderGlobalTable();
  markDirty();
});

// 失焦時同步 UI → 記憶體
$('fixed-global-tbody').addEventListener('focusout', () => {
  fixedGlossary.global = readGlossaryTableEntries($('fixed-global-tbody'));
});

// 網域術語表
function updateDomainSelect() {
  const sel = $('fixed-domain-select');
  const domains = Object.keys(fixedGlossary.byDomain).sort();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '選擇網域…';
  const domainOptions = domains.map(d => {
    const option = document.createElement('option');
    option.value = d;
    option.textContent = d;
    return option;
  });
  sel.replaceChildren(defaultOption, ...domainOptions);
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    sel.value = currentDomain;
  }
}

function showDomainPanel(domain) {
  currentDomain = domain;
  if (!domain || !fixedGlossary.byDomain[domain]) {
    $('fixed-domain-panel').hidden = true;
    return;
  }
  $('fixed-domain-panel').hidden = false;
  $('fixed-domain-label').textContent = domain;
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[domain]);
}

$('fixed-domain-select').addEventListener('change', () => {
  // 切換前先同步當前網域的 UI 值
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  }
  showDomainPanel($('fixed-domain-select').value);
});

$('fixed-domain-add-btn').addEventListener('click', () => {
  const input = $('fixed-domain-input');
  const domain = (input.value || '').trim().toLowerCase();
  if (!domain) return;
  if (!fixedGlossary.byDomain[domain]) {
    fixedGlossary.byDomain[domain] = [];
  }
  input.value = '';
  updateDomainSelect();
  $('fixed-domain-select').value = domain;
  showDomainPanel(domain);
  markDirty();
});

$('fixed-domain-delete').addEventListener('click', () => {
  if (!currentDomain) return;
  if (!confirm(`確定要刪除「${currentDomain}」的網域術語表嗎？`)) return;
  delete fixedGlossary.byDomain[currentDomain];
  currentDomain = '';
  updateDomainSelect();
  showDomainPanel('');
  markDirty();
});

$('fixed-domain-add-row').addEventListener('click', () => {
  if (!currentDomain) return;
  // 先同步 UI → 記憶體
  fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  fixedGlossary.byDomain[currentDomain].push({ source: '', target: '' });
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[currentDomain]);
  const rows = $('fixed-domain-tbody').querySelectorAll('tr');
  if (rows.length) rows[rows.length - 1].querySelector('.fg-source')?.focus();
  markDirty();
});

$('fixed-domain-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.glossary-delete-row');
  if (!btn || !currentDomain) return;
  const idx = Number(btn.dataset.idx);
  fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  fixedGlossary.byDomain[currentDomain].splice(idx, 1);
  renderGlossaryTable($('fixed-domain-tbody'), fixedGlossary.byDomain[currentDomain]);
  markDirty();
});

$('fixed-domain-tbody').addEventListener('focusout', () => {
  if (currentDomain && fixedGlossary.byDomain[currentDomain]) {
    fixedGlossary.byDomain[currentDomain] = readGlossaryTableEntries($('fixed-domain-tbody'));
  }
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
let allUsageRecords = [];   // v1.2.60: client-side 搜尋用，保留完整記錄

// v1.2.60: 預設日期範圍：近 30 天（datetime-local 格式 YYYY-MM-DDTHH:MM）
function initUsageDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  from.setHours(0, 0, 0, 0);
  $('usage-from').value = fmtDateTimeInput(from);
  $('usage-to').value = fmtDateTimeInput(to);
}

function fmtDateTimeInput(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getUsageDateRange() {
  const fromStr = $('usage-from').value;
  const toStr = $('usage-to').value;
  // datetime-local 格式已含時間，直接 parse；不含時間（舊存值）加預設時間
  const from = fromStr ? new Date(fromStr.includes('T') ? fromStr : fromStr + 'T00:00').getTime()
                       : Date.now() - 30 * 86400000;
  const to   = toStr   ? new Date(toStr.includes('T')   ? toStr   : toStr   + 'T23:59').getTime()
                       : Date.now();
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
    browser.runtime.sendMessage({ type: 'QUERY_USAGE_STATS', payload: { from, to } }),
    browser.runtime.sendMessage({ type: 'QUERY_USAGE_CHART', payload: { from, to, groupBy: currentGranularity } }),
    browser.runtime.sendMessage({ type: 'QUERY_USAGE', payload: { from, to } }),
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

  // 明細表格（v1.2.60: 存入 allUsageRecords 供搜尋過濾用；v1.3.2: 同步重建模型篩選選項）
  if (recordsRes?.ok) {
    allUsageRecords = recordsRes.records || [];
    populateModelFilter();
    applyUsageSearch();
  }
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
    clearChildren(tbody);
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;

  const rows = records.map(r => {
    const isGoogle = r.engine === 'google';  // v1.4.0
    // v0.99: 思考 token 以 output 費率計費，加入明細計算
    const billedTokens = (r.billedInputTokens || 0) + (r.outputTokens || 0);
    const shortModel = isGoogle
      ? 'Google'
      : (r.model || '').replace('gemini-', '').replace('-preview', '');
    const title = r.title || '(無標題)';
    const urlDisplay = shortenUrl(r.url || '');
    const urlFull = r.url || '';
    // v1.0.30: Gemini implicit cache hit rate（Google Translate 不適用）
    const inputTk = r.inputTokens || 0;
    const cachedTk = r.cachedTokens || 0;
    const hitRate = (!isGoogle && inputTk > 0) ? Math.round(cachedTk / inputTk * 100) : 0;
    const costCell = isGoogle ? '$0（免費）' : formatUSD(r.billedCostUSD || 0);
    const row = document.createElement('tr');

    const timeCell = document.createElement('td');
    timeCell.textContent = fmtTime(r.timestamp);

    const titleCell = document.createElement('td');
    titleCell.appendChild(document.createTextNode(title));
    const urlEl = urlFull ? document.createElement('a') : document.createElement('span');
    urlEl.className = 'site-url';
    urlEl.textContent = urlDisplay;
    if (urlFull) {
      urlEl.href = urlFull;
      urlEl.target = '_blank';
      urlEl.rel = 'noopener';
    }
    titleCell.appendChild(urlEl);

    const modelCell = document.createElement('td');
    modelCell.className = 'col-model';
    modelCell.textContent = shortModel;

    const tokenCell = document.createElement('td');
    tokenCell.className = 'num';
    if (isGoogle) {
      tokenCell.textContent = `${(r.chars || 0).toLocaleString()} 字元`;
    } else {
      tokenCell.appendChild(document.createTextNode(formatTokens(billedTokens)));
      if (hitRate > 0) {
        const hit = document.createElement('span');
        hit.className = 'usage-cache-hit';
        hit.textContent = `(${hitRate}% hit)`;
        tokenCell.appendChild(hit);
      }
    }

    const costTd = document.createElement('td');
    costTd.className = 'num';
    costTd.textContent = costCell;

    row.append(timeCell, titleCell, modelCell, tokenCell, costTd);
    return row;
  });
  tbody.replaceChildren(...rows);
}

// v1.2.62: 從記錄陣列重算彙總卡片（讓搜尋/filter 結果同步反映在計費數字上）
function updateSummaryFromRecords(records) {
  let totalCost = 0, totalTokens = 0;
  const modelCount = {};
  for (const r of records) {
    totalCost += r.billedCostUSD || 0;
    totalTokens += (r.billedInputTokens || 0) + (r.outputTokens || 0);
    const m = r.model || '';
    modelCount[m] = (modelCount[m] || 0) + 1;
  }
  let topModel = '—', topCount = 0;
  for (const [m, c] of Object.entries(modelCount)) {
    if (c > topCount) { topCount = c; topModel = m; }
  }
  $('usage-total-cost').textContent   = formatUSD(totalCost);
  $('usage-total-tokens').textContent = formatTokens(totalTokens);
  $('usage-total-count').textContent  = String(records.length);
  $('usage-top-model').textContent    = topModel;
}

// v1.3.2: 從 allUsageRecords 動態建立模型篩選下拉選項
function populateModelFilter() {
  const sel = $('usage-model-filter');
  if (!sel) return;
  const currentVal = sel.value;
  const models = [...new Set(allUsageRecords.map(r => r.model || '').filter(Boolean))].sort();
  // 重建選項（保留「全部模型」作為第一個選項）
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = t('opt_usage_model_all');
  const modelOptions = models.map(m => {
    const option = document.createElement('option');
    option.value = m;
    option.textContent = m.replace('gemini-', '').replace('-preview', '');
    option.selected = m === currentVal;
    return option;
  });
  sel.replaceChildren(defaultOption, ...modelOptions);
}

// v1.2.60: 搜尋過濾，同時比對標題與 URL；v1.3.2: 加入模型篩選
function applyUsageSearch() {
  const q = ($('usage-search')?.value || '').trim().toLowerCase();
  const modelFilter = ($('usage-model-filter')?.value || '');
  let filtered = allUsageRecords;
  if (q) {
    filtered = filtered.filter(r =>
      (r.title || '').toLowerCase().includes(q) ||
      (r.url || '').toLowerCase().includes(q));
  }
  if (modelFilter) {
    filtered = filtered.filter(r => (r.model || '') === modelFilter);
  }
  renderTable(filtered);
  updateSummaryFromRecords(filtered);
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    // v1.2.60: YouTube watch 頁保留 ?v= 參數，否則顯示沒意義的 /watch
    if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') &&
        u.pathname === '/watch' && u.searchParams.get('v')) {
      return u.hostname + '/watch?v=' + u.searchParams.get('v');
    }
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 40) + '…' : u.pathname;
    return u.hostname + path;
  } catch { return url; }
}

// ─── 事件綁定 ────────────────────────────────────────────
$('usage-from').addEventListener('change', loadUsageData);
$('usage-to').addEventListener('change', loadUsageData);
// v1.2.60: 搜尋框即時過濾
$('usage-search')?.addEventListener('input', applyUsageSearch);
$('usage-model-filter')?.addEventListener('change', applyUsageSearch);

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
  const res = await browser.runtime.sendMessage({ type: 'EXPORT_USAGE_CSV', payload: { from, to } });
  if (!res?.ok) { alert(t('opt_usage_export_fail', res?.error || t('popup_unknown_error'))); return; }
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
  if (!confirm(t('opt_usage_confirm_clear'))) return;
  const res = await browser.runtime.sendMessage({ type: 'CLEAR_USAGE' });
  if (res?.ok) {
    loadUsageData();
  } else {
    alert(t('opt_usage_clear_fail', res?.error || t('popup_unknown_error')));
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
    const res = await browser.runtime.sendMessage({
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
    clearChildren(tbody);
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

  const rows = visible.map(entry => {
    const time = formatLogTime(entry.t);
    const catClass = `log-cat log-cat-${entry.category || 'system'}`;
    const catLabel = LOG_CAT_LABELS[entry.category] || entry.category || 'system';
    const lvlClass = `log-lvl log-lvl-${entry.level || 'info'}`;
    const lvlLabel = (entry.level || 'info').toUpperCase();
    const rowClass = entry.level === 'error' ? 'log-row-error' :
                     entry.level === 'warn'  ? 'log-row-warn'  : '';
    const row = document.createElement('tr');
    row.className = rowClass;

    const timeCell = document.createElement('td');
    timeCell.className = 'log-col-time';
    timeCell.textContent = time;

    const catCell = document.createElement('td');
    catCell.className = 'log-col-cat';
    const catSpan = document.createElement('span');
    catSpan.className = catClass;
    catSpan.textContent = catLabel;
    catCell.appendChild(catSpan);

    const lvlCell = document.createElement('td');
    lvlCell.className = 'log-col-lvl';
    const lvlSpan = document.createElement('span');
    lvlSpan.className = lvlClass;
    lvlSpan.textContent = lvlLabel;
    lvlCell.appendChild(lvlSpan);

    const msgCell = document.createElement('td');
    msgCell.className = 'log-col-msg';
    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-msg-text';
    msgSpan.textContent = entry.message || '';
    msgCell.appendChild(msgSpan);

    // data 展開按鈕
    if (entry.data && Object.keys(entry.data).length > 0) {
      const dataJson = JSON.stringify(entry.data, null, 2);
      const dataId = `log-data-${entry.seq}`;
      const isOpen = openSet.has(dataId);

      const toggle = document.createElement('button');
      toggle.className = 'log-data-toggle';
      toggle.dataset.target = dataId;
      toggle.textContent = isOpen ? '收合' : '{…}';

      const detail = document.createElement('div');
      detail.className = 'log-data-detail';
      if (isOpen) detail.classList.add('open');
      detail.id = dataId;
      detail.textContent = dataJson;

      msgCell.append(toggle, detail);
    }

    row.append(timeCell, catCell, lvlCell, msgCell);
    return row;
  });
  tbody.replaceChildren(...rows);

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
    await browser.runtime.sendMessage({ type: 'CLEAR_LOGS' });
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

// v1.5: 多語言初始化
initLocale().then(() => {
  // 設定語言下拉框
  const localeSelect = $('uiLocale');
  if (localeSelect) localeSelect.value = getLocale();
  // 套用 data-i18n 屬性
  applyLocale(document);
  applyRichTextLocale();
  load();
});

// 含 HTML 的元素不能用 innerHTML（Mozilla AMO 安全警告），改用 DOM API 安全構建。
// 這些元素的連結 URL 固定不變，只有文字部分隨語言切換。
function applyRichTextLocale() {
  // helper: 用 DOM API 安全地設定含 <strong> 的文字
  function setWithStrong(id, text) {
    const el = $(id);
    if (!el) return;
    // 簡單處理：找 <strong>...</strong> 標記，拆成三段
    const m = text.match(/^(.*?)<strong>(.*?)<\/strong>(.*)$/);
    if (m) {
      el.textContent = '';
      el.appendChild(document.createTextNode(m[1]));
      const strong = document.createElement('strong');
      strong.textContent = m[2];
      el.appendChild(strong);
      el.appendChild(document.createTextNode(m[3]));
    } else {
      el.textContent = text;
    }
  }
  // helper: 設定「文字 + 連結」格式的段落
  function setWithLink(id, text, href, linkText) {
    const el = $(id);
    if (!el) return;
    el.textContent = '';
    el.appendChild(document.createTextNode(text));
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = linkText;
    el.appendChild(a);
  }

  setWithStrong('license-type', t('opt_license_type'));
  setWithStrong('license-summary', t('opt_license_summary'));

  // license-full: "...，或參閱 [link]。"
  const fullEl = $('license-full');
  if (fullEl) {
    fullEl.textContent = '';
    fullEl.appendChild(document.createTextNode(t('opt_license_full_before')));
    const a = document.createElement('a');
    a.href = 'https://www.elastic.co/licensing/elastic-license';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = t('opt_license_full_link');
    fullEl.appendChild(a);
    fullEl.appendChild(document.createTextNode(t('opt_license_full_after')));
  }

  // license-author: "原作者：Jimmy Su ・ Twitter (X)：[@jimmy_su]"
  setWithLink('license-author',
    t('opt_license_author_text'),
    'https://x.com/jimmy_su', '@jimmy_su');

  // license-fork-author: "改版作者：r404r ・ [GitHub]（...）"
  setWithLink('license-fork-author',
    t('opt_license_fork_text'),
    'https://github.com/r404r/shinkansen', 'GitHub');

  // usage-desc: "...實際帳單請至 [link] 查詢"
  const usageEl = $('usage-desc');
  if (usageEl) {
    usageEl.textContent = '';
    usageEl.appendChild(document.createTextNode(t('opt_usage_desc_before')));
    const a = document.createElement('a');
    a.href = 'https://aistudio.google.com/spend';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = 'Gemini API Spend';
    usageEl.appendChild(a);
    usageEl.appendChild(document.createTextNode(t('opt_usage_desc_after')));
  }
}

// 語言切換事件
$('uiLocale')?.addEventListener('change', async (e) => {
  const locale = e.target.value;
  setLocale(locale);
  await browser.storage.sync.set({ uiLocale: locale });
  applyLocale(document);
  applyRichTextLocale();
  // Update prompt textareas to match new locale
  const prompts = getDefaultPromptsForLocale(locale);
  const siEl = $('systemInstruction');
  if (siEl) siEl.value = prompts.systemPrompt;
  const gpEl = $('glossaryPrompt');
  if (gpEl) gpEl.value = prompts.glossaryPrompt;
  const ytEl = $('ytSystemPrompt');
  if (ytEl) ytEl.value = prompts.subtitlePrompt;
});
