// popup.js — 工具列面板邏輯

import { browser } from '../lib/compat.js';
import { formatBytes, formatTokens, formatUSD } from '../lib/format.js';
import { t, initLocale, applyLocale } from '../lib/i18n.js';
// Update notification imports disabled — user doesn't want update notification
// import { RELEASE_HIGHLIGHTS } from '../lib/release-highlights.js';
// import { shouldShowWelcomeNotice } from '../lib/welcome-notice.js';
// import { isWorthNotifying } from '../lib/update-check.js';
import { pickPopupSlot, presetsRequireGemini } from '../lib/storage.js';

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
  // 所以這裡讀「主要預設」的當前鍵位顯示。
  // v1.8.19: 主要預設 command id 改為 translate-preset-0(字典序保證 chrome://extensions/shortcuts 顯示在最上)
  const el = $('shortcut-hint');
  if (!el) return;
  try {
    const cmds = await browser.commands.getAll();
    const cmd = cmds.find((c) => c.name === 'translate-preset-0');
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

// v1.6.5/v1.6.3: welcome banner and update banner event handlers removed
// (user doesn't want update notification)

async function init() {
  // 從 manifest 動態讀版本號，避免日後忘記同步
  const manifest = browser.runtime.getManifest();
  $('version').textContent = 'v' + manifest.version;

  refreshShortcutHint();

  // v1.6.5/v1.6.1: welcome banner and update banner logic removed
  // (user doesn't want update notification)

  // v0.62 起：autoTranslate 仍走 sync（跨裝置同步），apiKey 改走 local（不同步）
  const { autoTranslate = false, displayMode = 'single', translatePresets = [] } = await browser.storage.sync.get(['autoTranslate', 'displayMode', 'translatePresets']);
  const { apiKey = '' } = await browser.storage.local.get(['apiKey']);
  $('auto').checked = autoTranslate;

  // v1.5.0: 顯示模式 toggle 初始狀態
  setDisplayModeButtons(displayMode === 'dual' ? 'dual' : 'single');

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
    // commit 5a':Drive 影片 viewer toggle 共用 ytSubtitle.autoTranslate
    // (user 不需要為 Drive 多做設定,跟 YouTube 字幕用同一個開關)
    if (/^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('drive-subtitle-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('drive-subtitle-toggle').checked = ytSubtitle.autoTranslate !== false;
    }
    // commit 5c:雙語對照 toggle(YouTube + Drive 影片頁都顯示,共用 ytSubtitle.bilingualMode)
    if (url.includes('youtube.com/watch') || /^https:\/\/drive\.google\.com\/file\//.test(url)) {
      $('bilingual-row').hidden = false;
      const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
      $('bilingual-toggle').checked = ytSubtitle.bilingualMode === true;
    }
  } catch { /* 非影片頁面,保持 hidden */ }

  // v1.8.12: 只有當 translatePresets 中有任一 slot 用 Gemini engine 時,才提醒未設 API Key。
  // 使用者若三組 preset 都改成 Google MT / 自訂模型 / Bing,popup 不再嘮叨他沒填 Gemini Key。
  if (!apiKey && presetsRequireGemini(translatePresets)) {
    statusEl.textContent = t('popup_status_no_api_key');
    statusEl.style.color = '#ff3b30';
  }

  refreshCacheInfo();
  refreshUsageInfo();
  refreshTranslateButton();
}

$('translate-btn').addEventListener('click', async () => {
  // v1.8.20: 雙擊防護——點擊期間 disable 按鈕,避免快速連按兩次導致第二次被
  // content.js 解讀為 abort/restore(toggle 行為)
  const btn = $('translate-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { btn.disabled = false; return; }
  const mode = btn.dataset.mode;
  statusEl.textContent = mode === 'restore' ? t('popup_status_restoring') : t('popup_status_translating');
  try {
    // v1.6.6: 讀 settings.popupButtonSlot 決定按鈕對應的 preset slot（預設 2 = Flash）
    // content.js handleTranslatePreset 自帶 toggle 行為（已翻譯 → 還原 / 翻譯中 → abort / 閒置 → 翻譯）
    const { popupButtonSlot } = await browser.storage.sync.get('popupButtonSlot');
    const slot = pickPopupSlot(popupButtonSlot);
    await browser.tabs.sendMessage(tab.id, { type: 'TRANSLATE_PRESET', payload: { slot } });
    window.close();
  } catch (err) {
    statusEl.textContent = t('popup_status_no_content_script');
    statusEl.style.color = '#ff3b30';
    btn.disabled = false;
  }
});

$('auto').addEventListener('change', async (e) => {
  await browser.storage.sync.set({ autoTranslate: e.target.checked });
});

// v1.5.0: 顯示模式切換 toggle
function setDisplayModeButtons(mode) {
  $('mode-single').setAttribute('aria-checked', mode === 'single' ? 'true' : 'false');
  $('mode-dual').setAttribute('aria-checked', mode === 'dual' ? 'true' : 'false');
}

async function changeDisplayMode(mode) {
  setDisplayModeButtons(mode);
  await browser.storage.sync.set({ displayMode: mode });
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await browser.tabs.sendMessage(tab.id, { type: 'MODE_CHANGED', mode }).catch(() => {});
    }
  } catch { /* 非可注入頁面，安靜忽略 */ }
}

$('mode-single').addEventListener('click', () => changeDisplayMode('single'));
$('mode-dual').addEventListener('click',   () => changeDisplayMode('dual'));

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
// v1.6.23:改為「Option → Popup」單向 sync。popup toggle 變動只通知當前 tab 即時啟 / 停,
// **不寫** storage 避免反向覆蓋 Option 的全域設定。Option 設定影響「下次進 YouTube 頁的預設行為」,
// popup 的勾選只控制「當前 tab」即時狀態。
$('yt-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
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

// commit 5a':Drive toggle 共用 ytSubtitle.autoTranslate(寫 storage,跟 YouTube popup
// 的 SET_SUBTITLE message 設計不同——因 Drive 沒 SPA 切影片,單純 storage 即時 sync 即可。
// content-drive.js listen onChanged 即時生效)。
$('drive-subtitle-toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, autoTranslate: enabled },
    });
  } catch (err) {
    statusEl.textContent = t('popup_status_drive_toggle_fail');
    statusEl.style.color = '#ff3b30';
  }
});

// commit 5c:雙語 toggle change handler(寫 ytSubtitle.bilingualMode 到 storage,YouTube
// 跟 Drive 兩條路徑各自的 onChanged listener 自動反應;切換生效需 reload 影片頁)
$('bilingual-toggle').addEventListener('change', async (e) => {
  const bilingual = e.target.checked;
  try {
    const { ytSubtitle = {} } = await browser.storage.sync.get('ytSubtitle');
    await browser.storage.sync.set({
      ytSubtitle: { ...ytSubtitle, bilingualMode: bilingual },
    });
  } catch (err) {
    statusEl.textContent = t('popup_status_bilingual_toggle_fail');
    statusEl.style.color = '#ff3b30';
  }
});

$('options-btn').addEventListener('click', async() => {
  try{
    await browser.runtime.openOptionsPage();
  } catch (e) {
    // 如果 openOptionsPage 不支援（例如 Arc），退而求其次直接開啟 options.html 頁面
    const url = browser.runtime.getURL('options/options.html');
    await browser.tabs.create({ url });
  }
});

// v1.6.23:popup 開著時 reactive sync ytSubtitle.autoTranslate(設定頁同步寫 storage 後立即反映)
// popup 通常 click 外面就關閉,但 detached popup window 或極短時間視窗下這條 listener 確保一致
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes.ytSubtitle) return;
  const newVal = changes.ytSubtitle.newValue || {};
  // 同一個 ytSubtitle.autoTranslate 設定同步兩個 popup toggle(YouTube + Drive 共用)
  const enabled = newVal.autoTranslate !== false;
  $('yt-subtitle-toggle').checked = enabled;
  $('drive-subtitle-toggle').checked = enabled;
  // commit 5c:bilingualMode 同步
  $('bilingual-toggle').checked = newVal.bilingualMode === true;
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
