# Pending Regression Tests

> **這是什麼**：待補的 regression test 清單。每筆代表「bug 已修但對應的
> regression spec 還沒寫」(對應 CLAUDE.md 硬規則 9 的路徑 B fallback)。
>
> **誰會讀**：
>   - **Claude Code** 每次新對話會檢查本檔,若非空必須在第一句話提醒 Jimmy
>     (CLAUDE.md「開始新對話時的標準動作」第 4 步);跑完 `npm test` 全綠後若本檔非空,也必須主動提醒
>   - **Jimmy** 看到提醒後可以決定要立刻清,還是先繼續手上的事
>
> **怎麼清**：見 `測試流程說明.md` 的「指令 G:清 pending regression queue」。
>
> **空 queue 的判斷**：本檔只剩本段 header + 「(目前沒有 pending 條目)」
> 那行 placeholder = 空。任何在「## 條目」section 之下的內容都算待清。

---

## 條目

### v1.6.19 — `hydrateStickyTabs` 並行 race(promise lock 修法)
- **症狀**:SW 喚醒後 `_stickyStorage.get` 完成前若連開多個新 tab,後續 onCreated listener 進來時 `_stickyHydrated=true` 已 set 直接 return,但 stickyTabs Map 還空 → `stickyTabs.get(openerId)` 回 undefined → 沒繼承 sticky slot
- **修在**:`shinkansen/background.js:200-235`(`_stickyHydratingPromise` 取代 boolean flag,所有 caller `await` 同一 in-flight promise)
- **為什麼還不能寫測試**:Playwright 的 `context.newPage` 與 `window.open` 的時序受 Chromium 內部排程影響,SW wake 與 storage.session.get 完成的時間差難以可控地壓在「第二次 onCreated 進來時 await 還沒回」這個窄窗;jest-unit 用 jsdom mock 也需大幅 rewrite background.js 的 module pattern。先把實際修法 commit,觸發機率本身極低(<50ms 視窗 + 連開多 tab),靠真實使用發現幾乎不可能。
- **建議 spec 位置**:`test/jest-unit/sticky-hydrate-race.test.cjs`
- **建議 fixture 結構**(已知觸發條件):mock `chrome.storage.session.get` 回 50ms delay 的 Promise,接著兩次 `tabs.onCreated.dispatch` 各自帶 openerTabId,驗證兩次 `stickyTabs.get(openerId)` 都拿到正確 slot。

### v1.6.19 — options.js `parseUserNum` 修「`||` 把 0 當 falsy」
- **症狀**:使用者在設定頁輸入 `0`(safetyMargin / maxRetries / maxConcurrentBatches / maxUnitsPerBatch / maxCharsPerBatch / maxTranslateUnits)→ save 端 `Number(v) || default` 把 0 視為 falsy 回退預設值,使用者下次打開設定頁看到自己輸入的 0 變回預設,UI 體感 bug
- **修在**:`shinkansen/options/options.js:60-67`(新增 `parseUserNum` helper),`shinkansen/options/options.js:108-119, 463-474, 689`(load/save/reset 三處用 `??` 取代 `||`)
- **為什麼還不能寫測試**:`parseUserNum` 是 options.js 內部 helper,沒 export;options.js 走 ES module + DOM 操作,直接從 jest 載入需大量 stub(document、chrome.storage 等)。小工具函式 6 行,最壞情況也是「使用者輸入 0 看到預設」,不是資料破壞,測試效益低於投入成本。
- **建議 spec 位置**:`test/jest-unit/options-parse-user-num.test.cjs`(若要鎖,把 `parseUserNum` 抽到 `lib/format.js` 或新 `lib/parse-input.js` export 後再寫測)
- **建議 fixture 結構**:`parseUserNum('0', 20) === 0`、`parseUserNum('', 20) === 20`、`parseUserNum('abc', 20) === 20`、`parseUserNum('5.5', 20) === 5.5`

### v1.6.19 — content.js `sendMessageWithTimeout` timer leak 修法
- **症狀**:`Promise.race([sendMessage, setTimeout reject])` 結構在 sendMessage 先 settle 時不 clearTimeout,90s 後 timer 仍 fire(reject 已 settled 的 promise 被忽略,但 Error 物件 + timer 占住 90s GC)。長頁面 50+ batch 累積。
- **修在**:`shinkansen/content.js:130-158`(`sendMessageWithTimeout` helper 用 `.finally(() => clearTimeout(timer))`),兩處 `Promise.race` call site 改用 helper(content.js 的 Gemini batch 與 Google Translate batch 路徑)
- **為什麼還不能寫測試**:GC / timer 殘留難以從 page-level Playwright 觀察;若改寫成 stub `setTimeout`/`clearTimeout` 計數,等於針對實作細節寫測試,不是行為驗證。實際影響極低(微 GC 壓力,沒有功能差異),修法也夠小(包成 helper),不值得專屬測試。
- **建議 spec 位置**:不寫(走「dim 影響無自動化價值」豁免)
- **建議 fixture 結構**:N/A

### ~~vBulletin td.alt1 翻譯後標題 div 消失 / HR 位置顛倒~~ — 已修復（v1.4.14）→ `test/regression/inject-vbulletin-title-div.spec.js`
（Cowork 端 Chrome MCP 實地診斷：根因不在 detection，而在 `content-inject.js` `injectIntoTarget`——TD 含 img 觸發 `containsMedia(TD)=true` 走 media-preserving path，把 fragment 塞進最長文字節點所在的 postbitcontrol2，原 smallfont/HR 殘留於其上方。修法：target 有 CONTAINER_TAGS 直屬子元素時改走 clean-slate（`containsMedia && !hasContainerChild` 才走 media path）。SANITY 通過。這是 v1.4.14 起「UI bug 必須 Cowork 實地診斷」新流程的首發；對比前一版被 revert 的 v1.4.14（Claude Code 純推理自以為修好但真實頁面沒用），證明實地驗證規則的必要性。）

### ~~v1.4.12 preset 快速鍵~~ — 已補測試（v1.4.15）→ `test/regression/preset-hotkey-behavior.spec.js`
（5 條涵蓋 `handleTranslatePreset(slot)` 三分支 × 三 slot：idle 按 1/2/3 各自觸發對應 engine + modelOverride；translated 狀態按任一鍵 restorePage；translating 狀態按任一鍵 abort。SANITY 四種 break 對應各 test fail。策略：直接 `SK.handleTranslatePreset(slot)` 繞過真實鍵盤、stub translatePage/Google 觀察 payload。）

### ~~v1.4.11 跨 tab sticky 翻譯~~ — 已補測試（v1.4.15）→ `test/regression/sticky-cross-tab.spec.js`
（2 條：tab A STICKY_SET → `window.open` → tab B STICKY_QUERY 回同 slot；tab A STICKY_CLEAR 不影響 tab B。SANITY：註解 onCreated 繼承主體，兩條都 fail。「無 opener 不繼承」無法在 Playwright 穩定模擬——`context.newPage` 會設 opener——該保護由 `if (openerId == null) return;` guard 提供，未另寫 regression。）

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

### ~~v1.2.47~~ — 2026-04-16 — 字幕 BATCH_SIZE 20→8（無需 regression 測試）
- **說明**：常數變更，正確性已由現有字幕翻譯流程涵蓋，效果差異需人工觀察 debug 面板確認

### ~~v1.2.46~~ — 2026-04-16 — 向後拖進度條修正（無需 regression 測試）
- **說明**：`onVideoSeeked` 行為變更 + `captionMapCoverageUpToMs` 防重複翻譯；seek 行為需要真實 video element，難以在靜態 fixture 中驗證

### ~~v1.2.45~~ — 2026-04-16 — 過期視窗追趕機制（無需 regression 測試）
- **說明**：防禦性安全網，正常運作時不觸發；觸發條件（API > windowSize + adaptLook ≈ 56s）在真實使用中極難重現，難以寫自動化測試

### ~~v1.2.44~~ — 2026-04-16 — 自適應 lookahead（無需 regression 測試）
- **說明**：觸發時機邏輯變更，依賴 real-time API 耗時，難以在靜態 fixture 中驗證；行為正確性可透過 debug 面板 `adapt look` 欄位人工確認

### ~~v1.2.43~~ — 2026-04-16 — debug 面板各批次耗時（UI 變更，無需 regression 測試）
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
