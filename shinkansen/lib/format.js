// format.js — 共用格式化工具函式
// 由 popup.js 與 options.js 共用，消除重複程式碼。

/**
 * 格式化 bytes 為人類可讀的 B / KB / MB 字串。
 */
export function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 格式化 token 數為 K / M 字串。
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

/**
 * 格式化美金金額。
 */
export function formatUSD(n) {
  if (!n) return '$0';
  if (n < 0.01) return '$' + n.toFixed(4);
  if (n < 1) return '$' + n.toFixed(3);
  return '$' + n.toFixed(2);
}
