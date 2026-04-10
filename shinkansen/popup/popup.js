// popup.js — 工具列面板邏輯

import { formatBytes, formatTokens, formatUSD } from '../lib/format.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

async function refreshUsageInfo() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'USAGE_STATS' });
    if (resp?.ok) {
      const totalTok = (resp.totalInputTokens || 0) + (resp.totalOutputTokens || 0);
      $('usage-info').textContent =
        `累計：${formatUSD(resp.totalCostUSD || 0)} / ${formatTokens(totalTok)} tokens`;
    } else {
      $('usage-info').textContent = '累計：讀取失敗';
    }
  } catch {
    $('usage-info').textContent = '累計：無法讀取';
  }
}

async function refreshCacheInfo() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CACHE_STATS' });
    if (resp?.ok) {
      $('cache-info').textContent =
        `快取：${resp.count} 段 / ${formatBytes(resp.bytes)}`;
    } else {
      $('cache-info').textContent = '快取：讀取失敗';
    }
  } catch {
    $('cache-info').textContent = '快取：無法讀取';
  }
}

async function refreshTranslateButton() {
  // 詢問 content script 目前是否已翻譯，動態切換按鈕標籤
  const btn = $('translate-btn');
  const editBtn = $('edit-btn');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if (resp?.translated) {
      btn.textContent = '顯示原文';
      btn.dataset.mode = 'restore';
      // v1.0.3: 已翻譯時顯示編輯按鈕
      editBtn.hidden = false;
      editBtn.textContent = resp?.editing ? '結束編輯' : '編輯譯文';
    } else {
      btn.textContent = '翻譯本頁';
      btn.dataset.mode = 'translate';
      editBtn.hidden = true;
    }
  } catch {
    // 頁面尚未注入 content script (例如 chrome:// 頁、剛 reload extension)
    // 維持預設「翻譯本頁」即可
    btn.textContent = '翻譯本頁';
    btn.dataset.mode = 'translate';
    editBtn.hidden = true;
  }
}

async function refreshShortcutHint() {
  // 動態讀使用者在 chrome://extensions/shortcuts 設定的實際快捷鍵
  // 避免寫死「Option + S」造成 popup 與實際設定不一致
  const el = $('shortcut-hint');
  if (!el) return;
  try {
    const cmds = await chrome.commands.getAll();
    const toggle = cmds.find((c) => c.name === 'toggle-translate');
    const shortcut = toggle?.shortcut?.trim();
    if (shortcut) {
      el.textContent = `${shortcut} 快速切換`;
    } else {
      // 使用者可能在 shortcuts 設定頁清掉了快捷鍵
      el.textContent = '未設定快捷鍵';
    }
  } catch {
    // chrome.commands 不可用時靜默留白，不要顯示錯誤
    el.textContent = '';
  }
}

async function init() {
  // 從 manifest 動態讀版本號，避免日後忘記同步
  const manifest = chrome.runtime.getManifest();
  $('version').textContent = 'v' + manifest.version;

  refreshShortcutHint();

  // v0.62 起：autoTranslate 仍走 sync（跨裝置同步），apiKey 改走 local（不同步）
  const { autoTranslate = false } = await chrome.storage.sync.get(['autoTranslate']);
  const { apiKey = '' } = await chrome.storage.local.get(['apiKey']);
  $('auto').checked = autoTranslate;

  // v0.73: 術語表一致化開關（讀 chrome.storage.sync 的 glossary.enabled）
  try {
    const { glossary: gc } = await chrome.storage.sync.get('glossary');
    $('glossary-toggle').checked = gc?.enabled ?? false;
  } catch { /* 讀取失敗時維持預設 checked */ }

  if (!apiKey) {
    statusEl.textContent = '狀態：⚠ 尚未設定 API Key';
    statusEl.style.color = '#ff3b30';
  }

  refreshCacheInfo();
  refreshUsageInfo();
  refreshTranslateButton();
}

$('translate-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const mode = $('translate-btn').dataset.mode;
  statusEl.textContent = mode === 'restore' ? '狀態：正在還原原文…' : '狀態：正在翻譯…';
  try {
    // TOGGLE_TRANSLATE 在 content.js 是 toggle 行為：已翻譯 → 還原，反之翻譯
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_TRANSLATE' });
    window.close();
  } catch (err) {
    statusEl.textContent = '狀態：無法在此頁面執行，請重新整理後再試';
    statusEl.style.color = '#ff3b30';
  }
});

$('auto').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ autoTranslate: e.target.checked });
});

// v0.73: 術語表一致化開關 — 寫入 chrome.storage.sync 的 glossary.enabled
$('glossary-toggle').addEventListener('change', async (e) => {
  try {
    const { glossary: gc = {} } = await chrome.storage.sync.get('glossary');
    gc.enabled = e.target.checked;
    await chrome.storage.sync.set({ glossary: gc });
  } catch (err) {
    console.error('[Shinkansen] popup: failed to save glossary toggle', err);
  }
});

$('options-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// v1.0.3: 編輯譯文按鈕
$('edit-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_EDIT_MODE' });
    if (resp?.ok) {
      $('edit-btn').textContent = resp.editing ? '結束編輯' : '編輯譯文';
      statusEl.textContent = resp.editing
        ? `狀態：編輯模式（${resp.elements} 個區塊可編輯）`
        : '狀態：已結束編輯';
      statusEl.style.color = resp.editing ? '#0071e3' : '#86868b';
    }
  } catch {
    statusEl.textContent = '狀態：無法切換編輯模式';
    statusEl.style.color = '#ff3b30';
  }
});

$('clear-cache-btn').addEventListener('click', async () => {
  if (!confirm('確定要清除所有翻譯快取嗎？清除後下次翻譯會重新呼叫 Gemini。')) return;
  const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  if (resp?.ok) {
    statusEl.textContent = `狀態：已清除 ${resp.removed} 筆快取`;
    statusEl.style.color = '#34c759';
    refreshCacheInfo();
  } else {
    statusEl.textContent = '狀態：清除失敗 — ' + (resp?.error || '未知錯誤');
    statusEl.style.color = '#ff3b30';
  }
});

init();
