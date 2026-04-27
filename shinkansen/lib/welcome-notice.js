// welcome-notice.js — CWS 自動更新後的「歡迎升級」提示寫入邏輯（v1.6.5 起）
//
// 為什麼有這個檔：把 background.js 的 onInstalled handler 內判斷邏輯抽出來方便 unit 測試。
// 寫入後由 popup banner（永久顯示直到「知道了」）+ 翻譯成功 toast（每日節流一次）兩處讀取展示。

import { browser } from './compat.js';
import { isWorthNotifying } from './update-check.js';

const STORAGE_KEY = 'welcomeNotice';

/**
 * 若這次升級值得提示（major / minor 升），寫 storage.local.welcomeNotice。
 * 對齊 update-check 的 isWorthNotifying 規則：1.6 → 1.7 寫入、1.6.4 → 1.6.5 (patch) 不寫，
 * 避免 CWS 高頻 patch 自動更新打擾使用者。
 *
 * @param {Object} info onInstalled details
 * @param {string} info.reason 'install' | 'update' | 'browser_update' | 'shared_module_update'
 * @param {string} info.previousVersion onInstalled 帶來的上一版號（reason='update' 才有）
 * @param {string} info.currentVersion 通常是 chrome.runtime.getManifest().version
 * @returns {Promise<boolean>} true = 有寫入；false = 跳過（不是 update / 沒 prev / patch 級）
 */
export async function maybeWriteWelcomeNotice({ reason, previousVersion, currentVersion }) {
  if (reason !== 'update') return false;
  if (!previousVersion) return false;
  if (!isWorthNotifying(currentVersion, previousVersion)) return false;

  await browser.storage.local.set({
    [STORAGE_KEY]: {
      version: currentVersion,
      fromVersion: previousVersion,
      dismissed: false,
      lastNoticeShownDate: null,
    },
  });
  return true;
}

/**
 * 判斷 popup 是否該顯示 welcome banner,並標示是否該清除過期殘留。
 * v1.6.23:加殘留清除邏輯 — 若 welcomeNotice.version 跟當前 manifest 不同 minor 系列,
 * 代表使用者一直沒按「知道了」拖了多版,該筆已過期,應從 storage 移除避免日後再誤顯示。
 *
 * @param {Object|null|undefined} welcomeNotice storage.local.welcomeNotice 內容
 * @param {string} currentVersion 當前 manifest version
 * @returns {{ show: boolean, removeStale: boolean }}
 *   - show: true → popup 該顯示紅點 + welcome banner
 *   - removeStale: true → 該從 storage 移除 welcomeNotice(過期殘留)
 */
export function shouldShowWelcomeNotice(welcomeNotice, currentVersion) {
  if (!welcomeNotice || !welcomeNotice.version) {
    return { show: false, removeStale: false };
  }
  const noticeParts = String(welcomeNotice.version).split('.').map(Number);
  const currentParts = String(currentVersion).split('.').map(Number);
  const sameMinor = noticeParts[0] === currentParts[0] && noticeParts[1] === currentParts[1];
  if (!sameMinor) {
    return { show: false, removeStale: true };
  }
  return { show: welcomeNotice.dismissed !== true, removeStale: false };
}
