// content-youtube-main-loader.js — Firefox MAIN world 注入器（開發參考用）
// 實際構建版本由 scripts/build.js 自動生成，會將 content-youtube-main.js
// 的完整內容內嵌為 textContent，確保同步執行（避免外部 src 載入的時序競爭）。
// Chrome 不使用此檔案（Chrome manifest 直接宣告 world: "MAIN"）。

(function () {
  const s = document.createElement('script');
  s.src = (globalThis.browser ?? globalThis.chrome).runtime.getURL('content-youtube-main.js');
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
})();
