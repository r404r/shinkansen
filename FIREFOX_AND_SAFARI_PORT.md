# Firefox / Safari 移植 Checklist

> 本文件記錄 Shinkansen 從 Chrome 移植到 Firefox / Safari 需要做的事。
> Code 端的 cross-browser prep 大部分已完成（v1.3.16 polyfill + v1.5.4 四項小修）。
> 剩下的工程主要在「發行管道」（Firefox AMO / Safari Mac App Store）。
>
> 真要 port 時直接照本文件 Phase 1–4 順序做。

---

## 已完成的 code prep（截至 v1.5.4）

| 版本 | 改動 | 說明 |
|---|---|---|
| v1.3.16 | `globalThis.browser = globalThis.browser ?? globalThis.chrome;` polyfill | content-ns.js 開頭、popup / options 透過 `lib/compat.js` import |
| v1.3.16 | `lib/compat.js` Proxy fallback | popup / options ES module import 走的相容層 |
| v1.5.4 | 加 `browser_specific_settings.gecko.id` | manifest.json 補 Firefox 必填欄位 |
| v1.5.4 | `_stickyStorage` helper | `storage.session` 在 Firefox <129 / Safari <16.4 不存在，自動 fallback `storage.local`。Chrome 維持 session 行為 0 變化 |
| v1.5.4 | Debug Bridge `callback` → `Promise` | Firefox / Safari 全版本只認 Promise；Chrome 兩種寫法走同一條 native path 0 影響 |
| v1.5.4 | `options.js` 平台偵測用 `runtime.getURL('')` prefix | 精確區分 `chrome-extension://` / `moz-extension://` / `safari-web-extension://` |
| v1.5.4 | `background.js:146` `setBadgeTextColor` 已用 if 守衛 | Firefox <133 沒此 API，守衛防 undefined |

---

## Phase 1：剩餘 code prep（總工程量 < 1 小時）

### 必做（影響功能 / UX）

- [ ] **manifest 雙分支**——`background.service_worker + type:module` 在 Firefox 主流穩定版 / 115 ESR 不支援。需要 `manifest.firefox.json` + build script 切換為 `"scripts": [...]` 結構。**這條是 Firefox port 的最大工程量**（半天起）。Chrome 端維持 service_worker 不變；Safari 端 16.4+ 接受 `service_worker`，可直接用 Chrome manifest。
  - 設計：`tools/build-manifest.js` 接受 `--target chrome|firefox|safari`，產出對應 `manifest.json`，`release.sh` 依 target 切換
  - 風險：兩份 manifest 容易漂移，需要 spec 鎖兩份必同步
- [ ] **`shinkansen/background.js` 改用非-module 結構**——若走 Firefox `scripts` 路線，`import { translateBatch } from './lib/gemini.js'` 等 ES module 寫法不能用。改法：(a) 用 `importScripts(...)` 風格、(b) 用 build-time bundler（esbuild / rollup）將 background.js 整包打成單檔
  - 影響 `shinkansen/lib/gemini.js`、`google-translate.js`、`storage.js`、`usage-db.js`、`compat.js` 等所有 background-imported module
- [ ] **`background.js:186, 202` storage.session 殘餘 stale 資料**——Firefox <129 走 storage.local fallback 後，`stickyTabs` 會 disk-persist。瀏覽器重啟 tabId 重排，舊資料無意義。加 `browser.runtime.onStartup` listener 清空 storage.local 裡的 stickyTabs 鍵
  - Chrome 不會走到（storage.session 存在），只有 Firefox <129 / Safari <16.4 需要

### UI 文案中性化

- [ ] **`shinkansen/options/options.html:46`** — anchor text 寫死 `chrome://extensions/shortcuts`，Firefox / Safari 使用者看到會困惑。改為「**快捷鍵設定**」或「自訂快捷鍵」
- [ ] **`shinkansen/privacy-policy.html:106, 111, 116`** — 三處提到 `chrome.storage.local` / `chrome.storage.sync` / 「Chrome 的內建同步機制」。改為 `browser.storage.local` / `browser.storage.sync` / 「瀏覽器內建同步機制」
- [ ] **`shinkansen/background.js:790, 798`、`shinkansen/popup/popup.js:58, 79`** — 註解提到 `chrome://`。改為更中性敘述（純註解、不影響功能，但對未來閱讀 code 一致性有益）

### 真機 API 差異驗證

- [ ] **Firefox `<all_urls>` host_permissions UX**：Firefox 對 `<all_urls>` 預設給予，但未來 AMO 審查可能要求改成 `optional_host_permissions`（使用者主動授權每站）。手動測試
- [ ] **Safari `<all_urls>` UX**：Safari **預設不給予**——使用者要在 Safari 設定主動授權每站。需要在 README / 上架文案說明
- [ ] **Firefox / Safari `commands` 快捷鍵**：Alt+A/S/D 在 Mac Safari 顯示為「Option+A/S/D」（系統名詞），且部分 Option+key 組合被 macOS 系統保留。手動測試三個 preset 是否都能觸發
- [ ] **Firefox `--headless=new` 不存在**：`test/fixtures/extension.js` 目前用 Chrome 原生 new headless。Firefox webdriver 用 `headless: true` 即可——測試 fixture 要改成 `target === 'chromium' ? '--headless=new' : '...'`
- [ ] **Safari / Firefox CDP 不存在**：`test/regression/helpers/run-inject.js` 走 CDP 拿 isolated world contextId。Firefox webdriver 跟 Safari WebKit 不支援 CDP。對 Firefox/Safari port 後的 spec 跑法要重新設計（用 Playwright 的 `page.evaluate()` + script tag injection，或跳過部分 spec）

---

## Phase 2：Firefox 真機驗證 checklist

依序在 Firefox Developer Edition（最新版）驗：

- [ ] 載入 about:debugging → 「載入暫時附加元件」→ 選 manifest.firefox.json → 確認載入成功
- [ ] popup 開啟正常顯示
- [ ] options 開啟正常、設定可寫入 / 讀取
- [ ] 在 Wikipedia / Medium / Stratechery / Gmail（會員前提下）測單語翻譯
- [ ] 在 BBC / macstories.net 測雙語對照（驗證 v1.5.0–v1.5.3 修法都能跑）
- [ ] Alt+A/S/D 快捷鍵能觸發
- [ ] sticky cross-tab 跨分頁延續
- [ ] YouTube 字幕翻譯（核心 monkey-patch 機制要驗）
- [ ] iframe gate（v1.5.2）：BBC Flourish 嵌入圖表確認進入 iframe 翻譯

---

## Phase 3：Firefox AMO 上架

- [ ] 註冊 [AMO Developer Hub](https://addons.mozilla.org/developers/) 帳號（免費）
- [ ] 上傳第一次 `.xpi`（其實就是 zip 改副檔名）
- [ ] 等審查（首次 1–4 週、後續快）
- [ ] 審過後拿到 listing URL `https://addons.mozilla.org/firefox/addon/shinkansen/`
- [ ] 更新 `README.md` + `docs/index.html` 加 Firefox 安裝連結
- [ ] 設定 GitHub Actions `web-ext sign` 自動化（拿 AMO API key + secret）——可選

---

## Phase 4：Safari macOS / iOS 上架

> Safari port **必須包進 macOS / iOS 原生 App**，不像 Chrome / Firefox 直接跑 web extension package。

### 前置

- [ ] **Apple Developer Program 註冊**——年費 $99 USD
- [ ] macOS + Xcode 最新版安裝

### Build

- [ ] 用 `xcrun safari-web-extension-converter shinkansen/` 一鍵生成 Xcode project
- [ ] 開 Xcode，把 generated project 設定 macOS 版 target（iOS 另一個 target，可後續加）
- [ ] 簽章設定（Team / Bundle Identifier / signing certificate）
- [ ] 在 Xcode 跑 macOS Safari 直接測試（不上架）

### macOS App Store 上架

- [ ] 在 App Store Connect 建立新 App entry
- [ ] Archive build 上傳 → 提交審查
- [ ] 審查時間 1–7 天
- [ ] 審過後 Mac App Store URL 可用

### iOS Safari（可選，多寫一個 iOS target）

- [ ] iOS target screen 適配（popup 寬度等 UI 在 iPhone Safari 行為不同）
- [ ] iOS App Store 各別審查
- [ ] iOS 預設 host permissions 行為更嚴：使用者要在 Safari 設定 → 擴充功能 → Shinkansen → 啟用對所有網站

### 上架後

- [ ] 更新 `README.md` + `docs/index.html` 加 Mac App Store 連結
- [ ] iOS 版同上

---

## 維護期注意事項

當 codebase 已支援三平台時，每次 release 流程：

1. `release.sh` build chrome `manifest.json` → 上 Chrome Web Store
2. `release.sh --firefox` build firefox `manifest.json` → 上 AMO（手動 or `web-ext sign` 自動）
3. Safari：每版本要進 Xcode rebuild + 重新上 App Store（最費工）

長期看 Safari port 的「每版本維護成本」最高（必須開 Xcode），如果使用者量不大可考慮**只在重大版本 release Safari**、minor patch 直接跳過。

---

## 我目前不會做的事（避免過早工程）

- 寫雙 manifest build script（`tools/build-manifest.js`）——等真要 port 時做
- 改 `background.js` 為非-module 結構（影響太大、會踩 spec）
- AMO 帳號註冊 / Apple Developer Program 註冊（這是 Jimmy 個人事項）
- 改 README / Landing 加假連結（沒目的地不加）
- 真機驗證 Firefox / Safari（沒裝環境）

當 Jimmy 決定真要走 port 流程，由他選 Firefox 先還是 Safari 先，再依本文件對應 Phase 開工。
