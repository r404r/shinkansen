# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Cowork 端** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步)
>   - **Claude Code 端** 跑完 `npm test` 全綠後若本檔非空,必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

### vBulletin td.alt1 翻譯後標題 div 消失 — 待 Cowork 端 Chrome MCP 診斷
- **症狀**：forum.miata.net 貼文頁翻譯後，`<div class="smallfont hideonmobile">` 標題 div 整個被吃掉（DOM 內不見），但 HR 與 post_message div 維持原位
- **來源 URL**：https://forum.miata.net/vb/showthread.php?t=800453（任一 thread 應該都重現）
- **初步 DOM 對照**（Jimmy 2026-04-19 DevTools 截圖）：
  - 翻譯前：`td.alt1` 子節點 = `[comment] [div.smallfont.hideonmobile] [hr.hideonmobile] [comment] [comment] [div.postbitcontrol2] [comment]`
  - 翻譯後：`td.alt1` 子節點 = `[comment] [hr.hideonmobile] [comment] [comment] [div.postbitcontrol2] [comment]`
  - 標題 div 不見、HR 與 comment 都在、中文標題顯示在頁面（位置不明，截圖沒拍到）
- **推論**：這不是 v1.4.10 HR 那個 bug。是 injection path 在 td 整段翻譯時，把「標題 div」從子節點 list 移除但中文沒正確填回原位置。可能走了不是 clean slate 的某條注入路徑
- **為什麼還沒修**：要在 Cowork 端用 `mcp__Claude_in_Chrome__*` 實地看 inject 後中文標題實際 DOM 位置 + 哪條 injection path 被觸發才能找到結構性通則。Claude Code 端無 Chrome MCP，純靠 console 輸出推理容易走偏
- **建議 spec 位置**：`test/regression/inject-vbulletin-title-div.spec.js`
- **下次動手時**：切 Cowork，用 Chrome MCP navigate 到該 URL，翻譯前後各抓 `document.getElementById('td_post_XXXXXX').outerHTML`，觀察譯文中文標題掛在哪個節點上，再決定修法（絕對不能加「站點特判」，必須找結構性通則——硬規則 8）

### v1.4.12 — 2026-04-19 — 三組 preset 快速鍵 + 統一取消邏輯
- **新功能不是 bug**：manifest commands 改成 `translate-preset-1/2/3`（Alt+A/S/D），各自對應 `translatePresets` storage 中的一組 `{engine, model, label}`。閒置按 → 啟動該 preset；翻譯中按任一鍵 → abort；已翻譯按任一鍵 → `restorePage`。v1.4.11 sticky 的 storage schema 從 `engine` 字串改存 `slot` number，新 tab 繼承相同 preset。
- **修在**：
  - `manifest.json`：commands 全換
  - `lib/storage.js`：`DEFAULT_SETTINGS.translatePresets` 預設三組
  - `background.js`：`onCommand` 解析 `translate-preset-N` 派送 `TRANSLATE_PRESET {slot}`；`TRANSLATE_BATCH` handler 接受 `payload.modelOverride`；`handleTranslate` 加 `cacheTag` 參數；`stickyTabs` Map value 改存 slot；三個 STICKY_* handler 更新
  - `content.js`：新增 `handleTranslatePreset(slot)` 統一入口（掛 `SK.handleTranslatePreset`），`SK.translatePage(options)` / `SK.translatePageGoogle(gtOptions)` 接受 `{modelOverride, slot}`，`SK.translateUnits` 把 modelOverride 塞進 `TRANSLATE_BATCH` payload
  - `content-ns.js`：STATE 加 `stickySlot`
  - `content-spa.js`：SPA 續翻讀 `STATE.stickySlot` 優先呼叫 `SK.handleTranslatePreset`
- **為什麼還沒寫測試**：
    完整驗證需要 (1) Chrome 真實 `browser.commands.onCommand` 觸發，Playwright extension fixture 無法直接模擬鍵盤快速鍵；(2) 跨 tab `openerTabId` 繼承同 slot 行為（v1.4.11 PENDING 未解的測試延伸到 slot）；(3) 已翻譯 / 翻譯中 / 閒置三分支 × 三個 slot = 9 種行為組合 × 兩種 engine。純 mock chrome.commands API 的 jest-unit 可以寫，但多半只驗 mock 到 mock 的 roundtrip，價值有限。
- **建議 spec 位置**：`test/regression/preset-hotkey-behavior.spec.js`（Playwright 用 `chrome.tabs.sendMessage` 模擬 `TRANSLATE_PRESET` 訊息進 content script，驗三分支行為）+ `test/jest-unit/storage-translatepresets.test.cjs`（驗 `DEFAULT_SETTINGS.translatePresets` 預設值 + merge 行為）
- **建議 spec 流程**：
    1. mock `chrome.runtime.sendMessage` 攔 `TRANSLATE_BATCH`，驗 `payload.modelOverride` 依 slot 填入對的 model
    2. 閒置送 `TRANSLATE_PRESET {slot:1}` → `STATE.translated` 變 true，`STATE.stickySlot === 1`
    3. 已翻譯（STATE.translated=true）送 `TRANSLATE_PRESET {slot:2}` → 應 `restorePage`（`STATE.translated` 回 false，不管 slot=幾）
    4. 翻譯中（STATE.translating=true）送 `TRANSLATE_PRESET {slot:3}` → `STATE.abortController.abort` 被呼叫
    5. `TRANSLATE_PRESET {slot:3}` 走 Google engine → mock `TRANSLATE_BATCH_GOOGLE` 被呼叫而非 `TRANSLATE_BATCH`
- **sanity check 思路**：把 `handleTranslatePreset` 裡「已翻譯 → restorePage」那段 gate 成 `if (false)` → 已翻譯按快捷鍵變成不動作，spec 應 fail

### v1.4.11 — 2026-04-19 — 跨 tab sticky 翻譯
- **新功能不是 bug**：使用者在 tab A 按 Option+S 翻譯後，從 A 點連結（含 Cmd+Click / `target="_blank"` / `window.open`）開新 tab B → B 自動翻譯並繼承 sticky；新 tab 再開新 tab 也繼續。restorePage 只清當前 tab。
- **修在**：`shinkansen/background.js`（`stickyTabs` Map + `chrome.storage.session` 持久化 + `onCreated`/`onRemoved` listener + 三個訊息 handler）、`shinkansen/content.js`（translatePage / translatePageGoogle 成功後送 `STICKY_SET`、restorePage 送 `STICKY_CLEAR`、初始化階段送 `STICKY_QUERY` 自動翻譯）
- **為什麼還沒寫測試**：
    完整驗證需要 (1) 真實 Chrome 開新 tab 觸發 `chrome.tabs.onCreated` 並帶 `openerTabId`、(2) 攔截新 tab 的 content script 載入並 mock 其 `TRANSLATE_BATCH`、(3) 跨 page 驗證自動翻譯。Playwright extension fixture 可以做但模板與既有 single-page regression spec 差異大。純 mock chrome.tabs API 的 jest-unit test 可寫但只驗到 mock 行為，無法保證 Chrome 真實 onCreated 帶 openerTabId 的時序與 hydrate 互動正確。
- **建議 spec 位置**：`test/regression/sticky-cross-tab.spec.js`（Playwright e2e）+ 可選 `test/jest-unit/background-sticky-tabs.test.cjs`（純 background 邏輯 mock unit）
- **建議 spec 流程**：
    1. Page A goto fixture，mock `chrome.runtime.sendMessage` 攔 `TRANSLATE_BATCH` 回固定譯文
    2. evaluate `window.__shinkansen.translate()` 等 `STATE.translated === true`
    3. 在 A 上 evaluate `window.open('/sticky-target.html', '_blank')` 或 click `<a target="_blank">`，搭配 `context.waitForEvent('page')` 拿到 page B
    4. 等 B 的 content script 載入並完成自動翻譯（輪詢 `STATE.translated`）
    5. 斷言：B 的 segment 文本變成譯文、B `STATE.translatedBy` === 'gemini'
    6. 開「無 opener」的 page C（直接 `context.newPage()` + goto）→ 不應自動翻譯
    7. 在 B 上 RESTORE → A 仍然 translated（per-tab 獨立）
- **sanity check 思路**：把 `background.js` 的 onCreated listener 內 `if (!engine) return;` 改成 `return;` 強制不繼承 → page B 不會自動翻譯，spec 應 fail

### ~~v1.4.9 Case B 偵測~~ — 已實作並補測試 → `test/regression/detect-bbcode-div-text.spec.js`（Case B 測試）
（v1.4.8 試過的 else 分支太寬鬆已回退；v1.4.9 改為 4 重條件全成立才匹配——CONTAINER_TAGS 白名單（DIV/SECTION/ARTICLE/MAIN/ASIDE）+ 至少一個直接 `<br>` + 直接 TEXT >= 20 字 + isCandidateText。新 stats 計數 `containerWithBr` 作 forcing function。SANITY 通過：移除 else if 整段後，Case B fail / Case A 仍 pass / 3 條原本被踩的 spec 也仍 pass。）

### ~~v1.4.8 inject path~~ — 已補測試 → `test/regression/inject-fragment-no-slots-newline.spec.js`
（fragment unit + slots=[] + 含字面 `\n` 譯文，呼叫 `SK.injectTranslation` 後驗證 brCount=1 / 無字面 `\n` 殘留 / 無真正換行符 / 兩段中文都出現。SANITY 通過：(i) 移除入口 `\\n→\n` 規範化 → hasLiteralBackslashN=true fail；(ii) 移除無 slots 分支 `\n→<br>` 還原 → hasRealNewline=true fail。實測過後還原。）

### ~~v1.0.7~~ — 已補 URL 解析測試 → `test/regression/pure-gdoc-url.spec.js`
（注：跨分頁導向流程 `chrome.tabs.create()` + `tabs.onUpdated` 未涵蓋，需未來 E2E 測試）

### ~~v1.0.11~~ — 已補 Jest 單元測試 → `test/jest-unit/spa-url-polling.test.cjs`
（注：3 條測試涵蓋基本偵測、捲動跳過、sticky 覆蓋。Playwright E2E 的 pushState 競態重現未涵蓋）

### ~~v1.0.13+v1.0.14~~ — 已補 Content Guard 核心邏輯測試 → `test/regression/guard-content-overwrite.spec.js`
（注：「捲動觸發覆寫」的完整 Engadget IntersectionObserver 流程未涵蓋，但 guard 的核心邏輯——快取比對 + innerHTML 修復——已鎖死）

### ~~v1.0.18→v1.0.19~~ — 已關閉，不需要測試
v1.0.20 將 Content Guard 從「MutationObserver 觸發」重構為「setInterval 每秒週期性掃描」，
迴圈在架構層面不可能發生（guard 不再由 mutation 觸發，兩者徹底脫鉤）。
要讓此 bug 回歸，必須把 guard 改回 mutation-triggered 架構——這是重大設計變更，不是手滑就會發生。
且「驗證某件事沒有無限發生」天生是弱斷言，寫出來的測試保護力有限。

### ~~v1.0.16~~ — 已補測試 → `test/regression/detect-nav-anchor-threshold.spec.js`

### ~~v1.0.20~~ — guard 核心邏輯已由 `guard-content-overwrite.spec.js` 涵蓋
（注：Facebook 虛擬捲動的「元素暫時斷開 DOM 再接回」場景未涵蓋——需要模擬 `el.remove()` + `parent.appendChild(el)` + 覆寫 innerHTML，驗證快取未被刪除。可在未來擴充 guard-content-overwrite.spec.js 加第二個 test case）

### ~~v1.0.23~~ — 已補 Jest 單元測試 → `test/jest-unit/spa-sticky-translate.test.cjs`
（注：3 條測試涵蓋 hashchange+sticky 觸發 translatePage、非 sticky 不觸發、restorePage 關閉 sticky。使用 jsdom + chrome API mock，不動 production code）

### ~~v1.0.21+v1.0.22~~ — 已補偵測測試 → `test/regression/detect-grid-cell-leaf.spec.js`
（注：排版修正部分——CSS `br { display: none }` + flex 單行——需要真實 CSS 環境，未涵蓋在此測試中）

### ~~v1.1.2+v1.1.4~~ — 已補 Jest 單元測試 → `test/jest-unit/whitelist-auto-translate.test.cjs`
（注：6 條測試涵蓋精確比對、萬用字元、根域名命中、不命中、autoTranslate OFF、白名單為空。
未抽 pure function，改用 create-env 模式直接 eval content.js + mock chrome.storage 來測試
isDomainWhitelisted + 首次載入自動翻譯的整合行為）

### ~~v1.1.6~~ — 已補 Jest 單元測試 → `test/jest-unit/trad-chinese-article-sampling.test.cjs`
（注：3 條測試涵蓋：有 `<article>` 時 sidebar 簡體字不影響偵測、無 `<article>` fallback
到 body 時簡體字污染導致偵測失敗、`<main>` fallback 路徑。使用 create-env 模式
eval content.js + mock storage + Debug Bridge TRANSLATE 觸發 translatePage）

### ~~v1.2.65~~ — YouTube 字幕預設開啟自動翻譯 + Pro 模型說明調整（無需 regression 測試）
- **說明**：預設值變更（`autoTranslate: true`）+ 純文字修正，不影響翻譯邏輯

### ~~v1.2.64~~ — Debug 頁 toggle 說明換行 + Log 區塊標題（無需 regression 測試）
- **說明**：純 UI 排版修正，不影響翻譯邏輯

### ~~v1.2.63~~ — 修正 YouTube 設定頁自動翻譯描述文字（無需 regression 測試）
- **說明**：純文字修正，不影響任何邏輯

### ~~v1.2.62~~ — 修正用量紀錄 filter 後彙總卡片未更新（無需 regression 測試）
- **說明**：純 UI 邏輯補漏（搜尋過濾後呼叫 `updateSummaryFromRecords`），不影響翻譯邏輯；正確性可人工確認：搜尋框輸入關鍵字後，上方累計費用、Token 數、翻譯次數應跟著篩選結果更新

### ~~v1.2.61~~ — 修正用量紀錄「模型」欄折行（無需 regression 測試）
- **說明**：純 CSS 修正（`white-space: nowrap`），不影響翻譯邏輯；正確性可人工確認：用量紀錄表格「模型」欄應單行顯示（如 `3.1-flash-lite`）

### ~~v1.2.60~~ — 用量紀錄 UI 五項修正（無需 regression 測試）
- **說明**：純 UI 改動（`shortenUrl` 特判、`<a>` 連結、搜尋框、datetime-local），不影響翻譯邏輯；正確性可人工確認：開啟設定頁「用量紀錄」分頁，確認 YouTube 影片 URL 顯示 `/watch?v=...`、URL 可點擊、搜尋框過濾正常、篩選器可選時間（含小時分鐘）

### ~~v1.2.59~~ — debug 面板 buffer seek 後顯示虛假正值（無需 regression 測試）
- **說明**：純 debug 顯示邏輯調整（`bufStr` 增加 `translatingWindows`/`translatedWindows` 狀態判斷），不影響翻譯行為；正確性可人工確認：開啟 debug 面板後拖動進度條到未翻範圍，buffer 欄應顯示「翻譯中…」直到 API 完成，之後恢復顯示 `+Xs ✓`

### ~~v1.2.58~~ — seek 後「翻譯中…」提示不消失（無需 regression 測試）
- **說明**：`hideCaptionStatus` 冪等呼叫位置調整（從 `!_firstCacheHitLogged` 條件內移出），不影響翻譯邏輯；正確性可人工確認：Alt+S 啟動後拖動進度條到未翻範圍，等中文字幕出現後「翻譯中…」應立即消失

### ~~v1.2.57~~ — 拖動進度條後字幕區未顯示「翻譯中…」（無需 regression 測試）
- **說明**：純 UI 補漏（`onVideoSeeked` 加 `showCaptionStatus` 呼叫），不影響翻譯邏輯；正確性可人工確認：Alt+S 啟動後拖動進度條到未翻範圍，字幕區應立即出現「翻譯中…」提示，第一條中文字幕出現後自動消失

### ~~v1.2.56~~ — batch 0 先 await 暖熱 cache（無需 regression 測試）
- **說明**：純翻譯排程改動（`Promise.all` 拆為 serial batch 0 + parallel batch 1+），效能差異（第一視窗 ~13s → ~3.5s）依賴 Gemini implicit cache 冷暖狀態，無法在靜態 fixture 中重現；正確性可從「reload extension + refresh YouTube 頁面，第一次翻譯字幕出現速度明顯比舊版快」人工確認

### ~~v1.2.55~~ — 字幕區載入提示（無需 regression 測試）
- **說明**：純 UI 改動（toast → caption status 注入），不影響翻譯邏輯；正確性可人工確認：Alt+S 後應看到「翻譯中…」出現在字幕區（有英文字幕時在其正上方），第一條中文字幕出現後自動消失

### ~~v1.2.54~~ — 並行視窗翻譯 translatingWindows Set（無需 regression 測試）
- **說明**：核心改動是移除 boolean 互斥鎖、改為 per-window Set 防重入。行為差異（英文字幕間隙消除）只在慢 API（冷啟動 10-15s）下才能觸發，靜態 fixture 無法模擬；對照之下，`translatedWindows.has(startMs)` 跳過邏輯（v1.2.48）已由現有 seek-back 相關邏輯涵蓋；並行啟動下不重複翻同一視窗的正確性可人工確認（reload + 播放後觀察 debug 面板 `translating` 欄位是否顯示多個視窗同時在進行）

### ~~v1.2.53~~ — Observer 提前啟動（無需 regression 測試）
- **說明**：單行位移（`startCaptionObserver()` 移至 `await translateWindowFrom()` 之前），不涉及邏輯分支變更；正確性可從「reload 後首條中文字幕出現時間 < 3s」人工確認；原有 MutationObserver 行為完全不變

### ~~v1.3.0~~ — YouTube 字幕翻譯里程碑版本跳躍 + 文件修正（無功能變更，無需 regression 測試）
- **說明**：版本號從 1.2.65 跳至 1.3.0 標記 YouTube 字幕翻譯里程碑；同時修正 SPEC.md 五處文件錯誤（domainRules blacklist、缺少設定欄位、Log→Debug 分頁名稱、Popup YouTube toggle、Toast 自動關閉行為描述）。無 `shinkansen/` 程式碼改動，不需要 regression spec

### ~~v1.2.52~~ — Log 持久化（無需 regression 測試）
- **說明**：純基礎設施改動（新增 chrome.storage.local 持久化 + Debug Bridge actions），不影響翻譯行為；正確性可在 reload extension 後透過 Debug Bridge `GET_PERSISTED_LOGS` 確認有無保留前次 youtube/api log 條目

### ~~v1.2.51~~ — 字幕效能診斷 Log 強化（無需 regression 測試）
- **說明**：純新增 log 條目，不影響翻譯行為，不需要 regression spec

### ~~v1.2.50~~ — 自適應首批大小（無需 regression 測試）
- **說明**：純邏輯改動（batch 0 條數依 leadMs 動態決定），行為差異（第一條字幕出現時間）難以在靜態 fixture 中驗證；正確性可從 debug 面板的 `batch0 size` 欄位人工確認

### ~~v1.2.49~~ — 設定頁 UI 調整 + on-the-fly toggle（無需 regression 測試）
- **說明**：純 UI 重組（tab 改名、toggle 搬移、新增 toggle）+ storage 預設值變更；on-the-fly 開關的正確性可從「關閉後 captionMap miss 不再送 API」的 Log 確認，邏輯極簡（一個 if return），不值得寫 spec

### ~~v1.3.1~~ — 已補測試 → `test/regression/youtube-spa-navigate.spec.js`
（override `isYouTubePage` + mock `translateYouTubeSubtitles`，dispatch `yt-navigate-finish`，等 750ms，確認 spy 被呼叫 1 次且 `YT.active === true`）

### ~~v1.2.48~~ — 已補測試 → `test/regression/youtube-translated-window-skip.spec.js`
（mock `chrome.runtime.sendMessage`，塞入 rawSegments 後呼叫 `translateYouTubeSubtitles` 翻 window 0，再 dispatch `seeked` 事件確認 `TRANSLATE_SUBTITLE_BATCH` 計數不增加。sanity check 通過：註解掉 L376 的 `if (YT.translatedWindows.has(windowStartMs)) return;` 後 batch 計數從 2 變 4，測試正確 fail）

### ~~v1.2.7~~ — 已補測試 → `test/regression/youtube-onthefly-observer.spec.js`
（mock `chrome.runtime.sendMessage`，啟動 `translateYouTubeSubtitles`（空 rawSegments 走 else 分支觸發 `startCaptionObserver`），覆寫 `YT.config.onTheFly = true`，動態 appendChild `.ytp-caption-segment` 至 `.ytp-caption-window-container`，等 500ms 涵蓋 300ms flush timer + sendMessage resolve + DOM 寫回，確認 `TRANSLATE_SUBTITLE_BATCH` 被呼叫、`captionMap` 填入且 span `textContent` 被替換。sanity check 通過：在 `replaceSegmentEl` 的 on-the-fly guard 後多加 `return;`，`batchCount` 降為 0，測試 fail）

### ~~v1.2.5~~ — 2026-04-15 — YouTube 字幕翻譯 MVP 尚無自動化測試
- **症狀**：新功能，尚無 regression spec 涵蓋
- **來源 URL**：任意有英文字幕的 YouTube 影片（例如 https://www.youtube.com/watch?v=dQw4w9WgXcQ）
- **修在**：`shinkansen/content-youtube.js`（新增）、`shinkansen/content.js`（translatePage 加 YouTube 分流）
- **為什麼還不能寫 Playwright 測試**：
    YouTube 的 `ytInitialPlayerResponse` 是由 YouTube JS 寫入的 main world 全域變數，在 Playwright fixture 中需要模擬此物件並搭配字幕 API 的 mock fetch 才能重現完整流程。此外，字幕翻譯透過 `TRANSLATE_BATCH` 訊息走背景 service worker，需要在測試環境中 mock Gemini API 回應。時序控制（等待翻譯完成 → 觸發字幕播放 → 確認 MutationObserver 置換）複雜，目前 regression 框架未支援跨 main world + isolated world 的 CustomEvent 橋接測試。
- **建議 spec 位置**：`test/regression/youtube-subtitle-translate.spec.js`
- **建議 fixture 結構**（已知觸發條件）：
    ```html
    <script>
      window.ytInitialPlayerResponse = {
        videoDetails: { videoId: 'test123' },
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{
              languageCode: 'en',
              baseUrl: '/mock-captions.json',
              name: { simpleText: 'English' }
            }]
          }
        }
      };
    </script>
    <div class="ytp-caption-window-container">
      <span class="ytp-caption-segment">Hello, world!</span>
    </div>
    ```
    測試斷言：mock `TRANSLATE_BATCH` 回傳 `['你好，世界！']`，啟動翻譯後 `.ytp-caption-segment` 的 textContent 應變為「你好，世界！」

### ~~v1.2.25~~ — 已修正 → v1.2.26（強制 CC toggle 重新觸發 XHR）

### ~~v1.4.2 + v1.4.3~~ — 已補測試 → `test/regression/google-translate-format-preserve.spec.js`（test #2 + #3）
（共用 fixture `google-translate-complex-paragraph.html`，Wikipedia lede 樣式：B+I+A+A+SPAN+SMALL 同段。Test #2 直接呼叫 `SK.serializeForGoogleTranslate` 驗證 slotCount=5 / slotTags=['B','I','A','A','SMALL'] / span 內文進 text 但不加標記 / class 屬性不洩漏。Test #3 走 end-to-end mock `TRANSLATE_BATCH_GOOGLE`：回傳保留 5 個 `【N】` 標記的中文譯文，注入後驗證 b/i/a×2/small 全部保留正確中文 + href，span 不被重建（DOM 內 `<span>` count=0），無可見 `【】`/`⟦⟧` 殘留。SANITY 通過：把 `SPAN` 加入 `GT_INLINE_TAGS` 後 test #2 fail；把 `restoreGoogleTranslateMarkers(tr)` 改成 `tr` 後 test #3 fail。原 PENDING 提到的「需要 fetch mock」其實是誤判——v1.4.1 已驗證 mock `chrome.runtime.sendMessage` 就足夠，根本不用攔 `translate.googleapis.com`。）

### ~~v1.4.1~~ — 已補測試 → `test/regression/google-translate-format-preserve.spec.js`
（mock `chrome.runtime.sendMessage` 攔截 `TRANSLATE_BATCH_GOOGLE`，回傳含 `【0】東京旅遊指南【/0】` 的譯文，呼叫 `SK.translateUnitsGoogle` 後驗證 `<a>` 與 `href` 仍存在、文字為「東京旅遊指南」、DOM 不留可見 `【】`/`⟦⟧`。Sanity 通過：移除 swap-back regex 後 linkCount=0，可見 `【0】` 殘留，測試 fail）

### ~~v1.4.0~~ — 已補測試 → `test/unit/google-translate-batch.spec.js`
（mock `globalThis.fetch` 直接 import ES module；驗證 SEP 串接、URL 長度分塊、空陣列、多批次 result 依 idx 寫回。Sanity 通過：把切批條件改成 `false` 後「長文字 → ≥2 次 fetch」斷言 fail。原 PENDING 提到的 Jest ESM 限制未實際阻礙——Playwright spec 直接走 `await import()` 即可，不需要動 jest 設定）

### v1.2.47 — 2026-04-16 — 字幕 BATCH_SIZE 20→8（無需 regression 測試）
- **說明**：常數變更，正確性已由現有字幕翻譯流程涵蓋，效果差異需人工觀察 debug 面板確認

### v1.2.46 — 2026-04-16 — 向後拖進度條修正（無需 regression 測試）
- **說明**：`onVideoSeeked` 行為變更 + `captionMapCoverageUpToMs` 防重複翻譯；seek 行為需要真實 video element，難以在靜態 fixture 中驗證

### v1.2.45 — 2026-04-16 — 過期視窗追趕機制（無需 regression 測試）
- **說明**：防禦性安全網，正常運作時不觸發；觸發條件（API > windowSize + adaptLook ≈ 56s）在真實使用中極難重現，難以寫自動化測試

### v1.2.44 — 2026-04-16 — 自適應 lookahead（無需 regression 測試）
- **說明**：觸發時機邏輯變更，依賴 real-time API 耗時，難以在靜態 fixture 中驗證；行為正確性可透過 debug 面板 `adapt look` 欄位人工確認

### v1.2.43 — 2026-04-16 — debug 面板各批次耗時（UI 變更，無需 regression 測試）
- **說明**：純 debug 顯示邏輯，不影響翻譯正確性，不需要 regression spec

### ~~v1.2.42~~ — 已補測試 → `test/regression/youtube-streaming-inject.spec.js`
（mock `chrome.runtime.sendMessage` 以 call 序號決定延遲：batch 0=10ms、batch 1=50ms、batch 2=500ms；塞 17 條 rawSegments 切成 [1,8,8]，呼叫 `translateYouTubeSubtitles` 不 await，200ms 後 captionMap 應有 batch 0+1 的 9 條 entries、batch 2 尚未完成。sanity check 通過：把 `_runBatch` .then 裡 `captionMap.set` 區塊 gate 成 `if (b === 0)`，captionMap.size 降到 1 測試 fail）

### ~~v1.2.41~~ — 已補測試 → `test/regression/youtube-parallel-batches.spec.js`
（mock `chrome.runtime.sendMessage` 固定 100ms 延遲 + 記錄呼叫時間戳；17 條 rawSegments 切成 [1,8,8]，呼叫 `translateYouTubeSubtitles`，斷言 batch 2 呼叫時間 - batch 1 呼叫時間 < 50ms。sanity check 通過：把 `await Promise.all(batches.slice(1).map(...))` 改成 for-await 循序後，gap12 從 ~1ms 變 ~102ms 測試 fail）

### ~~v1.2.1~~ — 已補測試 → `test/regression/spa-observer-widget-loop.spec.js`
（mock `SK.translateUnits` 計算呼叫次數，fixture 含 setInterval 每秒重設 widget innerHTML，等 4.5s，確認呼叫次數 ≤ 2）

<!--
條目格式範例(實際加入時把上面那行 placeholder 刪掉):

### v0.60 — 2026-04-12 — 簡短描述 bug
- **症狀**:Jimmy 觀察到的現象 (例如「Substack 卡片標題被吃掉變空字串」)
- **來源 URL**:https://example.com/some-page (若為公開頁面)
- **修在**:shinkansen/content.js 的 XX 函式 / commit hash
- **為什麼還不能寫測試**:
    例:還沒抽出最小重現結構;原頁面太複雜、含三層 wrapper + 動態載入,
    需要再觀察是哪個 attribute 是真正觸發條件
- **建議 spec 位置**:test/regression/inject-substack-title.spec.js
- **建議 fixture 結構**(若已知):
    ```html
    <article>
      <h2 class="...">
        <span>...</span>
      </h2>
    </article>
    ```
-->
