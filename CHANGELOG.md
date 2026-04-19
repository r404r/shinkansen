# Shinkansen 變更記錄

> 完整版本歷史。SPEC.md §2.1 只保留功能摘要表，詳細說明均在此保存。
> 版本號規則：v1.0.0 起三段式；v0.13–v0.99 為兩段式歷史版本。

---

## v1.4.x

**v1.4.13** — 設定頁新增「翻譯快捷鍵」區塊（一般設定分頁內，取代原本只顯示「預設 Alt+S」說明的簡版）。三張 preset card 對應 `translatePresets[slot]`，每張可編輯：標籤（自由文字，最多 12 字）、翻譯引擎（Gemini / Google Translate）、Gemini 模型（engine=gemini 時顯示，三個預設模型 + 未來可擴充）。card 右上角顯示當前鍵位綁定（由 `chrome.commands.getAll()` 讀取，未設定時顯示紅色「未設定」提示）。engine 切換成 Google Translate 時自動隱藏模型欄（google MT 無 model 概念）。與 v1.4.12 的 `translatePresets` storage schema 完全相容，儲存時組成 `[{slot, engine, model, label}]` 寫回 `chrome.storage.sync.translatePresets`。影響檔案：`shinkansen/options/options.html`（新增 section + 三張 card）、`shinkansen/options/options.js`（`load()` 讀 preset 填 UI + `save()` 組陣列寫回 + `refreshPresetKeyBindings()` 讀 `browser.commands.getAll()` + engine change listener 切換 model row 可見性）、`shinkansen/options/options.css`（新增 `.preset-cards` grid layout + card 樣式）。使用者現在可在設定頁直接調整三組 preset 的 engine/model/label，不再需要手動編輯 `chrome.storage.sync.translatePresets`。同時修三個小問題：(1) `popup.js refreshShortcutHint` 仍在找舊 command name `toggle-translate`（v1.4.12 已改名 `translate-preset-*`），導致 popup 右下角永遠顯示「未設定快捷鍵」——改讀 `translate-preset-2`（對應 popup 按鈕映射的 slot 2 Flash）的當前鍵位；(2) 翻譯中的 loading toast 加上 preset label 前綴（例如 `[Flash Lite] 翻譯中… 5 / 20`），使用者能一眼看出目前跑的是哪組 preset，透過 `options.label` 從 `handleTranslatePreset` 傳到 `translatePage` / `translatePageGoogle`；(3) popup 的 YouTube 字幕 toggle 原本顯示「當前 active 狀態」（`SK.YT.active`），使用者剛進 YouTube 頁 active 還沒就位就會顯示 off，造成「預設沒打開」錯覺——改為顯示 `ytSubtitle.autoTranslate` 設定值（default true），同時 toggle change 時寫入設定 + 通知 content script 立即啟/停，`content.js` 初始化段讀 `ytSubtitle.autoTranslate !== false` fallback 對齊預設值（從未設過視為 true），新使用者一打開 popup 就看到 ON。

**v1.4.12** — 新增三組可自訂翻譯預設快速鍵：`Alt+A` / `Alt+S` / `Alt+D`（預設對應 Gemini Flash Lite / Flash / Google Translate），讓使用者依網頁內容重要性選擇不同引擎與模型。每組 preset 存 `{ slot, engine, model, label }`，engine='gemini' 時 model 覆蓋 `geminiConfig.model`（其餘 prompt/temperature/glossary 沿用全域），engine='google' 時走 Google Translate 路徑。統一取消行為：已翻譯狀態下按任一 preset 快速鍵皆 `restorePage`（不區分按哪個）；翻譯中按任一鍵皆 abort。實作範圍：`manifest.json` commands 重寫（移除 `toggle-translate` / `toggle-google-translate`，改為 `translate-preset-1/2/3`）；`lib/storage.js` `DEFAULT_SETTINGS` 加 `translatePresets` 陣列；`background.js` onCommand 派送 `TRANSLATE_PRESET {slot}`，`TRANSLATE_BATCH` 接受 `payload.modelOverride`，`handleTranslate` 加 `cacheTag` 參數避免 preset 的 model override 被誤判為字幕模式污染快取，並把 model 字串納入 cache key 後綴（`_m<model>`），確保同段文字在不同 preset/model 之間不共用快取（例如 Flash Lite 翻過後按 Alt+S 用 Flash 會重新打 API）；`content.js` 新增 `handleTranslatePreset(slot)` 統一入口（取消/abort/啟動三分支），`SK.translatePage(options)` / `SK.translatePageGoogle(gtOptions)` 接受 `{ modelOverride, slot }` 並將 `modelOverride` 透過 `SK.translateUnits` 傳至 `TRANSLATE_BATCH` payload；v1.4.11 sticky schema 改動：`stickyTabs` Map value 從 `engine` 字串改存 `slot` number，content 初始化時收到 `STICKY_QUERY` 回的 slot 透過 `handleTranslatePreset` 啟動同 preset（忠實繼承使用者當時按的引擎+模型組合）；`content-ns.js` STATE 加 `stickySlot` 供 `content-spa.js` SPA 續翻讀取同 slot；`popup.js` 的 `TOGGLE_TRANSLATE` 訊息保留並在 content script 內部映射為 slot 1 行為（零改動相容）。Options 頁 UI（engine/model/label 下拉編輯）延到 v1.4.13；v1.4.12 使用者要改 preset 可暫時改 `chrome.storage.sync.translatePresets` 或等下版 UI。同時調整：reload 同 tab 或瀏覽器前進後退時視為使用者主動放棄翻譯（`performance.getEntriesByType('navigation')[0].type === 'reload' / 'back_forward'`），content script 初始化時主動送 `STICKY_CLEAR` 不再繼承，避免 reload 後還在自動翻。另外新增 `lib/model-pricing.js` 統一 Gemini 模型→定價表（Flash Lite $0.10/$0.30、Flash $0.50/$3.00、Pro $2/$12），`handleTranslate` 發現 `modelOverride` 時會從此表查對應 pricing 覆蓋 `settings.pricing`，確保 toast 與 usage log 的費用跟 preset 的 model 走（以前切 Flash Lite 仍用 Flash 價格算，會多算 5 倍）；優先順序為 `pricingOverride`（YouTube 字幕獨立計價）> `modelOverride` 查表 > `settings.pricing`（使用者自訂）。`options.js` 同步 import 新 lib，避免兩處定價表不同步。同時反映協作流程轉變（Jimmy 2026-04-19 決定）：**主要開發環境從 Cowork 翻轉為 Claude Code**，Cowork 降為輔助角色僅用於 `mcp__Claude_in_Chrome__*` 實地看 DOM 的 debug。`CLAUDE.md` 與 `測試流程說明.md` 已同步改寫（這兩檔在 `.gitignore` 內不進版控，變更僅存於本機）。

**v1.4.11** — 新增跨 tab sticky 翻譯：使用者按 Option+S（或 Option+G）翻譯頁面後，從此 tab 點連結開新分頁（含 Cmd+Click / target="_blank" / window.open），新分頁自動翻譯並同樣進入 sticky 狀態；新分頁再開新分頁也繼續。行為以 `chrome.tabs.openerTabId` 鏈做樹狀傳遞——手動打網址、從 bookmark 開、或完全無 opener 的新分頁不繼承。每個 tab 的 sticky 獨立，按一次 Option+S（觸發 `restorePage`）只清當前 tab，不影響樹中其他 tab。實作：`background.js` 新增 `stickyTabs` Map + `chrome.storage.session` 持久化 + `chrome.tabs.onCreated` 繼承 / `onRemoved` 清理 + 三個訊息 `STICKY_QUERY` / `STICKY_SET` / `STICKY_CLEAR`；`content.js` translatePage/translatePageGoogle 成功後送 `STICKY_SET`（engine 依路徑），restorePage 送 `STICKY_CLEAR`，content script 初始化時若 `STICKY_QUERY` 回 `shouldTranslate=true` 自動觸發對應 engine。engine 區分讓子 tab 繼承相同翻譯引擎（Gemini / Google MT）。

**v1.4.10** — 修正 VBulletin / 論壇頁面翻譯後貼文標題與正文之間的 `<hr>` 分隔線消失的問題。根因：`<td>` 包含 `<div class="smallfont">（標題）`、`<hr>`、`<div id="post_message">（內文）`，三者並列；`<td>` 沒有 P/H1/LI 等 block 後代，walker 直接把整個 `<td>` 當一個段落；`serializeWithPlaceholders` 序列化時 `<hr>` 既不是 `isPreservableInline` 也不是 `isAtomicPreserve`，直接被遞迴走過（無輸出），clean slate 注入後自然消失。修法：在 `isAtomicPreserve` 讓 `HR` 回傳 `true`，序列化時保留為 `⟦*N⟧` 原子佔位符，注入後完整還原（`cloneNode(true)` 保留 class 屬性如 `hideonmobile`）。影響函式：`content-ns.js` → `isAtomicPreserve`；Gemini 與 Google Translate 兩條序列化路徑均自動受益（皆已呼叫此函式）。

**v1.4.9** — 補做 BBCode DIV「純文字 + BR、無 block 子孫」（Case B）的偵測，重做 v1.4.8 試過但回退的邏輯。差異是這次條件嚴格 4 重：(1) tag 必須屬於新加的 `SK.CONTAINER_TAGS = {DIV, SECTION, ARTICLE, MAIN, ASIDE}`（排除 inline element 如 A/SPAN/B/I）；(2) 至少有一個直接 `<br>` 子元素（排除 leaf-content-div 那種純文字無 BR 的 DIV，仍由 v1.0.8 leaf scan 處理）；(3) 直接 TEXT 子節點 trimmed 總長度 >= 20 字（與 leaf-content-div 門檻對齊，排除短連結／麵包屑）；(4) `isCandidateText` 通過。新增 stats 計數 `containerWithBr` 作為 forcing function。三條原本被 v1.4.8 踩到的 spec（`detect-leaf-content-div` / `detect-nav-anchor-threshold` / `detect-nav-content`）SANITY 後確認仍 pass。影響函式：`content-detect.js` → `collectParagraphs` → `acceptNode`；新 helpers `hasBrChild` / `directTextLength`；新常數 `content-ns.js` → `SK.CONTAINER_TAGS`。

**v1.4.8** — 修正字面 `\n` 在 fragment no-slots / element no-slots 注入路徑殘留的問題。v1.4.6 的字面 `\n` → 真正換行符規範化只在 `deserializeWithPlaceholders`（有 slots）路徑生效，無 slots 路徑完全繞過。修法：(1) 在 `injectTranslation` 入口統一把字面 `\n`（兩字元）→ 真正換行符（U+000A），覆蓋所有後續路徑；(2) 在 `injectFragmentTranslation` 無 slots 分支補上 `\n` → `<br>` 還原（呼叫 `buildFragmentFromTextWithBr`，與 element no-slots 走的 `replaceTextInPlace` 行為對齊）。影響函式：`content-inject.js` → `injectTranslation` 入口 + `injectFragmentTranslation` 無 slots 分支。

註：原本本版還包含 BBCode DIV「純文字 + BR、無 block 子孫」（Case B）的偵測補強，但實作過於寬鬆，會誤抓既有的 nav 短連結 / leaf content div / 麵包屑（踩 3 條 regression spec），已回退；改記入 PENDING_REGRESSION 待重做。

**v1.4.7** — 修正 XenForo / BBCode 論壇風格頁面中，`<div class="bbWrapper">` 等非 block-tag 容器內的直接 text 子節點（intro 段落、「Pros:」標題等）漏翻的問題。根因：`DIV` 不在 `BLOCK_TAGS_SET`，`collectParagraphs` walker 對 `.bbWrapper` 直接回 `FILTER_SKIP`，完全沒走到 `containsBlockDescendant` / `extractInlineFragments`，導致 `<LI>` 被翻而 intro 文字完全不可見。修法：在 `acceptNode` 的非 `BLOCK_TAGS_SET` 分支，若元素有直接 TEXT 子節點（trimmed >= 2 chars）且有 block 子孫，補做 `extractInlineFragments`，把文字抽成 fragment 單元。影響函式：`content-detect.js` → `collectParagraphs` → `acceptNode`。

**v1.4.6** — 修正 Gemini 有時把換行字元以字面 `\n`（反斜線 + n，兩個可見字元）輸出，而非真正換行符（U+000A）的問題。`pushText` 用 `includes('\n')` 偵測換行，字面 `\n` 無法觸發，導致 `\n` 以兩個字元殘留 DOM。修法：在 `deserializeWithPlaceholders` 的 `normalizeLlmPlaceholders` 之後加一個規範化步驟，把字面 `\n`（`/\\n/g`）替換為真正換行符，再繼續後續的 `collapseCjkSpacesAroundPlaceholders` 與 `parseSegment`。影響函式：`content-serialize.js` → `deserializeWithPlaceholders`。

**v1.4.5** — 修正 Gemini 在翻譯含醫藥/術語內容的 slot 時，會在佔位符括號內插入描述文字（如 `⟦0 drug⟧` → `⟦0⟧`），導致 `normalizeLlmPlaceholders` 無法識別，最終 `⟦` / `⟧` 被剝除、「0 drug」/「/0 drug」裸字串殘留 DOM 的問題。修法：在 `normalizeLlmPlaceholders` 加一條 regex，偵測「數字後有空白 + 非空白文字」的模式並自動清除多餘描述（保留前綴符號與數字）。影響函式：`content-serialize.js` → `normalizeLlmPlaceholders`。

**v1.4.4** — 修正 `<strong><br>段落` 結構翻譯後 `<br>` 消失的問題。根因是 `collapseCjkSpacesAroundPlaceholders` 的 4 個 pattern 使用 `\s+`，會把佔位符標記與 CJK 字元之間的 `\n`（由 `<br>` 序列化來的）一併吃掉，導致還原時找不到 `\n` 而無法產生 `<br>` 元素。修法：將 4 個 pattern 的 `\s+` 改為 `[ \t]+`（只移除空格/tab，保留 `\n`），讓語意換行符能順利通過到 `parseSegment` 的 `pushText` 還原為 `<br>`。

**v1.4.3** — Google Translate 模式加回行內格式保留（`<b>`、`<i>`、`<small>` 等）。測試確認只排除 `<span>`（亂碼根源）就能同時解決兩個問題：Wikipedia lede 等複雜段落不再亂碼、notice box 的斜體/小字等樣式也能正確保留。新增 `SK.GT_INLINE_TAGS` 白名單（`content-ns.js`）供 `serializeForGoogleTranslate` 判斷哪些 tag 加標記。

**v1.4.2** — 修正 Google Translate 模式翻譯複雜段落（如 Wikipedia lede）時出現亂碼（如 `7/D/17777/S4]m`）的問題。根本原因：v1.4.1 使用 `serializeWithPlaceholders` 產生 10+ 個 `【N】` 標記，Google MT 被過多標記數字搞亂位置與文字，導致亂碼。修法：改用新的 `serializeForGoogleTranslate`，只對 `<a>` 連結加 `【N】`/`【/N】` 配對標記、atomic 元素（footnote sup）加 `【*N】` 單一標記，其他 span/b/i/abbr 全部直接遞迴取文字（不加標記）。通常整段只有 2-4 個標記，Google MT 能正確保留且不亂移。

**v1.4.1** — 修正 Google Translate 模式無法保留連結與行內格式的問題。根本原因：`translateUnitsGoogle` 原本直接取 `innerText` 送出，行內 HTML（`<a href>`、`<b>`、`<i>` 等）全部丟失。修法：改用 `serializeWithPlaceholders` 取得 slots，但把 `⟦N⟧`/`⟦/N⟧` 換成 `【N】`/`【/N】` 再送 Google Translate（`⟦⟧` 是數學符號，Google MT 會亂移其位置；`【】` 是 CJK 標點，Google MT 視為不透明文字，能原樣保留且維持正確前後位置）。拿回譯文後換回 `⟦N⟧`/`⟦/N⟧`，走現有 `deserializeWithPlaceholders` + `tryRecoverLinkSlots` fallback 鏈。（注：此版在 Wikipedia lede 等複雜段落仍有亂碼，由 v1.4.2 進一步修正）根本原因：`translateUnitsGoogle` 原本直接取 `innerText` 送出，行內 HTML（`<a href>`、`<b>`、`<i>` 等）全部丟失。修法：改用 `serializeWithPlaceholders` 取得 slots，但把 `⟦N⟧`/`⟦/N⟧` 換成 `【N】`/`【/N】` 再送 Google Translate（`⟦⟧` 是數學符號，Google MT 會亂移其位置；`【】` 是 CJK 標點，Google MT 視為不透明文字，能原樣保留且維持正確前後位置）。拿回譯文後換回 `⟦N⟧`/`⟦/N⟧`，走現有 `deserializeWithPlaceholders` + `tryRecoverLinkSlots` fallback 鏈。

**v1.4.0** — 新增 Google Translate 支援。網頁翻譯：新增 Opt+G 快捷鍵，使用 Google Translate 非官方免費端點（`translate.googleapis.com/translate_a/single?client=gtx`），不需要任何 API Key；使用 U+2063 隱形分隔符批次串接多段文字（每批最多 5500 URL encoded chars），翻譯完成後自動拆分回對應段落。YouTube 字幕翻譯：設定頁「YouTube 字幕」分頁新增引擎選擇（Gemini 預設 / Google Translate），選擇 Google Translate 後字幕翻譯 API 路由至 `TRANSLATE_SUBTITLE_BATCH_GOOGLE`，不走 Gemini rate limiter。用量統計：Google Translate 紀錄以「字元數 + $0（免費）」顯示，不計入 token 費用。`STATE.translatedBy` 追蹤當前引擎（`'gemini'` / `'google'` / `null`），兩個快捷鍵各自獨立 toggle（同引擎 = 還原，切引擎 = 先還原再翻）。快取：Google Translate 結果以 `_gt` / `_gt_yt` 後綴與 Gemini 快取分開存放。

---

## v1.3.x

**v1.3.16** — Safari / Firefox 相容性 shim：全 codebase `chrome.*` → `browser.*`。新增 `lib/compat.js`，以 Proxy 做 lazy 解析（每次 property access 時讀 `globalThis.browser ?? globalThis.chrome`，避免 const 在 import 當下凍結成 undefined 或錯誤的 mock——後者會讓 Playwright 多 spec 共用 module cache 時 cache / rate-limiter unit test fail）；`content-ns.js` 頂部加 `globalThis.browser = globalThis.browser ?? globalThis.chrome` 供 content scripts 繼承。`options.js` 偵測平台，Safari 上隱藏「至 chrome://extensions/shortcuts 設定快捷鍵」連結。這是 iOS/iPadOS 移植準備的第一步。

**v1.3.15** — 移除 `manifest.json` 的死權限 `scripting`：v1.3.13 清除 `FETCH_YT_CAPTION_TRACKS` 後整個 codebase 已無任何 `chrome.scripting` 呼叫，該權限純屬多餘，一併移除以減少 Chrome Web Store 審查摩擦，並向 Safari 移植邁進一步。

**v1.3.14** — 修正 Debug 分頁設定無法儲存的問題：（1）Debug 分頁缺少「儲存設定」按鈕，新增 `save-debug` 按鈕並掛上 `save()` handler；（2）`ytDebugToast` 和 `ytOnTheFly` 兩個 checkbox 未掛 `markDirty`，打勾後沒有「有未儲存的變更」提示，補上個別 change 事件監聽。

**v1.3.13** — 清除 v1.3.9–v1.3.11 遺留死程式碼：移除 `background.js` 的 `FETCH_YT_CAPTION_TRACKS` handler（從未被呼叫）、`content-youtube.js` 的 `extractCaptionTracksFromPage` 與 `selectBestTrack` 函式（v1.3.12 XHR monkey-patch 架構不再需要主動抓取 track URL）；更新 `content-youtube.js` 檔案標頭為 v1.3.12 架構說明；刪除孤立 fixture `youtube-innertube-fetch-spa.html`；更新 `youtube-innertube-fetch.spec.js` 的 test #1/#2 說明，標明 `extractCaptionTracksFromPage` 已從 extension 移除。

**v1.3.12** — 正式修正 YouTube 字幕 POT 問題（v1.3.9–v1.3.11 三輪嘗試的終局解）：實測證明 YouTube `/api/timedtext` URL 含 `exp=xpv` 時，所有主動 fetch（包含 MAIN world same-origin、service worker、isolated world）均回傳 HTTP 200 但 body 為空，v1.3.11 的 `chrome.scripting.executeScript` 方案亦同樣失敗。根本解法：恢復 `content-youtube-main.js`（MAIN world，`document_start`）的 XHR + fetch monkey-patch，攔截 YouTube 播放器**自己**帶 POT 發出的 `/api/timedtext` 請求；`content-youtube.js` 改為等待 `shinkansen-yt-captions` CustomEvent，若等不到則呼叫 `forceSubtitleReload()`（toggle CC 按鈕）強迫播放器重發 XHR；移除 `FETCH_YT_CAPTIONS` message handler（不再需要）；regression test #3/#4 更新為驗證新的 CustomEvent 協定。

**v1.3.11** — 正式修正 YouTube 字幕 POT 問題：加回 `scripting` 權限（現為實際使用），`FETCH_YT_CAPTIONS` 改用 `chrome.scripting.executeScript({ world: 'MAIN' })` 在 YouTube tab 的 MAIN world 直接執行 `fetch()`，使請求帶 `sec-fetch-site: same-origin` 且自動帶入使用者 session cookies，YouTube 視為正常瀏覽器行為不要求 POT；`chrome.scripting.executeScript` 亦繞過頁面 CSP。`FETCH_YT_CAPTION_TRACKS` SPA fallback 同步改用 scripting 讀 MAIN world `ytInitialPlayerResponse`，ANDROID API 退為 fallback。`fetchCaptionsForVideo` 恢復先讀頁面 `<script>` WEB tracks 的 fast path（因 MAIN world fetch 使 WEB format URL 可正常使用），WEB tracks + scripting fetch 組合，不需 POT。

**v1.3.10** — 修正 YouTube 字幕 POT（Proof-of-Origin Token）問題：`FETCH_YT_CAPTION_TRACKS` 改用 Innertube ANDROID player API（POST `/youtubei/v1/player`，clientName=ANDROID），取得不需要 POT 的 ANDROID-format captionTracks URL（c=ANDROID）；`fetchCaptionsForVideo` 改為永遠走 background 取 ANDROID tracks，不再使用頁面 `<script>` 的 WEB-format tracks（c=WEB，YouTube ~2025 起要求 POT，沒有 POT 則 HTTP 200 但回空）。ANDROID API 無結果時保留 HTML page parse 作為 fallback。新增 `urlClient` 欄位到 caption track selected log 以利除錯驗證。

**v1.3.9** — YouTube 字幕架構重構：移除 MAIN world XHR 攔截（`content-youtube-main.js` 廢棄），改為主動抓取架構。新流程：isolated world `extractCaptionTracksFromPage()` 從頁面 `<script>` 標籤解析 `ytInitialPlayerResponse`，挑選最佳英文軌道後請 background `FETCH_YT_CAPTIONS` 取得字幕原文；SPA 導航後 script 已過期時自動 fallback 至 background `FETCH_YT_CAPTION_TRACKS`（重新抓 YouTube 頁面）。manifest 同步移除 MAIN world `content_scripts` 宣告，架構為 Safari iOS 移植鋪路。

**v1.3.8** — 移除未使用的 `scripting` 權限（Chrome Web Store 審查要求：manifest 不得宣告未實際使用的權限）。

**v1.3.7** — YouTube 設定頁微調：移除「字幕翻譯可以使用比文章翻譯更便宜的模型，例如 Flash Lite」說明文字；移除 temperature 說明文字「字幕翻譯建議保持低 temperature（預設 0.1），讓翻譯結果穩定一致、不偏離原意。」；YouTube 字幕 temperature 預設值由 0.1 改為 1。

**v1.3.6** — 程式碼品質重構（無使用者可見行為改變）：（1）`content.js` `translateUnits` 的 `chrome.runtime.sendMessage` 批次呼叫加 90s `Promise.race` 逾時保護，防止 Gemini API 無回應時翻譯永久卡住；（2）新增 `lib/constants.js` 統一管理批次常數（`DEFAULT_UNITS_PER_BATCH = 12`、`DEFAULT_CHARS_PER_BATCH = 3500`），`lib/gemini.js` 與 `lib/storage.js` 改從此檔 import，消除三處重複定義；（3）`content-ns.js` 對應常數加上說明注解，標明與 `lib/constants.js` 的鏡像關係；（4）`background.js` `computeBilledCostUSD()` 改委派給 `computeCostUSD()`，消除計費費率計算的程式碼重複；（5）`content-spa.js` History API patch 加 `__sk_patched` 旗標防止重複注入，避免 content script 重複執行時形成 pushState 循環呼叫。

**v1.3.5** — `content-youtube.js` 技術債清理與強固性提升（無使用者可見行為改變）：（1）`translateWindowFrom` 加 try-finally 包裹，確保 `translatingWindows.delete()` 無論正常完成、提前 return 或例外都必然執行，防止 per-window 防重入鎖死；（2）`_runBatch` 改用局部 `_batchApiMs` 收集各批次計時，視窗完成後才同步至 `YT.batchApiMs`，消除多視窗並行時互相覆蓋的 debug 面板計時錯誤；（3）`stopYouTubeTranslation()` 補上 `rawSegments = []` 與 `translatedWindows = new Set()` 重置，讓函式狀態清理自給自足；（4）`yt-navigate-finish` handler 補上 `pendingQueue`、`translatedWindows`、`translatingWindows` 的明確重置，消除 SPA 導航期間殘留狀態阻塞新視窗翻譯的風險；（5）字幕區位置追蹤 timer 從 100ms 降為 250ms，每秒 4 次足夠追蹤，節省約 60% 定時器開銷；（6）模組頂部補上依賴聲明與外部介面說明。

**v1.3.4** 字幕翻譯 system prompt 新增 rule 8：忠實保留不雅詞彙，禁止道德審查或委婉潤飾（如 "fuck" → 「幹」，不得軟化為「糟糕」）。

**v1.3.3（2026-04-16）補上 v1.3.1 的實際程式修正**——v1.3.1 的 CHANGELOG entry、regression spec (`test/regression/youtube-spa-navigate.spec.js`)、git tag 都已存在，但 `shinkansen/content-youtube.js` 的實際修正一直躺在 working tree 未 commit，導致 v1.3.1 / v1.3.2 tag 對應的 tree 都不含該修正，build 出的 extension 遇到 YouTube SPA 切換影片仍不會自動重啟字幕翻譯。本版把 `yt-navigate-finish` 改為 async handler（讀 `ytSubtitle.autoTranslate` 設定 + `wasActive` 旗標 + 500ms setTimeout）與 `stopYouTubeTranslation()` 的 `seeked` / `ratechange` removeEventListener 補漏正式 commit 進 code。行為細節同 v1.3.1 entry；實際 regression 保護從 v1.3.3 起生效。

**v1.3.1（2026-04-16）修正 YouTube SPA 導航後字幕翻譯未自動重啟**——根本原因：`yt-navigate-finish` 事件處理器在 SPA 導航（點選其他影片）時正確重置了字幕翻譯狀態（`YT.active = false`、`rawSegments = []`），但從未為新影片重新啟動翻譯；首次載入頁面時的自動翻譯邏輯（`content.js` 初始化末段）只執行一次、不涵蓋 SPA 導航。修法：`yt-navigate-finish` 改為 async handler，重置後讀取 `ytSubtitle.autoTranslate` 設定；若設定開啟或之前字幕翻譯已啟動（`wasActive`），等 500ms 讓 YouTube 播放器初始化後自動呼叫 `translateYouTubeSubtitles()`——走「rawSegments=0」分支（等待 XHR + forceSubtitleReload 備案），與首次載入的自動翻譯流程完全一致。同時修正 `stopYouTubeTranslation()` 的漏洞：原本只移除 `timeupdate` listener，`seeked` 與 `ratechange` listener 遺漏；補上 `removeEventListener('seeked', ...)` 與 `removeEventListener('ratechange', ...)`，確保 stop → start 循環不累積 listener。

**v1.3.0（2026-04-16）YouTube 字幕翻譯里程碑（版本跳躍）+ SPEC.md 文件修正**——YouTube 字幕翻譯自 v1.2.5 累積至 v1.2.65 已達穩定可用里程碑（XHR 預翻、時間視窗批次、on-the-fly 備援、seek/rate 補償、preserveLineBreaks、字幕框展開置中、debug 面板、獨立模型/計價/prompt 設定、用量紀錄），版本號跳至 1.3.0 標記此里程碑；同時修正 SPEC.md 五處與程式碼不符的文件錯誤：（1）§8.1 `domainRules` 移除不存在的 `"blacklist": []` 欄位；（2）§8.1 補上 `lib/storage.js` 中存在但文件遺漏的四個設定欄位：`toastOpacity`（0.7）、`toastAutoHide`（true）、`skipTraditionalChinesePage`（true）、完整 `ytSubtitle` 區塊；（3）§11.2 成功 Toast「自動消失」欄位從「否（點擊外部關閉）」改為「是（`toastAutoHide` 開啟時 5 秒；預設開啟）」，符合 v1.1.3 起的實際行為；（4）§12「設定頁『Log』分頁」改為「設定頁『Debug』分頁」，符合 v1.2.49 改名後的現況；（5）§13.1 Popup 版面加入「YouTube 字幕翻譯 toggle（只在 YouTube 影片頁面顯示）」，補上 v1.2.12 新增的 popup UI 元件。

---

## v1.2.x

**v1.2.65**——（1）`lib/storage.js` 的 `ytSubtitle.autoTranslate` 預設值從 `false` 改為 `true`（僅影響全新安裝或清除設定的使用者，已儲存設定者不受影響）；（2）YouTube 字幕設定頁模型選單，`gemini-3.1-pro-preview` 說明從「最頂」改為「大炮打小鳥，不推薦」，明確提示字幕翻譯不需要 Pro 等級。

**v1.2.64**——（1）toggle 說明文字換行：`checkbox-label` 內的說明 `<small>` 包進 `<div class="checkbox-body">`，說明文字現在獨立一行顯示在 toggle 標籤下方；（2）Log 區塊分隔：在 YouTube 字幕 section 與 log-toolbar 之間插入 `<section><h2>Log 記錄</h2></section>`，讓兩個區塊有明確視覺邊界。

**v1.2.63**——`ytAutoTranslate` checkbox 的說明文字原為「不需手動按快捷鍵」，但字幕翻譯是由 Popup toggle 控制、與 Option+S 快捷鍵無關；改為「不需手動在 Popup 開啟開關」。

**v1.2.62**——根本原因：`applyUsageSearch()` 只呼叫 `renderTable(filtered)` 更新表格列，四張彙總卡片仍顯示完整日期範圍數字；修法：新增 `updateSummaryFromRecords(records)` 函式，從傳入的記錄陣列重算四個彙總值並寫入 DOM；`applyUsageSearch()` 在 `renderTable(filtered)` 之後立刻呼叫 `updateSummaryFromRecords(filtered)`。

**v1.2.61**——`shortModel`（如 `3.1-flash-lite`）因欄寬不足而折成多行；修法：`renderTable` 的模型欄改為 `<td class="col-model">`，CSS 新增 `.usage-table .col-model { white-space: nowrap; }` 防止折行。

**v1.2.60**——用量紀錄 UI 五項修正：（1）YouTube URL 顯示修正：`shortenUrl` 新增 YouTube watch URL 特判；（2）URL 可點擊：`renderTable` 的網址欄由 `<span>` 改為 `<a>`；（3）搜尋功能：新增 `allUsageRecords` module-level 變數與 `applyUsageSearch()` 函式；（4）網域 / 網址過濾：搜尋框支援輸入網域；（5）時間精度：日期篩選器改為 `datetime-local` 格式。

**v1.2.59**——debug 面板 buffer 欄在 seek 後顯示「翻譯中…」取代虛假正值。根本原因：`translateWindowFrom` 開頭立刻把 `translatedUpToMs` 設為 `windowEndMs`（提前佔位），導致 seek 後 API 還在飛行時 buffer 顯示 `+28s ✓` 等虛假正值；修法：`bufStr` 計算先判斷當前視窗是否在 `translatingWindows`（in-flight）且不在 `translatedWindows`（尚未完成）——若符合，顯示「翻譯中…」。

**v1.2.58**——修正 seek 後「翻譯中…」提示不消失。根本原因：`hideCaptionStatus()` 的呼叫被 `!YT._firstCacheHitLogged` guard 保護；修法：在 `el.textContent !== cached` 的寫入區塊中，將 `hideCaptionStatus()` 從條件內移出，改為每次 `cached` 為真時都呼叫（冪等）。

**v1.2.57**——修正拖動進度條後字幕區未顯示「翻譯中…」。根本原因：`onVideoSeeked` 直接呼叫 `translateWindowFrom` 但沒有先顯示提示；修法：在 `onVideoSeeked` 呼叫 `translateWindowFrom` 之前，檢查目標視窗是否已在 `YT.translatedWindows` Set 中——若不在則先呼叫 `showCaptionStatus('翻譯中…')`。

**v1.2.56**——修正第一視窗冷啟動慢（batch 0 先 await 暖熱 cache）。根本原因：`translateWindowFrom` 用 `Promise.all` 同時送出所有批次，第一視窗大批次（8 units）冷路徑需 13s；修法：將 `Promise.all(batches.map(...))` 拆成「先 `await _runBatch(batches[0], 0)`，再 `await Promise.all(batches.slice(1).map(...))`」——batch 0 以 ~1.5s 暖熱 Gemini implicit cache，之後 batch 1+ 並行走暖路徑（~2s），首條字幕從 ~13s 降至 ~3.5s。

**v1.2.55**——字幕區載入提示（取代 toast）。翻譯啟動後不再顯示 toast 轉圈提示，改為在 `.ytp-caption-window-container` 內注入仿原生字幕樣式的提示元素；`setInterval(100ms)` 持續追蹤位置，動態貼在英文字幕正上方；第一條中文字幕出現時自動移除。

**v1.2.54**——並行視窗翻譯（translatingWindows Set）。根本原因：`YT.translating: boolean` 互斥鎖造成視窗 N 翻譯進行中無法預熱視窗 N+1，形成英文字幕間隙；修法：替換為 `YT.translatingWindows: Set<number>`，以各視窗的 `windowStartMs` 作為 per-window 防重入 key。

**v1.2.53**——修正開頭字幕 20 秒空白（Observer 提前啟動）。根本原因：`await translateWindowFrom()` → `startCaptionObserver()` 的順序導致 Observer 在整個第一視窗翻譯期間完全沒有運行；修法：將 `startCaptionObserver()` 移至 `await translateWindowFrom()` 之前。

**v1.2.52**——Log 持久化（跨 service worker 重啟）。`lib/logger.js` 新增 `persistLog()` 函式，對 `youtube` / `api` / `rate-limit` 三類 log 條目做 fire-and-forget 寫入至 `chrome.storage.local`（key：`yt_debug_log`，上限 100 筆，FIFO 淘汰）。

**v1.2.51**——字幕效能診斷 Log 強化：新增 `sessionOffsetMs` 欄位、`batch done` 詳細 log、`first translated subtitle visible` 事件記錄、`subtitle batch received` 前置耗時 log。

**v1.2.50**——自適應首批大小（adaptive first batch）。以「視窗起點距影片當前位置的 lead time」動態決定 batch 0 條數：`lead ≤ 0` → 1 條；`lead < 5s` → 2 條；`lead < 10s` → 4 條；`lead ≥ 10s` → 8 條（正常）。

**v1.2.49**——設定頁 Debug 分頁重構 + On-the-fly 翻譯開關。（1）設定頁「Log」分頁改名為「Debug」；（2）YouTube debug section 移至 Debug 分頁；（3）Debug 分頁新增「啟用 On-the-fly 備援翻譯」toggle（`ytOnTheFly`，預設關閉）。

**v1.2.48**——修正向後拖進度條後字幕顯示英文（translatedWindows Set 精確跳過判斷）。根本原因：v1.2.46 的 `captionMapCoverageUpToMs` 是高水位線，不保證中間所有視窗都翻過；修法：以 `SK.YT.translatedWindows: Set<number>` 精確記錄每個實際翻譯完成的 `windowStartMs`，`translateWindowFrom` 改為 `if (YT.translatedWindows.has(windowStartMs)) return`。

**v1.2.47**——字幕批次大小從 20 降為 8。字幕段落極短（3–5 字），20 條/批涵蓋 ~33 秒，改為 8 條/批（~13 秒），串流注入讓最早字幕在 ~7s 備妥。

**v1.2.46**——向後拖進度條後 buffer 顯示修正 + 防重複翻譯。新增 `SK.YT.captionMapCoverageUpToMs` 欄位記錄「實際翻過最遠的位置」；`onVideoSeeked` 改為不論向前向後一律重置 `translatedUpToMs = newWindowStart`；`translateWindowFrom` 新增跳過判斷——若 `windowEndMs ≤ captionMapCoverageUpToMs`，直接推進返回，不送 API。

**v1.2.45**——過期視窗追趕機制。`translateWindowFrom` 完成後新增 video 位置檢查：若 `video.currentTime > translatedUpToMs`（API 耗時過長），立刻把 `translatedUpToMs` 跳到 video 當前位置所在的視窗邊界。`SK.YT.staleSkipCount` 計數此事件。

**v1.2.44**——自適應 lookahead。每個視窗翻完後計算 `adaptiveLookaheadMs = min(lastApiMs × 1.3 × playbackRate, 60000)`，下次觸發改用 `max(設定值, adaptiveLookaheadMs)`。

**v1.2.43**——debug 面板各批次耗時逐一顯示。`batch API` 欄位從只顯示第一批完成時間，改為逐批顯示耗時，格式如 `5230 / 7110 / 16770ms`；進行中顯示 `…`。

**v1.2.42**——字幕批次串流注入。將各批次的結果處理移入 `.then()` 回呼，每批一完成立刻寫入 captionMap 並呼叫 `replaceSegmentEl` 替換頁面現有字幕，不等其他批次。

**v1.2.41**——字幕批次翻譯改為並行。將循序 `await` 改為 `Promise.all` 並行——所有批次同時送出，總耗時從 N × T_batch 降為 max(T_batch)，Flash Lite 30 秒視窗由 20 秒降至約 6–8 秒。

**v1.2.40**——debug 面板新增診斷欄位：（1）`buffer`：`translatedUpToMs - video.currentTime`；（2）`last API`：最後一批 API 實際耗時；（3）`on-the-fly`：本 session 累計落入 on-the-fly 備案的字幕條數。

**v1.2.39**——YouTube 字幕用量紀錄修正 + 獨立模型設定。（1）修正字幕翻譯用量未紀錄：新增 `_logWindowUsage` 輔助函式，翻譯完成後呼叫 `LOG_USAGE`；（2）YouTube 字幕獨立模型設定：options 頁新增模型下拉選單與計價欄位；`DEFAULT_SETTINGS.ytSubtitle` 新增 `model: ''` 與 `pricing: null`。

**v1.2.38**——（1）`seeked` / `ratechange` listener 原本在第一批完成後才掛上，提早到 `YT.active = true` 後立刻掛上；（2）debug 面板新增 `speed: Xx` 欄位；（3）移除「多行字幕整合翻譯」設定頁 toggle，功能改為永遠開啟（`preserve` 硬編碼 `true`）。

**v1.2.37**——（1）播放速度補償：`lookaheadMs = lookaheadS * 1000 * playbackRate`；（2）新增 `onVideoRateChange()` 監聽 `video.ratechange`；（3）`debugLog` checkbox 補上 `markDirty` 監聽。

**v1.2.36**——（1）seek 修正：新增 `onVideoSeeked()` 監聽 `video.seeked` 事件，若新位置超出 `translatedUpToMs` 則直接跳到新位置所在的視窗邊界；（2）`yt-reset-prompt` 按鈕加上 `markDirty()` 呼叫。

**v1.2.35**——（1）置中修正：`expandCaptionLine` 擴展到所有 block 容器，到達 `caption-window` 時清除 `margin-left`、改用 `transform: translateX(-50%)`；（2）字幕 prompt rule 7：句末不加句號（。）。

**v1.2.34**——修正字幕展開時閃爍一幀。`expandCaptionLine` 改為同步呼叫（純 CSS style 設定，不需量測 layout），`el.textContent` 與容器寬度同一幀生效。

**v1.2.33**——修正 `expandCaptionLine` 永遠被 `getClientRects` 早返回。`ytp-caption-segment` 是 `display: inline-block`，`getClientRects()` 永遠回傳長度 1；修法：移除該判斷，無條件執行展開。

**v1.2.32**——修正 `expandCaptionLine` 未實際展開字幕框。v1.2.31 只設 `max-width: none` 但沒清除 `width`；修法：同時設 `width: max-content` + segment 本身加 `white-space: nowrap`。

**v1.2.31**——長譯文展開字幕框取代折行。移除 autoScaleFont 後長中文譯文會折行；改用 `expandCaptionLine(el)` 函式向上尋找 block 容器並移除 `max-width` 限制。

**v1.2.30**——移除 autoScaleFont。診斷確認 on-the-fly 與 XHR 預翻字幕大小不一致，使用者接受折行、不接受縮小字型；移除 `autoScaleFont`，兩條路徑統一不縮字型。

**v1.2.29**——修正 autoScaleFont 重複觸發造成字幕閃爍。原本不論文字是否改變都無條件排 rAF；修法：把 `autoScaleFont` 呼叫移入 `el.textContent !== cached` 的 if 區塊內，文字未改變時不觸發縮放。

**v1.2.28**——修正 autoScaleFont 誤縮正常字幕。`SINGLE_LINE_MAX_H = 55px` 固定閾值在較大視窗下誤觸；改用 `el.getClientRects().length > 1` 直接偵測 inline span 是否真的折行。

**v1.2.27**——修正 XHR 到達後仍用 on-the-fly 的問題。v1.2.26 的 `captionMap.size === 0` 分支讓當前視窗實際從未翻譯；修法：移除此分支，一律呼叫 `translateWindowFrom(windowStartMs)` + `attachVideoListener()`。

**v1.2.26**——修正 XHR 攔截失效（強制 CC toggle 重新抓字幕）。CC 已開但播放器不重新發出 XHR 時，`rawSegments=0` 持續；修法：1 秒後呼叫 `forceSubtitleReload()`，偵測 `.ytp-subtitles-button[aria-pressed="true"]` 確認 CC 已開，自動 toggle 關閉再打開，強迫播放器重新抓字幕。

**v1.2.25**——修正 XHR 未攔截時誤顯示「請開啟 CC」。5 秒後同時檢查 `captionMap.size`——若 > 0 改顯示「字幕翻譯進行中（N 條已備妥）」。

**v1.2.24**——修正 autoTranslate 誤報「請開啟 CC」。else 分支改為先顯示「字幕翻譯已啟動，等待字幕資料⋯」（loading 狀態），5 秒後若 `rawSegments` 仍為空才顯示「請開啟 CC」。

**v1.2.23**——長譯文自動字型縮放（autoScaleFont）。新增 `autoScaleFont(el)` 函式，在 rAF 內以 `getClientRects().length > 1` 偵測折行，若折行則以每步 6% 逐步縮小 `font-size`（94%→88%→82%→76%），直到縮回單行。（注：此功能後續 v1.2.28–v1.2.30 持續調整後最終移除）

**v1.2.22**——修正空 segment 父容器殘餘高度。`content.css` 新增 `.ytp-caption-segment:empty { display: none }` 及 `span:has(> .ytp-caption-segment:empty) { display: none }` 隱藏空 segment 及其父容器。

**v1.2.21**——修正 preserveLineBreaks 輸出 literal `\n` 字串。`buildTranslationUnits` 改以空格串接多行（不傳 `\n` 給 LLM）；output 處理新增雙重替換 `.replace(/\\n/g, ' ').replace(/\n/g, ' ')`；system prompt rule 6 改為「單行輸出，不要插入任何換行符號」。

**v1.2.20**——修正 preserveLineBreaks 多行仍顯示問題。移除「happy path」的 `split('\n')` 拆行邏輯；多行 group 永遠採用合併策略：LLM 譯文中的 `\n` 全部替換為空格，完整譯文存入 `unit.keys[0]`，其餘 key 存空字串。

**v1.2.19**——多行字幕整合翻譯（preserveLineBreaks）。新增 `ytSubtitle.preserveLineBreaks` 設定（預設 false，Beta），控制是否把同一 JSON3 event 內的多行字幕合併為一個翻譯單位（後 v1.2.38 改為永遠開啟）。

**v1.2.18**——修正 JSON3 多行歌詞拆行。`parseJson3` 改為 `split('\n')`，每行各自建一條 rawSegments 條目，對齊 DOM 的逐行 segment 粒度。

**v1.2.17**——修正字幕 on-the-fly 誤觸 + debug 面板事件截斷。診斷確認 on-the-fly 的根本原因是 `el.textContent = cached` 本身會觸發 `characterData` MutationObserver 回呼；修法：在 `replaceSegmentEl` 開頭加 CJK 字元偵測，含中日韓字元的文字直接 return。

**v1.2.16**——YouTube debug verbose logging。複用 `ytSubtitle.debugToast` toggle 同時控制 debug 面板與詳細 Log；新增 debug bridge `GET_YT_DEBUG` action。

**v1.2.15**——debug 面板改為即時重繪。抽出 `_debugRender()`；新增 `_debugInterval`（`setInterval(_debugRender, 500)`），面板 DOM 建立時啟動；`_debugRemove()` 清理時先 `clearInterval`。

**v1.2.14**——字幕翻譯即時 debug 面板（`ytSubtitle.debugToast`，預設 false）。開啟後字幕翻譯啟動時在頁面左上角出現綠字面板，顯示 active/translating 狀態、rawSegments 條數、captionMap 大小、translatedUpToMs、影片播放位置、最後一個事件等。

**v1.2.13**——三項修正：（1）options.js 補上 `tab-youtube` 的 `input`/`change` → `markDirty` 監聽；（2）popup 字幕 toggle 標籤改為「YouTube 字幕翻譯」；（3）`content-spa.js` 的 `onSpaObserverMutations` 新增排除條件：位於 `.ytp-caption-window-container` 或 `.ytp-caption-segment` 內部的 DOM 變動不觸發 SPA rescan。

**v1.2.12**——字幕翻譯與 Option+S 職責分離。（1）移除 `SK.translatePage()` 內的 YouTube 路由；YouTube 頁面 Option+S 現在翻譯頁面內容（說明、留言等），與字幕翻譯完全無關；（2）popup 新增「字幕翻譯」toggle，只在 YouTube 影片頁顯示；（3）字幕翻譯的啟動方式僅有兩個入口：popup toggle 或 `ytSubtitle.autoTranslate` 設定。

**v1.2.11**——字幕時間視窗批次翻譯架構 + YouTube 設定頁。（1）`rawSegments` 改為含時間戳的 `[{text, normText, startMs}]`；（2）預翻譯改為時間視窗架構 `translateWindowFrom(windowStartMs)`，`video.timeupdate` 監聽驅動；（3）`lib/storage.js` 新增 `DEFAULT_SUBTITLE_SYSTEM_PROMPT` 常數與 `ytSubtitle` 設定區塊；（4）options 新增「YouTube 字幕」分頁；（5）`content.js` 初始化新增 YouTube auto-subtitle 檢查。

**v1.2.10**——字幕翻譯獨立 Prompt 與 Temperature。新增 `TRANSLATE_SUBTITLE_BATCH` 訊息類型，使用字幕專用 system prompt（逐段翻譯、不合併、口語化）與 temperature 0.1；`handleTranslate` 新增 `geminiOverrides` 參數。

**v1.2.9**——修正 observer 啟動時序。`translateYouTubeSubtitles()` 原先在 `rawSegments` 有資料時先呼叫 `startCaptionObserver()` 再 `await runPreTranslation()`；調換順序為先 `await runPreTranslation()` 完成再 `startCaptionObserver()`，消除英文閃爍。

**v1.2.8**——XHR 攔截預翻譯架構。新增 `content-youtube-main.js`（MAIN world，`run_at: document_start`），monkey-patch `XMLHttpRequest` 與 `fetch`，攔截 YouTube 播放器自己發出的 `/api/timedtext` 請求；字幕原文透過 `shinkansen-yt-captions` CustomEvent 傳給 isolated world，批次送 Gemini 預翻譯；`YT.captionMap` 填滿後 MutationObserver 做瞬間替換，無英文閃爍。

**v1.2.7**——改為即時翻譯架構。診斷確認 YouTube 的 `/api/timedtext` 對所有 JavaScript `fetch()` 一律回傳 200 + 空 body；改為 on-the-fly 即時翻譯：MutationObserver 在 `.ytp-caption-segment` 出現時即時查快取或送 Gemini 翻譯（300ms debounce 批次）。移除 `background.js` 的 `GET_YT_PLAYER_DATA` handler。（注：v1.2.8 重新引入 XHR 攔截，此 on-the-fly 架構改為備援路徑）

**v1.2.5 + v1.2.6**——**YouTube 字幕翻譯 MVP**。新增 `content-youtube.js` 模組，在 `youtube.com/watch` 頁面按 Alt+S 時走字幕翻譯流程；v1.2.6 修正：原 v1.2.5 的 `getYtPlayerData()` 被 YouTube 的 strict CSP 封鎖；改用 `background.js` 新增的 `GET_YT_PLAYER_DATA` message handler，透過 `chrome.scripting.executeScript({ world: 'MAIN' })` 讀取 main world 全域變數。

**v1.2.4**——修正含 `<img>` + `<a>` 結構段落翻譯後連結仍消失問題。根本原因：`translateUnits` 序列化階段遇到 `containsMedia(el)` 為 true 時直接回傳 `slots: []`；修法：移除此早返回，讓含媒體元素的段落也走 `hasPreservableInline` → `serializeWithPlaceholders`。

**v1.2.3**——修正含 `<img>` 元素的段落翻譯後連結變成純文字問題。新增 `tryRecoverLinkSlots(el, text, slots)` 函式——在 `ok=false` 路徑中，以原始 `<a>` 元素的 `textContent` 為 key 搜尋 LLM 譯文字串，若找到對應位置則用 `<a>` shell 包住並建構 DocumentFragment。

**v1.2.2**——修正含 `<img>` 元素的段落翻譯後連結消失問題。`content-inject.js` media-preserving path 清空非 main 文字節點後，若父 inline 元素（如 `<a>`）的 textContent 因此變成空字串且不含媒體子元素，則移除該空殼元素。

**v1.2.1**——修正 Stratechery 等動態 widget 網站 SPA observer rescan 無限循環。`content-spa.js` 新增 `spaObserverSeenTexts` Set，在 `spaObserverRescan` 中過濾掉此 SPA session 內已翻譯過的文字。

**v1.2.0**——修正 SPA observer rescan 無限迴圈。fragment 父元素不帶 `data-shinkansen-translated`，`extractInlineFragments` 在 rescan 時重複收集已翻成繁中的 inline run；修法：`flushRun()` 新增 `isTraditionalChinese` 過濾。

---

## v1.1.x

**v1.1.9**——content script 拆分與程式碼重構。將 3081 行的單一 `content.js` 拆分為 7 個職責分明的檔案：`content-ns.js`（命名空間、STATE、常數、工具函式）、`content-toast.js`（Toast）、`content-detect.js`（段落偵測）、`content-serialize.js`（序列化）、`content-inject.js`（DOM 注入）、`content-spa.js`（SPA + Content Guard）、`content.js`（主協調層）。透過 `window.__SK` 命名空間共用。同步重構：BLOCK_TAGS 統一為 Set、`containsBlockDescendant()` 改用 `querySelector()`、`translatePage()` 合併多次 storage.get。

**v1.1.8**——繁中偵測排除日文韓文。新增兩道防護：（1）檢查 `<html lang>` 屬性，`ja` / `ko` 開頭直接排除；（2）計算假名佔比，假名超過 5% 判定為日文。

**v1.1.7**——繁中偵測改為比例制。`isTraditionalChinese` 原本只要出現任何一個簡體特徵字就判定為非繁中；改為簡體特徵字佔 CJK 字元比例 ≥ 20% 才判定為簡體中文。

**v1.1.6**——改善頁面層級繁中偵測取樣。優先從 `<article>` → `<main>` → `[role="main"]` 取樣，只有都找不到時才 fallback 到 `document.body`，大幅減少 sidebar / nav 文字污染偵測結果。

**v1.1.5**——移除黑名單 + 重新命名白名單。黑名單從未實作任何邏輯，移除設定頁 UI、storage 預設值與匯入驗證；「白名單」面向使用者的文字全部改為「自動翻譯網站」。

**v1.1.4**——修正白名單自動翻譯邏輯。v1.1.2 誤將 `autoTranslate` 當作「全域自動翻譯所有網站」的開關；正確邏輯為 `autoTranslate` 是白名單功能的總開關——開啟時才去查 `domainRules.whitelist`，網域命中才翻譯。

**v1.1.3**——Toast 自動關閉選項。設定頁新增「翻譯完成後自動關閉通知」checkbox，預設開啟；開啟時翻譯完成的 success toast 在 5 秒後自動消失。設定 `toastAutoHide`。

**v1.1.2**——修正白名單自動翻譯首次載入不生效。將比對邏輯抽為共用 `isDomainWhitelisted()` helper，並在 content script 初始化末尾新增自動翻譯檢查。

**v1.1.1**——修正 Toast 預設透明度。v1.0.31 changelog 記載預設透明度改為 70%，但 `lib/storage.js` 的 `DEFAULTS.toastOpacity` 漏改仍為 0.9；本版修正為 0.7。

---

## v1.0.x

**v1.0.31**——Toast 位置選項與預設透明度調整。設定頁「翻譯進度通知」新增「顯示位置」下拉選單（右下角/左下角/右上角/左上角，預設右下角）；Toast 預設透明度從 90% 改為 70%。

**v1.0.30**——用量紀錄表格顯示 cache hit rate。Tokens 欄位下方新增小字 `(XX% hit)` 顯示 Gemini implicit cache 命中率（命中率為 0 時不顯示）。

**v1.0.29**——固定術語表與術語表 Tab。新增「術語表」Tab，包含「固定術語表」（使用者手動指定，全域通用 + 網域專用兩層）與「自動術語擷取」。固定術語優先級最高，注入 system prompt 時放在自動擷取術語之後。儲存在 `chrome.storage.sync` 的 `fixedGlossary` 欄位。

**v1.0.28**——設定頁拆分。原「設定」Tab 拆為「一般設定」與「Gemini」兩個 Tab。Tab bar 變為四個：一般設定 | Gemini | 用量紀錄 | Log。

**v1.0.27**——設定頁術語表區塊加入預設不開啟說明與 README 連結 + README 大幅擴充文件（API Key 申請教學連結、Rate Limit 參考表格、術語表詳細說明、翻譯快取與費用計算段落）。

**v1.0.26**——擴充 `window.__shinkansen` 測試 API。新增 `setTestState()`、`testRunContentGuard()`、`testGoogleDocsUrl()`，`getState()` 增加 `translating`/`stickyTranslate`/`guardCacheSize` 欄位。

**v1.0.25**——設定頁標題下方加入 README 連結 + README 加入 PERFORMANCE.md 超連結。

**v1.0.24**——設定頁 API Key 欄位加入申請教學連結，指向 GitHub repo 的 `API-KEY-SETUP.md`。

**v1.0.23**——SPA 續翻模式。新增 `STATE.stickyTranslate` 旗標：`translatePage()` 完成時設為 true，`restorePage()` 時設為 false，`resetForSpaNavigation()` 保留不清。`handleSpaNavigation()` 優先檢查 stickyTranslate，命中時直接呼叫 `translatePage()`。新增 `hashchange` 事件監聽（Gmail 使用 hash-based 路由）。

**v1.0.22**——排除 ARIA grid 資料格翻譯。`EXCLUDE_ROLES` 新增 `grid`——Gmail inbox 的 `<table role="grid">` 是典型案例。同時新增「grid cell leaf text」補抓 pass——排除整個 td 後回頭掃描 grid cell 內部的純文字 leaf 元素個別翻譯主旨 span。

**v1.0.21**——頁面層級繁中偵測設定化。設定頁新增「語言偵測」區段，提供「跳過繁體中文網頁」checkbox，預設開啟。設定 `skipTraditionalChinesePage`。

**v1.0.20**——Content Guard 架構簡化。刪除 mutation 觸發的路徑 A、刪除 cooldown 機制，只留每秒一次的週期性掃描（`contentGuardInterval`，1 秒間隔）。`runContentGuard()` 修正：元素暫時斷開 DOM 時跳過不刪除 `STATE.translatedHTML` 條目；Guard 掃描只修復可見/即將可見的元素（視窗上下各 500px 緩衝）。

**v1.0.19**——精準化冷卻機制分離覆寫偵測與新內容偵測。重構為雙路徑架構：路徑 A「覆寫偵測」受 `guardSuppressedUntil` 冷卻控制，路徑 B「新內容偵測」永遠活躍但排除已翻譯元素內部的 mutations。

**v1.0.18**——修正 Content Guard 與 rescan 互相觸發迴圈。新增 `mutationSuppressedUntil` 冷卻時間戳，Content Guard 還原或 rescan 注入完成後設定 2 秒冷卻期，冷卻期間 observer 忽略所有 mutations。

**v1.0.17**——Toast 透明度設定。設定頁新增「Toast 提示」區段，提供 10%–100% 的透明度滑桿，預設 90%；設定 `toastOpacity`。

**v1.0.16**——提高 anchor 偵測最短文字門檻。獨立 `<a>` 元素的偵測門檻從 12 字元提高至 20 字元，避免 v1.0.15 移除 NAV 硬排除後主選單短項目被翻譯。

**v1.0.15**——移除 `<nav>` / `role="navigation"` 硬排除。`<nav>` 從 `SEMANTIC_CONTAINER_EXCLUDE_TAGS` 移除、`navigation` 從 `EXCLUDE_ROLES` 移除——Engadget 等網站的 `<nav>` 裡含有使用者想看的內容（趨勢文章標題、麵包屑）。同時移除已不再需要的 `isContentNav()` 白名單機制。

**v1.0.14**——內容守衛機制防止框架覆寫譯文。新增 `STATE.translatedHTML` Map 在翻譯注入時快取每個元素的譯文 HTML；spaObserver 的 mutation 回調新增「是否有 mutation 落在已翻譯節點內」偵測，命中時排程 `runContentGuard()`。

**v1.0.13**——修正無限捲動網站翻譯消失問題。Engadget 等無限捲動網站在捲動時用 `history.replaceState` 更新網址列，被誤判為頁面導航；修法：`replaceState` handler 只靜默同步 `spaLastUrl` 而不觸發導航重設，URL 輪詢新增「已翻譯且 DOM 中仍有 `data-shinkansen-translated` 節點」判斷。

**v1.0.12**——heading 豁免 widget 檢查。`isInteractiveWidgetContainer` 新增 `WIDGET_CHECK_EXEMPT_TAGS` 常數，H1-H6 與 PRE 統一豁免——Substack 等平台在 heading 內嵌入 anchor link 圖示按鈕，觸發 widget 偵測導致整個標題被跳過。

**v1.0.11**——SPA 導航 URL 輪詢 safety net。部分 SPA 框架（如 React Router）在 module 初始化時快取 `history.pushState` 原始參照，content script 的 monkey-patch 攔不到；新增每 500ms URL 輪詢偵測 `location.href` 變化，作為 history API 攔截的 safety net。

**v1.0.10**——排除 contenteditable/textbox 表單控制項。`isInsideExcludedContainer` 新增 `contenteditable="true"` 與 `role="textbox"` 祖先排除——Medium 等網站的留言輸入框用 `<div contenteditable>` 而非 `<textarea>`，翻譯 placeholder 文字會破壞表單互動。

**v1.0.9**——主要內容區域內 footer 放行。`isContentFooter` 新增「footer 有 `<article>` 或 `<main>` 祖先」判斷——CSS-in-JS 網站如 New Yorker 把文章附屬資訊放在 `<main>` 內的 `<footer>` 元素中，應納入翻譯。

**v1.0.8**——`<pre>` 條件排除。將 `<pre>` 從硬排除改為條件排除——僅含 `<code>` 子元素時視為程式碼區塊跳過，不含 `<code>` 的 `<pre>` 視為普通容器。同時豁免 `<pre>` 的 `isInteractiveWidgetContainer` 檢查。新增「leaf content DIV」補抓 pass——CSS-in-JS 框架以 `<div>` 取代 `<p>` 的純文字容器（無 block 祖先、無 block 後代、無子元素、文字 ≥ 20 字）納入翻譯。

**v1.0.7**——Google Docs 翻譯支援。偵測 Google Docs 編輯頁面自動導向 `/mobilebasic` 閱讀版，在標準 HTML 上執行翻譯並自動觸發。

**v1.0.6**——manifest description 修正與文件重構（SPEC.md v1.0 重寫、README.md 重寫、測試流程說明更新）。

**v1.0.5**——修正用量頁面無資料。

**v1.0.4**——程式碼重構與效能最佳化。ES module 化、handler map、debounce storage 寫入。

**v1.0.3**——編輯譯文模式。

**v1.0.2**——每批段數/字元預算改為設定頁選項。

---

## 早期版本（v0.x）

**穩定性與防護（v0.76–v0.88）**：自動語言偵測（跳過已是目標語言的頁面）、離線偵測、翻譯中止（AbortController）、超大頁面段落上限（MAX_TOTAL_UNITS）、SPA 支援（pushState/replaceState 偵測 + MutationObserver）、延遲 rescan、Debug Bridge（main world ↔ isolated world CustomEvent 橋接）、Log 系統（記憶體 buffer 1000 筆 + 設定頁 Log 分頁）。

**UI 與設定（v0.60–v0.99）**：設定頁全面重構（模型管理、計價連動、Service Tier、Thinking 開關、匯入匯出驗證）、Popup 面板（快取/費用統計、術語表開關）、Toast 成本顯示（implicit cache 折扣後實付值）、用量追蹤（IndexedDB + 圖表 + CSV 匯出）。

**全文術語表一致化（v0.69 起）**：翻譯長文前先呼叫 Gemini 擷取專有名詞對照表，注入所有翻譯批次的 systemInstruction。依文章長度三級策略（短文跳過、中檔 fire-and-forget、長文阻塞等待）。術語表快取（`gloss_` prefix）。設定頁術語表區塊。

**並行翻譯與 Rate Limiter（v0.35 起）**：三維滑動視窗 Rate Limiter（RPM/TPM/RPD）、Priority Queue Dispatcher、並行 concurrency pool（`runWithConcurrency`）、429 指數退避 + `Retry-After` 尊重、tier 對照表（Free/Tier1/Tier2）、設定頁效能與配額區塊。

**段落偵測與注入重構（v0.29–v0.58）**：mixed-content fragment 單位、字元預算 + 段數上限雙門檻分批、`<br>` ↔ `\n` round-trip（sentinel 區分語意換行與排版空白）、三條注入路徑統一為 `resolveWriteTarget` + `injectIntoTarget`、slot 重複 graceful degradation（`selectBestSlotOccurrences`）、MJML/Mailjet email 模板 `font-size:0` 相容、媒體保留策略。

**基礎翻譯（v0.13–v0.28）**：單語覆蓋顯示、手動翻譯（Popup 按鈕 + Option+S 快捷鍵）、自動翻譯白名單、Gemini REST API 串接、翻譯快取（SHA-1 key）、還原原文、佔位符保留行內元素（`⟦N⟧…⟦/N⟧` 配對型 + `⟦*N⟧` 原子型）、巢狀佔位符遞迴序列化/反序列化、腳註參照原子保留、CJK 空白清理、技術元素過濾、佔位符密度控制。
