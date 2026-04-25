// popup.js — 工具列面板邏輯

import { browser } from '../lib/compat.js';
import { formatBytes, formatTokens, formatUSD } from '../lib/format.js';
import { t, initLocale, applyLocale } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

// v1.5: 多語言初始化
initLocale().then(() => applyLocale(document));

async function refreshUsageInfo() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'USAGE_STATS' });
    if (resp?.ok) {
      const totalTok = (resp.totalInputTokens || 0) + (resp.totalOutputTokens || 0);
      $('usage-info').textContent =
        t('popup_cost_total', formatUSD(resp.totalCostUSD || 0), formatTokens(totalTok));
    } else {
      $('usage-info').textContent = t('popup_cost_fail');
    }
  } catch {
    $('usage-info').textContent = t('popup_cost_error');
  }
}

async function refreshCacheInfo() {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (resp?.ok) {
      $('cache-info').textContent =
        t('popup_cache_info', resp.count, formatBytes(resp.bytes));
    } else {
      $('cache-info').textContent = t('popup_cache_fail');
    }
  } catch {
    $('cache-info').textContent = t('popup_cache_error');
  }
}

async function refreshTranslateButton() {
  // 詢問 content script 目前是否已翻譯，動態切換按鈕標籤
  const btn = $('translate-btn');
  const editBtn = $('edit-btn');
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await browser.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if (resp?.translated) {
      btn.textContent = t('popup_show_original');
      btn.dataset.mode = 'restore';
      editBtn.hidden = false;
      editBtn.textContent = resp?.editing ? t('popup_end_edit') : t('popup_edit');
    } else {
      btn.textContent = t('popup_translate');
      btn.dataset.mode = 'translate';
      editBtn.hidden = true;
    }
  } catch {
    btn.textContent = t('popup_translate');
    btn.dataset.mode = 'translate';
    editBtn.hidden = true;
  }
}

async function refreshShortcutHint() {
  // v1.4.13: popup 按鈕觸發 TOGGLE_TRANSLATE 訊息，content.js 將其映射為 preset slot 2（Flash）。
  // 所以這裡讀 translate-preset-2 的當前鍵位顯示。
  // （v1.4.12 前舊名 toggle-translate 已移除，改讀新名稱避免永遠顯示「未設定」）
  const el = $('shortcut-hint');
  if (!el) return;
  try {
    const cmds = await browser.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'translate-preset-2');
    const shortcut = cmd?.shortcut?.trim();
    if (shortcut) {
      el.textContent = t('popup_shortcut_hint', shortcut);
    } else {
      el.textContent = t('popup_shortcut_unset');
    }
  } catch {
    // browser.commands 不可用時靜默留白，不要顯示錯誤
    el.textContent = '';
  }
}

async function init() {
  // 從 manifest 動態讀版本號，避免日後忘記同步
  const manifest = browser.runtime.getManifest();
  $('version').textContent = 'v' + manifest.version;

  refreshShortcutHint();

  // v0.62 起：autoTranslate 仍走 sync（跨裝置同步），apiKey 改走 local（不同步）
  const { autoTranslate = false } = await browser.storage.sync.get(['autoTranslate']);
  const { apiKey = '' } = await browser.storage.local.get(['apiKey']);
  $('auto').checked = autoTranslate;

  // v0.73: 術語表一致化開關（讀 browser.storage.sync 的 glossary.enabled）
  try {
    const { glossary: gc } = await browser.storage.sync.get('glossary');
    $('glossary-toggle').checked = gc?.enabled ?? false;
  } catch { /* 讀取失敗時維持預設 checked */ }

  // v1.2.12: YouTube 字幕 toggle — 只在 YouTube 影片頁才顯示
  // v1.4.13: toggle 語意從「當前 active 狀態」改為「ytSubtitle.autoTranslate 設定值」，
  // 讓使用者一打開 popup 就看到預設 ON（DEFAULT_SETTINGS.ytSubtitle.autoTranslate=true），
  // 不再因為 content script 尚未啟動 active 就顯示 off 造成「預設沒開」的錯覺。
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    if (url.includes('youtube.com/watch')) {
      $('yt-subtitle-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      // 沒設定過視為 true（與 DEFAULT_SETTINGS.ytSubtitle.autoTranslate 對齊）
      $('yt-subtitle-toggle').checked = ytSubtitle.autoTranslate !== false;
    }
  } catch { /* 非 YouTube 頁面，保持 hidden */ }

  if (!apiKey) {
    statusEl.textContent = t('popup_status_no_api_key');
    statusEl.style.color = '#ff3b30';
  }

  refreshCacheInfo();
  refreshUsageInfo();
  refreshTranslateButton();
}

$('translate-btn').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const mode = $('translate-btn').dataset.mode;
  statusEl.textContent = mode === 'restore' ? t('popup_status_restoring') : t('popup_status_translating');
  try {
    // TOGGLE_TRANSLATE 在 content.js 是 toggle 行為：已翻譯 → 還原，反之翻譯
    await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    window.close();
  } catch (err) {
    statusEl.textContent = t('popup_status_no_content_script');
    statusEl.style.color = '#ff3b30';
  }
});

$('auto').addEventListener('change', async (e) => {
  await browser.storage.sync.set({ autoTranslate: e.target.checked });
});

// v0.73: 術語表一致化開關 — 寫入 browser.storage.sync 的 glossary.enabled
$('glossary-toggle').addEventListener('change', async (e) => {
  try {
    const { glossary: gc = {} } = await browser.storage.sync.get('glossary');
    gc.enabled = e.target.checked;
    await browser.storage.sync.set({ glossary: gc });
  } catch (err) {
    console.error('[Shinkansen] popup: failed to save glossary toggle', err);
  }
});

// v1.2.12: YouTube 字幕翻譯開關
// v1.4.13: toggle 變更時同時更新設定（autoTranslate）+ 通知 content script 立即啟/停
// v1.4.21: popup 顯示（讀 ytSubtitle.autoTranslate 設定值）與點擊動作對齊到同一語意——
// 舊版點擊送 TOGGLE_SUBTITLE，content.js 走「翻面」YT.active；當設定值與 YT.active
// desync（例如使用者手動按 Alt+S 啟動過、或處於 init 800ms 延遲窗口）時，點擊會反向作用。
// 改為送 SET_SUBTITLE { enabled }，content.js 依 enabled 直接決定啟/停/no-op。
$('yt-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    // 1. 更新設定（影響下次進 YouTube 頁是否自動啟動字幕翻譯）
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({ ytSubtitle: { ...ytSubtitle, autoTranslate: enabled } });
    // 2. 通知當前分頁把運行狀態調成 enabled
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await browser.tabs.sendMessage(tab.id, {
        type: 'SET_SUBTITLE',
        payload: { enabled },
      }).catch(() => {});
    }
  } catch (err) {
    statusEl.textContent = t('popup_status_yt_toggle_fail');
    statusEl.style.color = '#ff3b30';
  }
});

$('options-btn').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
});

// v1.0.3: 編輯譯文按鈕
$('edit-btn').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_EDIT_MODE' });
    if (resp?.ok) {
      $('edit-btn').textContent = resp.editing ? t('popup_end_edit') : t('popup_edit');
      statusEl.textContent = resp.editing
        ? t('popup_status_edit_mode', resp.elements)
        : t('popup_status_edit_end');
      statusEl.style.color = resp.editing ? '#0071e3' : '#86868b';
    }
  } catch {
    statusEl.textContent = t('popup_status_edit_fail');
    statusEl.style.color = '#ff3b30';
  }
});

$('clear-cache-btn').addEventListener('click', async () => {
  if (!confirm(t('popup_confirm_clear_cache'))) return;
  const resp = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  if (resp?.ok) {
    statusEl.textContent = t('popup_status_cache_cleared', resp.removed);
    statusEl.style.color = '#34c759';
    refreshCacheInfo();
  } else {
    statusEl.textContent = t('popup_status_cache_clear_fail', resp?.error || t('popup_unknown_error'));
    statusEl.style.color = '#ff3b30';
  }
});

init();
