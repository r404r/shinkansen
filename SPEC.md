# Shinkansen — 規格文件（SPEC）

> 一款專注於網頁翻譯的 Chrome Extension，作為 Immersive Translation 的輕量相容品。

- 文件版本：v0.9
- 建立日期：2026-04-08
- 最後更新：2026-04-09
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：0.55

---

## 0. 文件維護政策

**每次修改 Extension 的行為、UI、設定結構、或檔案組織，都必須同步更新本文件。**

- Extension 版本號規則：每次更新 +0.01，採兩段式格式（例如 `0.13` → `0.14`，而非 `0.1.13`）。
- Extension 版本號統一由 `manifest.json` 的 `version` 欄位控管；Popup 顯示版本透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。
- 本 SPEC 文件的版本號與 Extension 版本號獨立管理；SPEC 有結構性變動時 +0.1。

---

## 1. 專案目標

Shinkansen 是一款 Chrome 擴充功能，將英文（或其他外語）網頁翻譯成繁體中文（台灣用語），協助使用者流暢閱讀外語內容。名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

第一階段（v0.1x 系列）的目標是：**能安裝、能翻譯、能用**，先跑通最短可行路徑，之後再逐步加功能。

---

## 2. 功能範圍

### 2.1 已實作（v0.55 為止）

1. **單語覆蓋顯示**：直接把原文段落的文字節點替換成譯文，保留元素本身的 font-family、font-size、color、layout，維持網頁原本排版。
2. **手動翻譯**：Popup「翻譯本頁」按鈕、Option+S 快捷鍵都可觸發。
3. **自動翻譯（白名單）**：網域若在白名單內則自動翻譯（M3 調優中）。
4. **Gemini API 整合**：使用 Google Gemini REST API，所有參數開放使用者微調（模型、service tier、temperature、topP、topK、maxOutputTokens、systemInstruction）。
5. **網域黑白名單**：設定頁可設定「永不翻譯」或「總是翻譯」清單。
6. **持久化翻譯快取**：以 SHA-1（原文） 為 key 存在 `chrome.storage.local`，跨頁面、跨會話都有效。相同段落第二次見到直接從快取讀取，不打 Gemini。
7. **快取管理**：Popup 顯示快取統計（段數 / 大小），提供「清除快取」按鈕。Extension 版本變更時自動清空快取。
8. **分批漸進式翻譯**：段落以「字元預算 + 段數上限」雙門檻 greedy 打包成批送出（v0.37 起，詳見第 3.5 節），每批翻譯完成立刻注入 DOM，使用者看到頁面逐段變成中文。
9. **翻譯狀態提示（Toast）**：畫面右下角顯示進度條 + 當前段數 + 耗時計時器。詳見第 13 節。
10. **LLM 除錯 Log 開關**：設定頁開關，開啟後記錄每次 API 請求與回應。
11. **快捷鍵**：預設 Option+S(macOS)/ Alt+S（其他 OS），可在 `chrome://extensions/shortcuts` 變更。
12. **設定同步**：`chrome.storage.sync` 透過 Google 帳號跨裝置同步。
13. **翻譯成本顯示**：設定頁可填入 Gemini 模型的 Input / Output tokens 單價（USD per 1M tokens）。翻譯完成時 Toast 顯示本次頁面的 token 數與費用；Popup 顯示跨頁面的累計使用量與費用，並提供「重置統計」按鈕。
14. **Extension Icon 紅點 Badge**：翻譯完成時在 extension icon 上點亮旭日紅（`#cf3a2c`）的 `●` 標記，讓使用者一眼就知道當前分頁已翻譯。還原原文或切換到未翻譯分頁時自動清除。badge 是 per-tab 狀態，每個分頁獨立。
15. **回復預設設定**：設定頁下方有「回復預設設定」按鈕。會把所有設定（模型、參數、計價、網域規則、系統提示等）還原為 `DEFAULT_SETTINGS`，**API Key 保留**，翻譯快取與累計使用統計不動（各自有專屬的清除／重置按鈕）。
16. **完整保留連結與行內樣式**：段落內的 `<a>`、`<strong>`、`<em>`、`<code>`、`<mark>`、帶 class/style 的 `<span>` 等行內元素，在翻譯後完整保留外殼（包括 `href`、`class`、`style` 等屬性），譯文文字會塞回原本的位置。實作上 content.js 會在送 LLM 前把這些行內元素抽掉換成 `⟦N⟧…⟦/N⟧` 佔位符（U+27E6 / U+27E7），LLM 翻譯純文字並原樣保留佔位符，回來後 content.js 再把佔位符替換回原本的「殼」。若 LLM 弄丟佔位符（驗證失敗），會 fallback 到純 textContent 替換以避免內容遺失。
17. **並行翻譯與三維度 Rate Limiter**（v0.35 新增）：`content.js` 的序列 `for` 迴圈改為 concurrency pool 並行派發，同時 `background.js` 持有一個全域的 `RateLimiter` singleton（`lib/rate-limiter.js`），對每次 Gemini 請求做 RPM / TPM / RPD 三維度 sliding window 節流。Tier 對照表（`lib/tier-limits.js`）內建 Free / Tier 1 / Tier 2 各模型的預設上限，使用者可於設定頁切換 tier 或填入自訂值。`lib/gemini.js` 加入 429 退避重試，尊重 `Retry-After` header，遇 RPD 爆表則不重試並提示使用者。預設模型同步從 `gemini-2.0-flash` 升級為 `gemini-2.5-flash`（已存在的使用者設定不受影響）。詳細規格見第 19.1 節。
18. **Mixed-content 段落偵測**（v0.36 新增）：`collectParagraphs` 改為能處理「同時含直接文字 + block 後代」的 block 元素（例如 Stratechery 編號列表的 `<li>引言<ul>子項目</ul></li>`）。這類外層 block 仍走葉子優先讓內層 block 獨立翻譯，但新增 **fragment 段落單位**，把外層自己的 inline-level 直接子節點切成一或多個連續區段獨立收為段落。v0.35 以前這種引言文字會被孤立、完全沒送翻譯，v0.36 起透過 fragment 單位正確涵蓋。詳細規格見第 5.2 節。
19. **字元預算 + 段數上限雙門檻 greedy 打包**（v0.37 新增）：取代原本「固定 20 段為一批」的分批策略。原本的策略對段落長度不敏感，遇到 Stratechery 這類長段論述時容易造成單批 input tokens 暴衝，也容易讓批次處理時間極度不均勻（短段批次秒回、長段批次要等十幾秒）。v0.37 改用「字元預算 + 段數上限」雙門檻 greedy 打包：依原順序累加段落，當累積字元數超過 `MAX_CHARS_PER_BATCH = 3500` 或段數達 `MAX_UNITS_PER_BATCH = 20` 就封口開新批次；任一門檻先達到就觸發。單段本身就超過字元預算時獨佔一批，不切段落本身以避免破壞語意。效果：避免單批 token 暴衝與 slot 過多對齊失準；批次處理時間更平均、進度條推進更平穩。實作位於 `content.js` 的 `packBatches()` 與 `lib/gemini.js` 的 `packChunks()`，兩者互為雙重保險。詳細規格見第 3.5 節。
20. **X / Twitter 推文內容偵測**（v0.38 新增）：X 的推文正文包在 `<div data-testid="tweetText">` 裡面，整個子樹只有 `<span>` / `<a>` / `<br>`，完全沒有 block tag，v0.37 以前的 walker 一律跳過、整頁只翻到 Toast 的零星內容。v0.38 把 `[data-testid="tweetText"]` 與嵌入卡片的 `[data-testid="card.layoutLarge.detail"] > div`、`[data-testid="card.layoutSmall.detail"] > div` 加入 `INCLUDE_BY_SELECTOR`，讓這些 `div` 以 element 單位被收進段落列表。推文裡的 `<a>` 連結會走既有的 ⟦N⟧ placeholder 路徑保留外殼（href/class/style 都不動）。在這條補抓之上，「哪個讀者該不該看」依舊交給 Gemini system prompt 判斷，不在 selector 層再做內容排除。
21. **互動 widget 容器結構性排除**（v0.39 新增）：walker 以前會把 X 側欄「相關人士（Who to follow）」的整張 `<li data-testid="UserCell">` 當成一個段落單位送翻——LI 是 BLOCK_TAG、裡面又全是非-block 的 div/span，符合 v0.37 的葉子 block 判斷條件。結果整張卡（avatar、名稱 header、@handle、「跟隨你」badge、Follow button、bio）被 serializer 全部抽進一個單位，slot 數暴衝到 LLM 留不住 placeholder，injector 走 textContent fallback 把整個 LI 內容壓扁成一行，名稱 header 與按鈕的 DOM 結構全部消失。v0.39 在 `collectParagraphs` 的 walker 與 `INCLUDE_BY_SELECTOR` 補抓路徑上，都新增 `isInteractiveWidgetContainer(el)` 檢查：block 元素（或被 selector 命中的 div）若含 `<button>` 或 `[role="button"]` 後代，就整塊 REJECT 不翻譯。Wikipedia / Medium / Stratechery 等一般文章段落不會有這些控制項，不受影響；代價是像 UserCell 這類卡片裡的 bio 也不會被翻譯，屬於側欄輔助內容，放棄它好過結構被壓扁。這條規則與規則 6（翻譯範圍由 system prompt 決定）並不衝突——這是「結構性必須跳過」的排除（互動 widget，不是語意段落），不是「讀者該不該看這段文字」的內容品味判斷。
22. **WordPress 文章末段落補抓**（v0.40 新增）：Stratechery 等 WordPress 站的文章結尾會有兩類內容被 v0.39 以前的規則漏掉。(a) Jetpack「相關貼文」模組把文章卡片裝在 `<nav class="jp-relatedposts-i2 wp-block-jetpack">` 裡——NAV 本來被「語意容器排除」硬規則整塊跳過，但這個 nav 實質是讀者要看的延伸閱讀內容。v0.40 在 `isInsideExcludedContainer` 新增「nav 內容白名單」例外：命中 `jp-relatedposts-*` class 的 nav 不算排除容器，walker 可以進去收 H3 / H4 / A 等段落。一般站內選單、導覽列仍由 NAV 硬規則處理，不受影響。(b) WordPress block theme 的「上一篇 / 下一篇」導覽連結用 `<div class="wp-block-post-navigation-link">` 包 span + a，完全沒有 block tag 子孫，walker 抓不到。v0.40 把 `.wp-block-post-navigation-link` 加入 `INCLUDE_BY_SELECTOR` 主動補抓。這條規則是 CLAUDE.md §6「結構性必須跳過」硬規則的「窄修例外」而不是方向轉變——只針對明確命名空間的已知內容 nav 放行，不是把所有 nav 都當內容容器。
23. **footer 內容白名單**（v0.41 新增）：WordPress block theme 會把「Stratechery Plus」這類延伸閱讀文章卡片區塊塞進 `<footer class="wp-block-template-part">` 裡，語意上是站尾但實質是讀者要看的內容。v0.40 以前的 FOOTER 硬規則會把整個 footer 跳過，導致側欄那一份 Stratechery Plus（包在 `<aside>` 裡）有翻譯、但頁面最底部的那一份（包在 `<footer>` 裡）保留英文。v0.41 在 `isInsideExcludedContainer` 新增「footer 內容白名單」例外：`isContentFooter(el)` 判斷 footer 子樹裡是否含有 WordPress 的 `wp-block-query` / `wp-block-post-title` / `wp-block-post` 任一 block，命中就當成內容 footer 放行，walker 可以進去收裡面的 H3 / A / TIME 等段落。一般站尾（版權、站內選單、社交連結）沒有這些 WP 文章 block，維持跳過。這是 v0.40 nav 窄修的對稱延伸，同樣屬於「窄修例外」而不是方向轉變。
24. **Leaf content anchor 補抓**（v0.42 新增）：卡片式網站（Substack / Culpium / Medium 首頁等）把整張文章卡包在 `<a>` 裡，內部只有 `<div class="...">` 巢狀結構，完全不用 h1/h2/h3/p/article 等 block tag，walker 一個段落也收不到。實際觀察 culpium.com 首頁：整頁 0 個 h2/h3/p、只有 1 個 h1（站名「Culpium」），導致 v0.41 以前只偵測到 1 段。v0.42 在 `collectParagraphs` 的 selector 補抓階段後面新增一條 anchor 補抓路徑，收 leaf content anchor——同時滿足四個條件的 `<a>`：(1) 祖先中沒有任何 `BLOCK_TAGS_SET` 元素（確保一般文章內的 `<a>` 仍由父 `<p>`/`<li>` 正規處理），(2) 本身不含 block 後代，(3) `innerText.trim().length >= 12`（擋掉「Home / Notes / Sign in / About」這類短 nav 連結），(4) 通過既有的 visible / candidateText / 排除容器 / widget 容器 / 已翻過 檢查。命中後以 element 單位加入 results，序列化與注入流程完全不需要改動。這條規則與規則 6（翻譯範圍由 system prompt 決定）並不衝突——這是「語意容器全部被 div 取代」的結構性補救，不是內容品味判斷。
25. **快捷鍵 sendMessage uncaught rejection 修正**（v0.43 新增）：`background.js` 的 `chrome.commands.onCommand` 快捷鍵 handler 原本直接 `chrome.tabs.sendMessage(tab.id, …)` 而沒有 `.catch`。在 `chrome://`、Chrome Web Store、新分頁等無法注入 content script 的頁面按 Option+S 時，該 tab 沒有 listener，sendMessage 會 reject「Could not establish connection. Receiving end does not exist.」並冒成 uncaught promise rejection 污染 background.js 的錯誤面板。v0.43 加上 `.catch(() => {})` 靜默吞掉這個預期情境，使用者在非翻譯頁按快捷鍵不再產生錯誤通知。content.js 裡所有 `chrome.runtime.sendMessage` 早已有 `.catch(() => {})` 保護，這次只是補齊 background.js 快捷鍵路徑的缺口。
26. **Widget 容器規則加文字長度短路**（v0.44 新增）：v0.39 加上的 `isInteractiveWidgetContainer(el)` 規則是「block 內含 `<button>` 或 `[role="button"]` 後代 → 整塊 REJECT」，用來解決 X 的 `<li data-testid="UserCell">` 整張 Who-to-follow 卡被當單一段落送翻導致 serializer slot 爆炸的問題。但這個粗暴規則在 Gmail 上誤傷了 HTML email newsletter：整封郵件本文包在一個 `<td>` 裡（email 老派用 table-based layout，`<td>` 是 `BLOCK_TAG`），textLength 常達 1000+ 字，而且幾乎一定含有「Continue reading / Subscribe / Read more」這類 CTA `<button>`。結果整個 email body TD 被整塊 REJECT，walker 下不到內層的 `<p>`，v0.43 的 Shinkansen 在 Gmail 打開一封 newsletter 只會翻到 2 段 Gmail UI 本身的 header/寄件人，郵件本文完全沒送翻譯。v0.44 加上「文字長度短路」：`isInteractiveWidgetContainer` 在偵測到 button 後,額外檢查 `el.innerText.trim().length`,若 ≥ 300 字則**不**當作 widget 容器，放行讓 walker 下降。閾值 300 字的依據：X UserCell 典型大小（名稱 10~40 字 + @handle 10~20 字 + bio 上限 160 字 ≈ 最多 200 字）穩穩低於閾值維持 REJECT；Gmail HTML email 本文 TD（500~2000+ 字）與一般「長段落 + CTA」結構穩穩高於閾值正常翻譯。同時 v0.44 把本規則的註解從「role=link 也納入」清掉——實務上只保留 button 與 role=button 兩種真正的互動控制項訊號就夠了。歷史實測：在 Jimmy 的 Gmail newsletter「Henry Ford's Connection to Charcoal」上，v0.43 收到 2 段（全是 UI 本身），v0.44 收到 6 段（H2 標題、H3 寄件人、P 正文 217 字、P 正文 306 字、P 圖說等），郵件本文正確送翻。
27. **翻譯完成後延遲 rescan 補抓機制**（v0.45 新增）：Nikkei Asia 這類 Next.js 站的「READ NEXT」延伸閱讀區在 `document_idle`（content.js 最早可執行的時機）那一刻還沒 attach 到 DOM，是 React hydration 之後才 mount。初次 translatePage 的 walker 跑過去時抓不到，結果文章本體翻完後整個下半截的推薦文章卡片保留英文。採證時觀察到一個關鍵現象：使用者手動按一次 Alt+S 切回原文、再按一次重翻，READ NEXT 區就會跟著翻成中文——這直接證實問題不在偵測規則，而是「第一次 walker 跑太早」。實際在 Nikkei 頁面呼叫 `window.__shinkansen.collectParagraphsWithStats()` 也確認第二次走 walker 時 READ NEXT 的 10 張卡片全部都被正確收進單位列表，偵測邏輯本身沒有誤判。v0.45 在 `content.js` 新增 **延遲 rescan 機制**：初次 translatePage 成功完成後,在 1200ms 與 3000ms 兩個退避時間點再各呼叫一次 `collectParagraphs`。因為 walker 會自動 REJECT 已帶 `data-shinkansen-translated` 標記的節點，rescan 拿到的自然就是「上次翻完之後才出現的新段落」。有新段落就重用既有的序列化 / 打包 / 並行 / 注入 pipeline 送翻（抽出 `translateUnits()` 核心函式供 translatePage 與 rescanTick 共用）；沒有就靜默跳過。rescan 命中新內容時會顯示「補抓 X 段新內容」的小 toast（3 秒自動消失），避免每次翻譯都無謂跳提示。設計上固定只做兩次退避、不改成常駐 `MutationObserver`，是為了避開 SPA 動態內容（Twitter timeline、Substack infinite scroll）會讓 observer 無限觸發造成翻譯成本暴衝的風險——兩次退避式 rescan 已經足以涵蓋 Nikkei 這類「一次性 hydration」場景，且成本固定可預測。為避免競態，`restorePage` 會呼叫 `cancelRescan()` 清掉任何還沒觸發的延遲計時器，`rescanTick` 在 `await` 前後都會再次檢查 `STATE.translated`，若使用者已按還原就直接結束。歷史實測：v0.44 在 Nikkei Asia 文章頁翻完文章本體後 READ NEXT 區 6 張卡片全部保留英文；v0.45 翻譯完成約 1.2 秒後自動補抓並顯示「補抓 10 段新內容」（6 個 h4 標題 + 4 個 Tag 標籤），與使用者手動按兩次 Alt+S 的效果相同但不需人工介入。
28. **Gemini implicit cache 命中統計顯示**（v0.46 新增）：Gemini 2.5 系列（包含 Flash / Pro / 3 Flash 等）預設開啟 **implicit context caching**——當同一段 prompt 前綴在短時間內被重複呼叫時，Gemini 會自動把前綴 cache 起來，後續命中部分以原價 25% 計費。Shinkansen 的分批翻譯剛好是這種場景：一篇文章會被切成多批送出，每批都帶同樣一大段 system prompt，理論上從第二批開始就能吃到 implicit cache 折扣。但使用者完全看不到是否真的有命中、命中多少，也無從判斷 prompt 變動後命中率有沒有退化。v0.46 從 API 回應的 `usageMetadata.cachedContentTokenCount` 讀出「本次輸入中從 cache 命中的 token 數」，在 `lib/gemini.js::translateChunk` 的 `chunkUsage` 新增 `cachedTokens` 欄位，沿著 `translateBatch` → `background.js::handleTranslate` → `content.js::translateUnits` 一路累加到 `pageUsage.cachedTokens`。翻譯完成後的成功 toast detail 列若命中率 > 0 會在原本的「`X,XXX tokens · $0.0028`」後面補上「`· 快取 XX%｜省 XX%`」：**命中率** = `cachedTokens / inputTokens × 100%`，分母是 `promptTokenCount`（含 system prompt + 原文），分子是其中被 cache 命中的部分；**等效節省** = 命中率 × 75%（因為命中的部分還是要付 25% 錢）。同時 `translatePage` 在組 detail 前會把完整 usage 物件 `console.log` 到 DevTools，欄位包含 `segments / inputTokens / cachedTokens / outputTokens / implicitCacheHitRate / equivalentSavings / costUSD / localCacheHitSegments`，方便事後優化 prompt 長度時對照實際數字。實作上刻意不混用既有的 `pageUsage.cacheHits`（那是指 `lib/cache.js` 本地 `tc_<sha1>` 翻譯快取命中「段數」，命中段根本沒送 API），兩個欄位並存互不干擾。若完全沒命中則 detail 不附加快取資訊，避免顯示「快取 0%｜省 0%」刺眼；若全段落都命中本地翻譯快取則 `totalTokens === 0`，走原本的「全部快取命中 · 本次未計費」路徑不動。

29. **成功 toast 改為點擊外部區域關閉，並移除補抓 toast**（v0.47 新增）：v0.46 加了 implicit cache 命中率統計後，使用者發現兩個跟 toast 互動性相關的問題。第一，v0.45 加的延遲 rescan 補抓機制在成功補抓新內容時會 `showToast('success', '補抓 X 段新內容', { autoHideMs: 3000 })`，這個 toast 會透過 `showToast` 的 singleton 機制**蓋掉**原本的「翻譯完成」主 toast——而主 toast 現在帶著使用者最在意的 token 數、費用、cache 命中率，如果補抓剛好在使用者還沒讀完主 toast 時發生（Nikkei 等 hydration 型網站很常見，大約翻譯完成 1.2 秒後就觸發補抓）就會直接把這些資料蓋掉消失。第二，「翻譯完成」主 toast 原本是 `autoHideMs` 不設定、使用者必須點右上角 `×` 才能關閉，但 `×` 是小目標、又剛好被 Shadow DOM 包住，使用者反應點擊體驗不夠俐落，希望改成點擊 toast 以外任何地方就關閉。v0.47 對這兩個行為分別做修正：（a）`rescanTick` 成功補抓時不再呼叫 `showToast`，改成 `console.log('[Shinkansen] rescan 補抓', { done, failures, attempt })` 靜默記錄，讓需要知道補抓細節的人自己到 DevTools 看。失敗原本就只 `console.warn`，現在成功比照辦理，補抓機制整體在 UI 層完全隱形，翻譯完成的主 toast 保留在畫面上直到使用者主動關閉。（b）`showToast` 新增「翻譯完成」狀態專用的點擊外部關閉機制：當 `kind === 'success'` 且沒有 `opts.autoHideMs` 時（排除「已還原原文」這類 2 秒自動消失的次要提示），在下個 event loop tick 註冊一個 `document.addEventListener('mousedown', …, true)`——用 capture phase 的 `mousedown` 比 `click` 更早觸發，避免頁面自己的 handler 先吃掉事件；用 `event.composedPath().includes(toastHost)` 判斷點擊目標是否在 Shadow DOM 容器內部，在內部（點 toast 本體或 × 按鈕）就忽略，在外部就 `hideToast()`。右上角 `×` 按鈕保留為備援機制，不移除。`removeOutsideClickHandler()` 會在 `hideToast()` 與下次 `showToast()` 開頭主動清理 listener，避免遺留監聽或重疊註冊。設計細節：註冊時刻意延後到 `setTimeout(…, 0)` 而非同步註冊，是為了防止觸發 `showToast` 的那個 click event 自己往下傳到新註冊的 listener 立刻關掉 toast——雖然目前主 toast 主要由 Alt+S 快捷鍵觸發、幾乎沒機會被 click 連鎖觸發，但 defensive 設計比較安全。另外在延遲回呼內再檢查一次 `toastEl.className.includes('show')`，處理「showToast 註冊後立即被下一個 showToast 取代」的極短競態。

30. **Toast 與 popup 累計改顯示 Gemini implicit cache 折扣後的「實付」值**（v0.48 新增）：v0.46 加 implicit cache 命中率 toast 時留了一個認知不一致的 bug——toast 上顯示的 `X,XXX tokens · $0.0028` 其實是「完全沒命中 cache 的原價」，末尾的「快取 73%｜省 55%」只是提醒使用者「理論上可以省這麼多」，但實際帳單上會扣多少錢、實付等效 tokens 是多少，使用者完全看不到，必須心算「原價 × (1 - saved%)」。同樣的，popup 右下角的「累計：$X.XX / Y tokens」也是原價累加，跟使用者在 Google AI Studio 結帳頁看到的實際扣款對不上。v0.48 把 toast 與 popup 累計統一改為顯示實付值，並順便把 detail 改成使用者要求的兩行格式。主要改動：（a）`background.js` 新增 `computeBilledCostUSD(inputTokens, cachedTokens, outputTokens, pricing)`，公式為 `((inputTokens - cachedTokens) + cachedTokens × 0.25) × inRate / 1M + outputTokens × outRate / 1M`——未命中部分全價、命中部分 25%。`handleTranslate` 同步計算 `billedInputTokens = max(0, inputTokens - cachedTokens × 0.75)`（等效 input token 數，四捨五入到整數）與 `billedCostUSD`，改呼叫 `addUsage(billedInputTokens, outputTokens, billedCostUSD)`——累計從此完全是實付值。回傳的 `usage` 同時包含原始 `inputTokens / costUSD`（保留給 content 端算 hit% / saved% 與 debug log）與新的 `billedInputTokens / billedCostUSD`。（b）`content.js::pageUsage` 新增 `billedInputTokens` 與 `billedCostUSD` 兩個累加欄位。（c）toast detail 排版從單行 `{tokens} · {USD} · 快取 X%｜省 Y%` 改為兩行 pre-line 格式：第一行 `{billedTotalTokens} tokens (XX% hit)`、第二行 `{billedUSD} (XX% saved)`，其中 `billedTotalTokens = billedInputTokens + outputTokens`、`hitPct = cachedTokens / inputTokens × 100`（input 層的 cache 命中比例）、`savedPct = (costUSD − billedCostUSD) / costUSD × 100`（費用層的節省比例，因 output 沒折扣所以會比 hit% 略低）。若 `cachedTokens === 0` 則兩行都不附加括號，避免顯示「0% hit」「0% saved」刺眼。（d）CSS `.detail` 加 `white-space: pre-line; line-height: 1.4`，讓第一行與第二行可以靠 `\n` 正確折行。（e）`console.log('[Shinkansen] page usage', …)` 欄位擴充：`billedInputTokens / billedTotalTokens / originalCostUSD / billedCostUSD / costSavedRate` 都印出來，方便事後查實際數字與原價對照。`popup.js` 完全不用改，因為它本來就是讀 `usageStats.totalInputTokens` 與 `totalCostUSD`，background 累計邏輯改成實付後 popup 自動跟進。設計上刻意保留 `costUSD`（原價）欄位在 `pageUsage` 與回傳 usage 中，而不是完全替換成 billed，是因為 saved% 需要原價作為分母來算比例；若未來要把兩個都顯示出來（例如「原 $0.01 → 實付 $0.005」），原價資訊也已經在手上不用重算。

### 2.2 規劃中（尚未實作）

- 四大測試網站（Gmail、Twitter/X、Wikipedia、Medium）的網站專屬偵測規則調優
- 設定匯出 JSON 到 iCloud 雲碟（備援同步方案）
- 內建 Log 檢視頁
- ~~**並行翻譯**：已於 v0.35 實作完成（見 §2.1 #17 與 §19.1）~~
- **全文術語表一致化（並行翻譯穩定後接手）**：預先建立專有名詞對照表，解決分批翻譯造成的名詞譯名不一致，詳見第 19.2 節

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、多 Provider（Google 翻譯、DeepL、Yandex 等）、PDF/EPUB/影片字幕、延遲載入、多國語言介面、淺色/深色主題切換、雙語對照顯示模式。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-2.5-flash`，可改 `gemini-2.5-pro`、`gemini-2.5-flash-lite`、`gemini-3-flash-preview` 等）
- `serviceTier`：推論層級，四選一（見下方「服務層級」小節），**預設 `DEFAULT`**（不送此欄位）
- `temperature`：創造性，範圍 0~2，預設 0.3
- `topP`：核採樣，預設 0.95
- `topK`：預設 40
- `maxOutputTokens`：最大輸出長度，預設 8192
- `systemInstruction`：系統提示詞（見 3.4）
- `safetySettings`：安全過濾等級（預設 BLOCK_NONE 四大類別全開，避免翻譯新聞/學術內容時誤擋）

### 3.3 服務層級（Service Tier）

| UI 顯示 | 實際送出值 | 成本 | 說明 |
|---|---|---|---|
| **預設** | 省略欄位（不送） | 由模型決定 | 相容性最好，舊模型不會拒絕 |
| Flex | `FLEX` | **-50%** | 背景任務，可容忍延遲；網頁翻譯適用 |
| Standard | `STANDARD` | 原價 | 一般互動需求 |
| Priority | `PRIORITY` | 原價+ | 商業關鍵、時間敏感 |

**注意事項**：
- 欄位值使用 **短形式**(`FLEX` / `STANDARD` / `PRIORITY`)，不是舊文件的 `SERVICE_TIER_FLEX` 長形式（長形式會被 API 拒絕）。
- 當使用者選「預設」時，`serviceTier` 欄位完全不送，避免舊模型拒絕未知欄位。
- 實作邏輯在 `lib/gemini.js`：`if (serviceTier && serviceTier !== 'DEFAULT') body.serviceTier = serviceTier;`

### 3.4 預設 System Prompt

```
你是一位專業的翻譯助理。請將使用者提供的文字翻譯成繁體中文（台灣用語），遵守以下規則：
1. 只輸出譯文，不要加任何解釋、前言或後記。
2. 保留原文中的專有名詞、產品名、人名、程式碼、網址、數字與符號。
3. 使用台灣慣用的翻譯（例如 software → 軟體、而非「軟件」；database → 資料庫、而非「數據庫」）。
4. 若輸入包含多段文字（以特定分隔符號區隔），請逐段翻譯並以相同分隔符號輸出。
5. 語氣自然流暢，避免直譯與機械感。
```

**動態追加：佔位符保留規則**

當本批送出的文字含 `⟦` 字元（content.js 為了保留連結與行內樣式而注入的佔位符）時，`lib/gemini.js` 會在使用者設定的 systemInstruction 後面追加一段規則，要求 LLM 把 `⟦數字⟧…⟦/數字⟧` 標記原樣保留、不可省略改寫翻譯。沒有佔位符的批次則不追加，避免污染其他翻譯。詳見第 4.2 節。

### 3.5 分段請求協定

多段文字以分隔符 `\n<<<SHINKANSEN_SEP>>>\n` 串接後一次送出，回應以相同分隔符拆分對齊原段。

**分批策略**（v0.37 起）：「字元預算 + 段數上限」雙門檻 greedy 打包。

- **`MAX_CHARS_PER_BATCH = 3500`**：每批累積的原文字元數上限。英文 ≈ 4 chars/token，所以 3500 chars ≈ 1000 input tokens，留足 output headroom（Gemini Flash 系列 output 上限約 8K tokens，且中文譯文 token 密度比英文高，保守係數 1.5–2×）。不真的呼叫 tokenizer，用字元數作為 token proxy 即可；對目標網站（英文為主的 Stratechery / Wikipedia / Medium）誤差在安全範圍內。
- **`MAX_UNITS_PER_BATCH = 20`**：每批段數上限。避免單批 placeholder slot 總數過多導致 LLM 對齊能力下降。
- **雙門檻 any-trigger**：依原順序累加段落，當「累積字元數 > 預算」或「段數達上限」任一條件觸發就封口開新批次。
- **超大段落獨佔一批**：若單段本身字元數就超過 `MAX_CHARS_PER_BATCH`，該段獨佔一個批次。**不切段落本身**——切段落會破壞語意完整性、LLM 翻譯品質會下降，得不償失。job 物件會帶 `oversized: true` 旗標供後續觀察。
- **順序維持**：`jobs` 依原始 DOM index 排列，確保並行 dispatch 回來後仍能注入到正確位置。

**實作位置**：
- `content.js` 的 `packBatches(texts, units, slotsList)` — 主要打包層，輸出含 `{ start, texts, units, slots, chars, oversized? }` 的 job 物件。呼叫於 `translatePage()` 建立 jobs 陣列時。
- `lib/gemini.js` 的 `packChunks(texts)` — 雙重保險層（萬一 background / 其他呼叫端塞進來的批次仍然太大），同樣用雙門檻切成 `{ start, end }` 索引區段，`translateBatch` 依此分多次呼叫 `translateChunk`。

每個子批次各自向 background 發送 `TRANSLATE_BATCH` 訊息，進 rate limiter 排隊後呼叫 Gemini API。多段文字以分隔符 `\n<<<SHINKANSEN_SEP>>>\n` 串接後一次送出，回應以相同分隔符拆分對齊原段。

**歷史**：v0.36 以前用「固定 `CHUNK_SIZE = 20` 段一批」。此策略對段落長度不敏感，遇到長段論述頁面時容易（a）單批 input tokens 暴衝觸發 TPM 限制、（b）批次處理時間極不均勻、（c）長批次 output token 被截斷導致對齊 fallback。v0.37 改為字元預算 greedy 打包解決。

**對齊失敗 fallback**：若 Gemini 回傳的段數與送出段數不符，`lib/gemini.js` 會自動退回「每段單獨呼叫」的模式，以確保對齊；單段模式下若回傳仍含分隔符則回傳整段 trim 後的文字。

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

**單語覆蓋（僅此一種）**：將原文段落的文字節點替換成譯文，元素本身保留不動。**不提供雙語對照模式**（使用者明確要求移除）。

### 4.2 替換策略

依元素內含的內容走三種路徑：

**路徑 A — 含保留行內元素（含 `<a>` / `<strong>` / `<em>` / `<code>` / `<mark>` / 帶 class 或 style 的 `<span>` 等，且不含媒體）**：

1. 送 LLM 前先呼叫 `serializeWithPlaceholders(el)`：遞迴把保留行內元素換成 `⟦N⟧…⟦/N⟧` 佔位符，回傳 `{ text, slots }`。`slots[N]` 是該元素的 shallow clone（殼，含所有屬性如 `href`、`class`、`style`），子節點全清掉。**v0.32 起支援巢狀**：`<b>foo <a>bar</a> baz</b>` 會序列化成 `⟦0⟧foo ⟦1⟧bar⟦/1⟧ baz⟦/0⟧`，外層與內層同時有各自的 slot。
2. LLM 翻譯純文字，佔位符原樣保留（`lib/gemini.js` 會在 systemInstruction 後追加保留規則，且只有當輸入含 `⟦` 時才追加，避免影響其他段落）。規則中明確告知 LLM 佔位符可以巢狀嵌套，不可扁平化或漏任一層。
3. 譯文回來後呼叫 `deserializeWithPlaceholders(translation, slots)`：內部委派給遞迴的 `parseSegment()`，用 regex `⟦(\d+)⟧([\s\S]*?)⟦\/\1⟧` 以非貪婪 + backreference 找到最外層配對，對 inner 再次遞迴解析以處理巢狀，最終組成 DocumentFragment 樹。
4. 呼叫 `replaceNodeInPlace(el, frag)`：跟路徑 B 的 `replaceTextInPlace` 同樣思路——找到 el 下最長的可見文字節點，把 fragment 插在它原位、再移除它跟其他文字節點。**v0.49 bugfix**：先前 v0.48 用 `el.textContent = ''; el.appendChild(frag)`，會把 MJML 內層 wrapper `<div>` / `<span>` 一併清掉；fragment 裡的 SPAN shell 只複製了 `font-family` / `color` 等屬性（沒有 `font-size`），結果文字繼承外層 TD 的 `font-size: 0px` → 整段視覺上消失。改走 `replaceNodeInPlace` 後，fragment 會落在 MJML inner wrapper 底下，自動繼承 wrapper 的真字體大小。觸發情境：Gmail 打開 Claude 官方歡迎信的 step body TD 含 6 個帶 inline `style` 的 SPAN，觸發 `isPreservableInline` 走 slots 路徑。
5. **驗證（寬鬆模式，v0.24）**：deserialize 回傳 `{ frag, ok, matched }`。只要 `matched > 0`（至少一對佔位符成功配對）就視為 `ok = true`，使用 fragment 注入；LLM 漏放的佔位符會用 `stripStrayPlaceholderMarkers` 把殘留 `⟦N⟧` / `⟦/N⟧` 標記從文字節點裡清掉。只有 `matched === 0`（完全沒配對）才退回純 `textContent` fallback。先前 v0.23 採嚴格全配對模式，碰到段落內含 14 個 slot 的 Wikipedia lede 時容易整段崩成純文字、所有連結消失。
7. **CJK 空白清理**(v0.20)：LLM 翻譯時會把英文「連結+空格+下一個字」的空格原樣保留，但中文字之間不需要。deserialize 前會先跑 `collapseCjkSpacesAroundPlaceholders`，只收掉「CJK 字元 ↔ 佔位符 ↔ CJK 字元」之間的空白，其他地方（例如數字與中文之間的 "1600 年"）不動。
8. **技術元素過濾**(v0.22)：`serializeWithPlaceholders` 與 `hasPreservableInline` 都會跳過 `HARD_EXCLUDE_TAGS`（`STYLE` / `SCRIPT` / `NOSCRIPT` 等），避免 Wikipedia infobox TH 裡內嵌的 `<style>.mw-parser-output …</style>` 把 CSS 原始碼當成純文字送進 LLM。
9. **降低佔位符密度**(v0.24)：為了避免 LLM 在遇到大量 slot 時直接放棄（觀察到 Wikipedia「Edo」首段一句話有 14 個 slot），`isPreservableInline` 會額外過濾掉沒有實質內容的 inline 元素——透過 `hasSubstantiveContent`（要求文字含拉丁字母、CJK 或數字）排除像 `<span class="gloss-quot">'</span>` 這種純標點殼。
10. **腳註參照原子保留**(v0.25)：`isAtomicPreserve` 會把 `<sup class="reference">…</sup>`（Wikipedia 腳註參照如 `[2]`）視為「原子單位」——`serializeWithPlaceholders` 會把整個元素 deep clone 存進 slot，並用單一自閉合佔位符 `⟦*N⟧` 取代。LLM 完全看不到 `[2]` 三個字元，不會把它翻譯也不會改成全形。`deserializeWithPlaceholders` 配對到 `⟦*N⟧` 時直接把原始的 `<sup><a>[2]</a></sup>` deep clone 塞回去，連結與樣式一起保留。先前 v0.24 採「攤平成純文字」策略雖然少了 slot，但代價是連結消失且 LLM 會把 `[2]` 改成全形 `［2］`。
11. **佔位符半形強制（system prompt 路線，v0.27）**：含密集連結的段落容易讓 LLM 在繁中模式下把 `⟦0⟧` 自動寫成 `⟦０⟧`（全形數字）或 `⟦/0⟧` 寫成 `⟦／0⟧`（全形斜線），造成正則配對失敗、整段崩成純文字。修法是在 `gemini.js` system instruction 裡明確警告 LLM「佔位符裡的數字、斜線、星號必須是半形 ASCII」，而**不在 content.js 做事後 normalize**。`normalizeLlmPlaceholders` 只負責「把佔位符 `⟦…⟧` 內部多餘空白收掉」這種範圍嚴格鎖在標記內、不會誤傷正文的清理；全形⇄半形這種「中文格式偏好」交給 prompt 處理，避免 parse 路徑與 prompt 規則互相衝突或誤傷譯文中合法的全形內容。
12. **連結優先於樣式**(v0.28，v0.32 起廢止)：v0.28–v0.31 期間，非 `<a>` 的保留行內元素若內部含 `<a>` 會讓位給內部 `<a>`（放棄外殼只保留連結），以解決 v0.23 shallow-clone 外殼把內部連結攤平成純文字的問題。v0.32 改走遞迴序列化 + 遞迴反序列化後這個權衡已不需要——外層 `<b>` 與內層 `<a>` 都能同時保留，因此此規則已從 `isPreservableInline` 移除。觸發情境：Wikipedia 維護模板 `<b>may incorporate text from a <a>large language model</a>, which is ...</b>`，v0.31 失去 bold、v0.32 兩者皆保留。

**路徑 B — 其他所有元素（v0.49 起統一路徑，不含可保留行內元素時走這條）**：

呼叫 `replaceTextInPlace(el, translation)`：

1. 用 `TreeWalker(SHOW_TEXT)` 收集元素內所有「可見的」非空文字節點（過濾掉 `HARD_EXCLUDE_TAGS` 祖先、`display:none` / `visibility:hidden` 祖先）
2. 選出最長的那個作為「主承載節點」，把整段譯文寫進 `nodeValue`
3. 其他文字節點 `nodeValue = ''` 清空
4. 所有 element 子節點（img、inner div/span、a、media…）原封不動保留
5. 若完全沒有文字節點（例如只含媒體），就 `appendChild(document.createTextNode(translation))`

**為什麼 v0.49 把路徑 B 與原路徑 C 合併**：v0.48 及之前，不含媒體的元素走 `el.textContent = translation`，這會把所有子節點（含 inner wrapper `<div>` / `<span>`）一併清掉只留裸 text child。在一般網頁沒差，但 MJML / Mailjet / Mailchimp 等 HTML email 模板常在外層 `<td>` 設 `font-size: 0`（消除 inline-block 欄位縫隙），把真正字體大小放在內層 `<div>` 上。內層 wrapper 被清掉後文字繼承 TD 的 `font-size: 0px`，視覺上整段消失。

歷史教訓：Gmail 打開 Claude 官方歡迎信（Mailjet 模板），v0.48 翻完之後標題 / welcome 段落 / step 卡片文字全部不見，icon 卻留著。text-node 替換只改 Text node 的 `nodeValue`，不動任何 element wrapper，能同時滿足「保留媒體」「保留 MJML inner wrapper」「保留 Wikipedia 複雜結構」需求，因此合併成單一路徑。對純文字元素（只有一個 text child）行為等價於舊版 `textContent` 替換，沒有回歸風險。

路徑 A 的 fallback 分支（slots 配對失敗、把 `⟦N⟧` 清掉當純文字塞回）同樣改走 `replaceTextInPlace`，原因相同。

**v0.50 補強：`<br>` ↔ `\n` 段落分隔 round-trip**：v0.49 修完字體大小問題後發現 MJML email 還有第二個 bug——範本沒有 `<p>` 標籤，多段內容是用 `<br><br><br>` 在同一個 TD 內分隔。`collectParagraphs` 把整個 TD 收成一個 leaf 單位、`serializeNodeIterable` 舊版又跑 `out.replace(/\s+/g, ' ')` 把所有空白（包含 `<br>` 留下的隱含換行）收成一個 space，Gemini 收到一行文字、回傳一行譯文，注入時就把所有段落擠在一起變成一坨。

修法分四個地方協同（serialize → prompt → deserialize → inject）：

1. **`serializeNodeIterable` 把 `<br>` 還原成 `\n`**：遇到 `<br>` 元素直接 `out += '\n'`。連續多個 `<br>` 會產生連續多個 `\n`。
2. **保留 `\n` 的 normalization**：取代舊版的 `\s+ → space`，改成「水平空白收成一個 space」+「行首尾空白吃掉」+「3+ 連續換行收成兩個 = 最多一個空行」三步驟。
3. **`gemini.js` 條件式追加段落分隔規則**：當本批 `texts.some(t => t.includes('\n'))` 為 true 時，在 systemInstruction 後面追加一條規則，要求 LLM 在對應位置原樣保留 `\n`、段落數一致。沒含 `\n` 的批次不追加，避免污染其他翻譯。
4. **`parseSegment` 的 `pushText` 把 `\n` 還原成真正的 `<br>`**：產生譯文 fragment 時，含 `\n` 的文字會 split 後在中間插 `document.createElement('br')`。同時 `replaceTextInPlace`（無 slots 路徑）也做同樣處理：含 `\n` 時先用 `buildFragmentFromTextWithBr` 蓋出 fragment 再走 `replaceNodeInPlace`，否則退回單一 text node 替換。

效果：原文 `Para1<br><br><br>Para2<br><br><br>Para3` 序列化成 `Para1\n\nPara2\n\nPara3`，Gemini 翻成 `段落一\n\n段落二\n\n段落三`，反序列化成 `段落一<br><br>段落二<br><br>段落三` 的 fragment。一般網頁的單一 `<br>` 只多一個 `\n`，normalize 之後在譯文裡保留為單一 `<br>`，視覺上等價於原本的單行換行。

**v0.51 修正：把「`<br>` 換行」與「source HTML 排版 `\n`」分開處理**：v0.50 上線後在 Wikipedia ambox（`.box-AI-generated` 等維護模板）出現新 regression：英文版只有日期是斜體，中文翻完整段都被當成斜體、`<I>` slot 結構錯亂。診斷後發現 Wikipedia source HTML 在 `<span>` 之間留了縮排換行（`</span>\n  <span>`），這些 `\n` 進到 text node 之後，v0.50 的新 normalize 規則（`/[ \t\r\f\v]+/` 而非 `/\s+/`) 會把它們當段落分隔保留，再加上條件式追加的「保留 `\n`」prompt 規則，就讓 LLM 誤判 `<I>` 佔位符該跨多大範圍，斜體就「漏」了。

修法：序列化階段不再對所有 `\n` 一視同仁。改用 sentinel `\u0001` 標記「真正來自 `<br>` 的換行」，normalize 流程改為：
1. `out.replace(/\s+/g, ' ')` —— 把所有原生 whitespace（含 source HTML 排版 `\n`）一律收成單一 space，回到 v0.50 之前的行為。
2. `out.replace(/ *\u0001 */g, '\u0001')` —— 吃掉 sentinel 兩側的多餘空白。
3. `out.replace(/\u0001{3,}/g, '\u0001\u0001')` —— 連續 3+ 個 sentinel 收成兩個（= 一個空行 = 段落分隔）。
4. `out.replace(/\u0001/g, '\n')` —— 把 sentinel 還原成真正的 `\n`，讓下游（gemini.js 條件式 prompt、`parseSegment` 的 `pushText`、`replaceTextInPlace` 的 `\n` 分支）照舊運作。

效果：MJML email 的 `<br><br><br>` 段落分隔行為與 v0.50 完全相同（測試通過 Gmail Mailjet 模板），但 Wikipedia ambox 的 source HTML 縮排不再被誤當段落，斜體只發生在原本的 `<I>` 範圍內。

**v0.52 修正：偵測 LLM placeholder 結構性失敗 + 改良 plain-text fallback**：v0.51 上線後 Wikipedia ambox（`.box-AI-generated` / `.box-More_footnotes_needed`）依然全部斜體 + 全部粗體。經 Chrome MCP 實地檢視翻譯後 DOM，發現原因不在序列化端，而在 LLM 端：ambox 內含 17 個 nested preservable inline 元素（`B`/`A`/`SPAN`/`I`/`SMALL`/...），Gemini 對如此複雜的巢狀 placeholder 處理失敗，回覆時把所有前面的 slot 開頭/結尾標記排成「空殼鏈」`⟦0⟧⟦1⟧⟦/1⟧⟦/0⟧...⟦/9⟧`，然後把整段中文塞進**最後一組** `⟦I⟧⟦SMALL⟧⟦A⟧` 內部，並在裡面 **重複引用** 前面的 slot 0/1/2。`parseSegment` 對 LLM 的回覆照單全收，於是渲染出「外層全空殼 + 中文被深埋在 `I > SMALL > A > B > A` 裡面」的結構，視覺上整段斜體粗體小字。

修法分兩部分：

1. **`deserializeWithPlaceholders` 加 slot 重複偵測**：在呼叫 `parseSegment` 之前用 regex 掃過譯文,每個開頭標記 `⟦N⟧` 在譯文中只能出現一次。任何 N 出現多次就視為 LLM 結構性失敗,直接 `return { ok: false, ... }`,讓上層走 plain-text fallback。
2. **新增 `plainTextFallback(el, cleaned)` 助手取代原本的 `replaceTextInPlace`**：原本 fallback 用 `replaceTextInPlace`,把譯文塞進「最長文字節點」,但 ambox 的最長文字節點剛好在 `<I><SMALL><A>` 裡面,Chinese 仍會繼承 italic/small 樣式。改用 `plainTextFallback`：預設直接 `el.textContent = cleaned`(一般網頁含 ambox 完全擺脫 inline ancestor 樣式),只在偵測到「`el` 自己 computed font-size 趨近 0」這個 MJML email 模板特徵時,才退到第一個 font-size 正常的後代寫入,避免回歸 v0.49 修掉的 MJML 段落消失問題。

效果：Wikipedia ambox 的 Chinese 譯文以乾淨純文字呈現在 `mbox-text` 區塊內,沒有 italic / bold / nested wrapper 繼承；MJML email 的 font-size:0 outer TD 仍可正確注入 inner DIV。代價是 fallback 路徑的譯文會失去 inline link / formatting,但對於 LLM 已經結構性放棄的段落來說,「乾淨純文字」遠優於「視覺災難」。

**v0.54 修正：`replaceNodeInPlace` 預設改走「整段覆蓋」路徑**：v0.52 / v0.53 收尾後 Wikipedia ambox 仍呈現 italic + bold 災難，再次經 Chrome MCP 實地檢視 LLM 回覆與 DOM 才定位到真正根因——根本不在 LLM 端：v0.53 重新測試時 ambox 的 17 個 slot 在 LLM 回覆裡都是唯一的、巢狀正確、deserializer 也正常產出 fragment，根本不會走 fallback。問題在 `replaceNodeInPlace` 這個 slots 路徑的注入函式：v0.49 為了修 MJML 的字體消失問題，把所有 case 都改成「找出最長文字節點，把 fragment 插在它原位、其他文字節點清空」。**這條策略對含 inline 巢狀的 ambox 是錯的**：ambox 內最長的文字節點剛好是「Learn how and when to remove this message」（41 字），它坐落在 `SPAN.hide-when-compact > I > SMALL > A` 內部。`replaceNodeInPlace` 把整段中文 fragment 插到那個位置 → 譯文整段繼承 italic + small + 連結樣式，**而 el 上原本的 `<B>` 等其他 inline element 又從未被清掉**，殘留成「外層空殼 B + 內部深埋的中文 fragment」結構，視覺上就是 v0.51–v0.53 一直無法破解的災難。

修法：`replaceNodeInPlace` 改成兩條互斥路徑：
1. **預設（A）整段覆蓋**：`while (el.firstChild) el.removeChild(...)` 後直接 `el.appendChild(frag)`。fragment 由 `deserializeWithPlaceholders` 從 slots 重建，本身就含完整結構（含原本所有 inline 元素 / 媒體 atomic placeholder），整段覆蓋是安全的，且不會繼承任何 inline ancestor 樣式。
2. **MJML 例外（B）就地替換最長文字節點**：偵測 `el` 自己 computed font-size 趨近 0（MJML / Mailjet 等 email 模板常見的 `font-size:0` inline-block-gap 消除技巧），命中時才退回 v0.49 的舊路徑保留 inner wrapper，避免文字繼承外層 0px 而消失。

效果：Wikipedia ambox / 一般網頁的 slots 路徑直接整段替換，不再有 inline ancestor 樣式污染；MJML email 的 font-size:0 case 維持 v0.49 修法不回歸。v0.51 為了解 ambox 加的「serialize 階段 sentinel 區分 BR / source `\n`」與 v0.52 加的「slot 重複偵測 + plainTextFallback」都保留，當作正確且必要的下游防線（前者保證 prompt 段落結構正確，後者作為 LLM 真的失敗時的 graceful degradation）。

**v0.55 重構：三條注入路徑統一共用 `resolveWriteTarget` + `injectIntoTarget`**：v0.54 修好 ambox 後，回頭盤點發現三條「把譯文寫回 DOM」的路徑各自實作了不一致的策略——`replaceNodeInPlace`（slots 路徑 fragment 注入）、`plainTextFallback`（slots 配對失敗後的純文字 fallback）、`replaceTextInPlace`（無 slots 路徑的純文字注入）。三者都需要解決同樣的問題（「要寫到哪個元素？要如何寫？」），但 v0.49–v0.54 是各自疊加補丁：`replaceTextInPlace` 一直用「最長文字節點就地替換」，`plainTextFallback` 在 v0.52 加了「font-size<1 → 找內層 wrapper」的 MJML 檢測，`replaceNodeInPlace` 在 v0.54 加了另一版 MJML 檢測並切換到 clean-slate 預設。三條路徑邏輯發散，下一次 MJML 排版變種可能會在其中一條先炸，又變成「修了這條、忘了那條」的補丁戰爭。

v0.55 把注入邏輯抽成兩個共用 helper：

1. **`resolveWriteTarget(el)`**：回答「要把譯文寫到哪個元素？」預設回傳 `el` 自己；若偵測到 `el` 自己 computed `font-size < 1px`（MJML / Mailjet 等 HTML email 用 `font-size:0` 消除 inline-block-gap 的業界標準做法），改回傳「第一個 font-size 正常的後代」當寫入目標，這樣內層 wrapper 提供的字體大小才不會因為清空 `el.children` 而消失。
2. **`injectIntoTarget(target, content)`**：回答「要怎麼把譯文寫進 target？」預設走 clean slate——清空 `target.children` 後 append content。若偵測到 `containsMedia(target)`（target 含 `<img>` / `<svg>` / `<video>` / `<picture>` / `<audio>` / `<canvas>` 這類**序列化階段會被丟掉的**元素），改走「就地替換最長文字節點」：找到 target 底下最長的可見文字節點，把 content 插在它的原位、其他文字節點清空，但 element children（含媒體）原封保留。這個分支同時修了 v0.54 留下的一個潛在回歸——**paragraph 中間插著 `<img>` 的 slots 路徑**，v0.54 的 clean-slate 會把 img 清掉，v0.55 改由 `containsMedia` 觸發 media-preserving 路徑補救。

`replaceNodeInPlace`、`plainTextFallback`、`replaceTextInPlace` 全部瘦身成「`resolveWriteTarget` → `injectIntoTarget`」的 3 行薄包裝，只剩「要注入什麼」（fragment vs 純文字 vs 帶 `<br>` 的 fragment）的差異。

重構的意義不只是 DRY：它**描述性地**把「寫入目標解析」與「注入策略」這兩個問題從實作細節升格成**兩條結構性規則**。未來新的注入場景（例如 Shadow DOM、iframe 內嵌段落）只需要問「這個 target 的 font-size 特徵如何？含不含媒體？」就能套用同一套判斷，不必每條路徑重新想一次。符合 CLAUDE.md 新增的硬規則 8「Bug 修法必須是結構性通則，不可以是站點/edge case 特判」。

### 4.2.1 可保留行內元素清單

`PRESERVE_INLINE_TAGS`（直接保留外殼）：
```
A, STRONG, B, EM, I, CODE, MARK, U, S, SUB, SUP,
KBD, ABBR, CITE, Q, SMALL, DEL, INS, VAR, SAMP, TIME
```

`SPAN`：僅當帶有 `class` 屬性或非空 `style` 屬性時才保留（純無屬性 `<span>` 視為樣式包覆物，無保留必要）。

**原子保留 (`isAtomicPreserve`)**：以下元素整個 deep clone 進 slot，並用自閉合佔位符 `⟦*N⟧` 取代，內部文字完全不送 LLM：
- `<sup class="reference">…</sup>`：Wikipedia 腳註參照（`[2]`、`[3]` 等）。整段不可翻譯、不可改格式（避免被改全形）、且需保留內部 `<a href="#cite_note-…">` 跳到註腳的連結。

佔位符字元用 `⟦` (U+27E6) 與 `⟧` (U+27E7) — 自然語言幾乎不會出現，LLM 也會乖乖保留。共有兩種形式：
- **配對型** `⟦N⟧…⟦/N⟧`：保留 inline 元素的「殼」（href、class、style 等屬性），中間的文字交給 LLM 翻譯。**v0.32 起可巢狀**，例如 `⟦0⟧foo ⟦1⟧bar⟦/1⟧ baz⟦/0⟧` 對應 `<b>foo <a>bar</a> baz</b>`，外層 slot 的殼會用遞迴解析出的子 fragment 作為子節點。
- **自閉合** `⟦*N⟧`（v0.25 新增）：原子保留位置記號，整段內容不可翻譯，slot 存 deep clone，反序列化時直接整包塞回去。

### 4.3 還原機制

每次 `injectTranslation` 執行時會把 `el.innerHTML` 備份到 `STATE.replaced` 陣列。再次按 Option+S 會呼叫 `restorePage()` 逐一還原。

### 4.4 視覺樣式

原文元素的 font-family、font-size、color、layout 完全不動。不加邊框、背景、左邊線等任何裝飾。**重點：保留完整原本網頁排版，包括字體形式及大小。**

---

## 5. 段落偵測規則

### 5.1 通用規則（v0.13）

**納入的 block tags**：
```
P, H1, H2, H3, H4, H5, H6, LI, BLOCKQUOTE, DD, DT,
FIGCAPTION, CAPTION, TH, TD, SUMMARY
```

**硬排除 tags**（整個子樹不走）：
```
SCRIPT, STYLE, CODE, PRE, NOSCRIPT, TEXTAREA, INPUT, BUTTON, SELECT
```

**語意容器排除**(tag-based)：`NAV`、`FOOTER` 永遠跳過整個子樹。

**ARIA role 容器排除**：祖先鏈中若有任何元素的 `role` 屬於 `banner` / `navigation` / `contentinfo` / `search`，則跳過。`HEADER` 僅在明確標 `role="banner"` 時才排除（保留文章區塊的 header）。

**v0.31 起移除內容性 selector 排除**：content.js 不再以 class / selector 判斷「這段讀者該不該看」。原本在 v0.29–v0.30 使用的 `EXCLUDE_BY_SELECTOR`（`.ambox, .box-AI-generated, .box-More_footnotes_needed`）已全數移除。

原因：這類判斷屬於「內容品味」而非「技術性必須跳過」，應該由 Gemini 的 `systemInstruction` 統一決定，避免 selector 與 prompt 兩條路徑互相衝突。讀者在台灣實際是需要看到 Wikipedia 維護警告框中文版的（例如「本條目可能包含 AI 生成內容」），用 selector 一刀切反而造成體驗缺口。

對應硬規則寫在 `CLAUDE.md`：「翻譯範圍由 system prompt 決定，不由 selector 決定」。

**選擇器補抓**(`INCLUDE_BY_SELECTOR`)：Wikipedia 常用但以 DIV/SPAN 包裝的元素，透過 selector 主動加入：
```
#siteSub, #contentSub, #contentSub2, #coordinates,
.hatnote, .mw-redirectedfrom, .dablink, [role="note"],
.thumbcaption
```

**注意**：Wikipedia 的 `{{thumb}}` / `{{wide image}}` template 把圖片說明放在 `<div class="thumbcaption">` 而不是 `<figcaption>`，所以必須透過 selector 補抓。元素本身不含 `<img>`（圖片在兄弟節點 `.thumbinner` 內），可直接走純文字 `textContent` 替換路徑。

### 5.2 Mixed-content 段落單位（v0.36 重寫，原名「葉子優先規則」）

v0.35 以前的策略是純「葉子優先」：若一個 block 元素內含其他 block tag 子孫，walker SKIP 父元素讓子元素獨立處理。這個做法對純葉子 block、以及「純容器 + 全部是 block 子孫」兩種情況都對，但對 **mixed-content block**（既有自己的直接文字、又含 block 後代）會**漏掉父元素自己的引言文字**。

典型案例：Stratechery 的編號列表
```html
<li>  ← 外層 LI
  <strong>Everything I Didn't Write</strong>. This was one of those weeks...
  <ul>  ← 巢狀 UL
    <li>子項目 A</li>
    <li>子項目 B</li>
  </ul>
</li>
```
v0.35 的行為：外層 `<li>` 被 SKIP，內層 `<li>` 各自 ACCEPT，**「Everything I Didn't Write. This was...」整句引言文字孤立、完全沒送翻譯**。類似結構也常見於 `<blockquote>`（引言 + 子段落）、`<td>`（文字 + 巢狀表格）、`<figure>`（caption + 圖 + 附註）、Medium / Substack 的步驟列表。

**v0.36 新策略**：walker 對含 block 後代的父元素仍然 SKIP 讓子 block 獨立收，**但同時**在 SKIP 分支裡呼叫 `extractInlineFragments(el)`，把父元素自己的直接子節點切成一或多個「fragment 段落單位」。每個 fragment 涵蓋一段連續的 inline-level 子節點（`startNode` 到 `endNode`），送翻譯時與一般 element 段落同等對待，但序列化/注入只動這個範圍內的節點，不動其他 block 子孫。

**段落單位型態**：
```js
{ kind: 'element',  el }
{ kind: 'fragment', el, startNode, endNode }
```
`element` 型態保持 v0.35 以前的語意（整個元素是葉子 block，翻譯覆蓋整個內容）。`fragment` 型態代表「`el` 這個元素裡，從 `startNode` 到 `endNode`（含兩端）這段連續的直接子節點」。

**inline-run 判定**（`isInlineRunNode`）：節點能被納入連續 inline-run 的條件：
1. 文字節點 → 是
2. `HARD_EXCLUDE_TAGS`（SCRIPT / STYLE / ...）→ 否（整段排除）
3. `BLOCK_TAGS_SET` 中的 tag → 否（這是子 block，獨立處理）
4. 本身含 block 後代（例如 `<ul><li>...</li></ul>`）→ 否（視為 block-run，因為裡面有 block 在裡面）
5. 其他 element → 是（視為 inline，包括 `<a>`、`<strong>`、`<span>`、`<br>` 等）

**Run 切割規則**：掃過 `el.childNodes`，將連續的 inline-run 節點組成 run；遇到非 inline-run 節點（block-run）時 flush 當前 run。每個 run 若有實質文字（字母 / CJK / 數字）才收為 fragment 單位，純空白或純標點的 run 會被丟棄。

**注入策略**（`injectFragmentTranslation`）：
1. 同一個 parent `el` 第一次被任何 fragment 或 element 單位碰到時，快照 `el.innerHTML` 到 `STATE.originalHTML`（Map，保證只快照一次原始狀態，不會被後續 fragment 的中途狀態污染）
2. 根據 slots 反序列化譯文成新 DocumentFragment 或 text node
3. 移除 `startNode` 到 `endNode` 之間（含兩端）的所有節點
4. 在原位置（`endNode.nextSibling` 前）insert 新內容

**重複翻譯保護**：v0.36 fragment 注入**不**在 parent `el` 設 `data-shinkansen-translated` 標記，因為同一個 parent 底下還有其他 fragment 或 block 子孫需要被 walker 見到。fragment 的重複翻譯保護依賴頁面層級的 `STATE.translated` flag（切換翻譯時透過 `restorePage()` 還原）。Element 模式的標記行為不變。

**還原策略**（`restorePage`）：iterate `STATE.originalHTML` Map，每個 entry 設 `el.innerHTML = originalHTML` 並清掉 `data-shinkansen-translated` 屬性。由於 snapshot 只在第一次碰觸時寫入，同一個 parent 底下多個 fragment 全部還原時都會回到同一份正確的原始 HTML。

**實作**：`containsBlockDescendant(el)` 走 `el.getElementsByTagName('*')` 檢查是否有任何後代 tag 在 `BLOCK_TAGS_SET`（與 v0.35 相同）。`extractInlineFragments(el)` 與 `isInlineRunNode(child)` 為 v0.36 新增。

### 5.3 可見性檢查

隱藏元素（例如 Wikipedia 的「50 languages」下拉選單內容）會被過濾掉。若被收進 batch 會因為段數過多造成 Gemini 回應分隔對齊錯亂，且無意義。

實作 `isVisible(el)`：
1. `el.offsetParent === null` 且 `getBoundingClientRect()` 寬高都是 0 → 隱藏
2. computed style 的 `visibility === 'hidden'` 或 `display === 'none'` → 隱藏

### 5.4 文字候選過濾

`isCandidateText(el)`：
1. `innerText.trim().length >= 2`
2. 至少含一個拉丁字母或西里爾字母（`/[A-Za-zÀ-ÿ\u0400-\u04FF]/`）—— 純中日韓文字段落不翻（視為已是目標語言或無需翻譯）

### 5.5 重複翻譯保護

已翻譯過的元素會被標記 `data-shinkansen-translated="1"`，walker 遇到此屬性會 REJECT，避免重複處理。

### 5.6 四大網站專屬規則（規劃中）

- **Wikipedia**：通用規則 + INCLUDE_BY_SELECTOR 已支援基本需求。Infobox 的含圖 TD 透過媒體保留策略處理。
- **Gmail**：郵件內容在動態載入的 iframe 與 `div[role="listitem"]` 內。需監聽 MutationObserver。（未實作）
- **Twitter/X**：推文內容在 `article[data-testid="tweet"] div[lang]`。（未實作）
- **Medium**：文章內容在 `article` 內。（未實作）

---

## 6. 專案檔案結構（實際）

```
Immersive Translation Clone/
├── SPEC.md                    ← 本文件
├── shinkansen/                ← Chrome Extension 本體
│   ├── manifest.json          ← 擴充功能設定檔（含 version）
│   ├── background.js          ← Service Worker：訊息路由、快取管理、版本檢查
│   ├── content.js             ← 內容腳本：段落偵測、Toast、DOM 注入、還原（全部整併在此）
│   ├── content.css            ← 幾乎為空（原本的雙語樣式已移除）
│   ├── popup/
│   │   ├── popup.html         ← 工具列小面板
│   │   ├── popup.css
│   │   └── popup.js           ← 翻譯按鈕、自動翻譯、快取資訊、清除快取
│   ├── options/
│   │   ├── options.html       ← 設定頁：API Key、模型、參數、黑白名單、Debug Log、匯出匯入
│   │   ├── options.css
│   │   └── options.js
│   ├── lib/
│   │   ├── gemini.js          ← Gemini API 封裝 + 分批 + 對齊 fallback
│   │   ├── cache.js           ← 持久化翻譯快取（SHA-1 + chrome.storage.local）
│   │   ├── storage.js         ← 設定讀寫封裝 + DEFAULT_SETTINGS
│   │   ├── logger.js          ← Debug Log 封裝
│   │   ├── detector.js        ← （預留；目前偵測邏輯內嵌在 content.js）
│   │   └── injector.js        ← （預留；目前注入邏輯內嵌在 content.js）
│   ├── icons/
│   │   ├── icon.svg          ← 浮世繪風格設計原始檔（富士山+紅日+海浪+新幹線）
│   │   ├── icon-16.png       ← toolbar 小尺寸
│   │   ├── icon-32.png
│   │   ├── icon-48.png       ← extension 管理頁
│   │   └── icon-128.png      ← Chrome Web Store
│   └── _locales/
│       └── zh_TW/messages.json
└── README.md
```

**備註**：規格原本規劃 `detector.js` 與 `injector.js` 獨立檔案，但因 content script 不支援 ES module import，所有偵測與注入邏輯目前整併在 `content.js` 中自包含。兩個 lib 檔保留為空殼，未來若拆分成多個 content script 再啟用。

---

## 7. 資料流程

### 7.1 翻譯請求流程

1. 使用者點 Popup「翻譯本頁」或按 Option+S。
2. `content.js` 的 `collectParagraphs()` 依據第 5 節規則抓出所有待翻譯元素，存成 elements 陣列。
3. `content.js` 把 elements 的 `innerText` 組成 texts 陣列，**分批**（字元預算 + 段數上限雙門檻 greedy 打包，詳見第 3.5 節）。
4. 對每一批：
   a. 透過 `chrome.runtime.sendMessage({type: 'TRANSLATE_BATCH'})` 傳給 `background.js`。
   b. `background.js` 對每段算 SHA-1，**先查快取**(`cache.getBatch`)一次性取得所有命中。
   c. 沒命中的才送 Gemini(`translateBatch`)。
   d. 新翻譯寫回快取（`cache.setBatch`）。
   e. 合併「快取結果 + 新翻譯」按原順序回傳。
5. `content.js` 收到回應後立刻 `injectTranslation` 到對應的 DOM 元素，更新 Toast 進度。
6. 下一批繼續。
7. 全部完成後 Toast 顯示「翻譯完成 （N 段）」，不自動消失。

### 7.2 錯誤處理

API Key 無效、網路失敗、速率限制 → Toast 顯示紅色錯誤提示，不自動消失，附錯誤訊息。

---

## 8. 設定資料結構

### 8.1 `chrome.storage.sync`（跨裝置同步，100KB 上限）

```json
{
  "apiKey": "",
  "geminiConfig": {
    "model": "gemini-2.0-flash",
    "serviceTier": "DEFAULT",
    "temperature": 0.3,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 8192,
    "systemInstruction": "（預設 System Prompt）"
  },
  "pricing": {
    "inputPerMTok": 0.10,
    "outputPerMTok": 0.40
  },
  "targetLanguage": "zh-TW",
  "domainRules": {
    "whitelist": [],
    "blacklist": []
  },
  "autoTranslate": true,
  "debugLog": false
}
```

**pricing 欄位說明**：計算翻譯成本用的 Gemini 單價，單位是 **USD per 1,000,000 tokens**。預設值是 gemini-2.0-flash 的官方報價（$0.10 / $0.40）。使用者切換模型時需到設定頁自行更新。

**注意**：
- 原規格的 `displayMode` 欄位已移除（沒有雙語模式）。
- `shortcuts` 欄位移除（快捷鍵由 Chrome 原生 commands API 管理，使用者到 `chrome://extensions/shortcuts` 改）。

### 8.2 `chrome.storage.local`（本地，5MB 上限）

**翻譯快取**：
```
tc_<sha1_hex>  →  "<譯文字串>"
```

**版本標記**：
```
__cacheVersion  →  "0.18"
```

service worker 啟動時比對 `__cacheVersion` vs `manifest.version`，不一致則清空所有 `tc_` 開頭的 key，並更新版本標記。

**累計使用量統計**：
```
usageStats  →  {
  totalInputTokens: number,
  totalOutputTokens: number,
  totalCostUSD: number,
  since: ISO timestamp   // 上次重置的時間
}
```
每次 `handleTranslate` 真的打了 Gemini 之後，background.js 會把該批次的 token 與費用加進此物件。使用者在 Popup 點「重置統計」會把數字歸零、`since` 更新為當下時間。**此統計不隨版本自動清空**（與翻譯快取的行為不同），這樣使用者可以長期追蹤費用。

---

## 9. 翻譯快取（詳細規格）

### 9.1 設計目標

- 同一段文字在不同頁面、不同會話都能命中
- Extension 版本變更時自動失效（確保 prompt/模型變更後不殘留舊結果）
- 使用者可隨時手動清除
- 儲存成本低（SHA-1 key 只有 40 字元）

### 9.2 Key 設計

`tc_` + SHA-1（原文十六進位） = 43 字元固定長度。同一段原文 → 同一 key，跨頁面可共用。

**重要**：key **只** hash 原文，不含模型、system prompt 等其他因子。保持簡單；換模型/改 prompt 時以「版本自動清空」機制處理。

### 9.3 批次讀寫

- `cache.getBatch(texts)`：一次 `storage.local.get(allKeys)`，效能遠優於逐個 get
- `cache.setBatch(texts, translations)`：一次 `storage.local.set(updates)`

### 9.4 清空邏輯

- `cache.clearAll()`：取得所有 local key，filter 出 `tc_` 開頭的 remove 掉（保留 `__cacheVersion` 等非快取資料）
- `cache.checkVersionAndClear(currentVersion)`：比對版本，不一致則 clearAll 並更新 `__cacheVersion`

### 9.5 統計

`cache.stats()` 回傳 `{ count, bytes }`，用於 Popup 顯示。bytes 只計 key + value 字元長度的粗估，不含 storage API 內部 overhead。

### 9.6 觸發時機

- **Service worker 每次啟動**（含 reload extension）：自動執行 `checkVersionAndClear`
- **`onInstalled` 事件**：雙重保險再執行一次
- **使用者在 Popup 點「清除快取」**：發送 `CLEAR_CACHE` 訊息

---

## 10. 里程碑

- **M1 規格確認**：✅ 完成
- **M2 專案骨架**：✅ 完成，檔案可載入
- **M3 核心翻譯流程**：✅ 完成，含分批、漸進注入、快取、Toast
- **M4 Popup 與 Options**：✅ 完成基本版，含快取管理
- **M5 四大網站測試與調優**：🔄 進行中（Wikipedia 大致堪用，Gmail/Twitter/Medium 未開始）
- **M6 錯誤處理與邊緣情境**：部分完成
- **M7 使用說明 README 與打包**：尚未開始

---

## 11. 設定同步策略

**主方案 — `chrome.storage.sync`**：
Chrome Extension 無法直接存取 iCloud（iCloud 僅開放給 macOS/iOS 原生 App 與 Safari 擴充功能）。因此主要同步機制使用 `chrome.storage.sync`，透過使用者登入的 **Google 帳號**，自動將設定同步到所有登入同一 Google 帳號的 Chrome。單項 8KB、總容量 100KB 上限。

**備援方案 — 匯出 JSON 至 iCloud 雲碟**（規劃中）：
設定頁提供「匯出到 iCloud 雲碟」按鈕，將設定打包成 `shinkansen-settings-YYYYMMDD.json`，預設引導使用者存到 `~/Library/Mobile Documents/com~apple~CloudDocs/Shinkansen/`。另一台 Mac 可透過「從檔案匯入」讀回。

**快取不同步**：翻譯快取存在 `chrome.storage.local`，不跨裝置同步（容量太大且各人瀏覽內容不同）。

---

## 12. 快捷鍵

預設快捷鍵：**Option + S**(macOS)/ **Alt + S**（其他 OS）—— 切換目前分頁的翻譯狀態（未翻譯則翻譯；已翻譯則還原原文）。

於 `manifest.json` 的 `commands` 區塊宣告：
```json
"commands": {
  "toggle-translate": {
    "suggested_key": { "default": "Alt+S", "mac": "Alt+S" },
    "description": "切換目前分頁的翻譯"
  }
}
```

使用者可至 `chrome://extensions/shortcuts` 調整。

---

## 13. 翻譯狀態提示（Toast）

### 13.1 位置與容器

- 位置：`position: fixed; bottom: 24px; right: 24px; z-index: 2147483647`
- 容器：透過 Shadow DOM 隔離（`attachShadow({ mode: 'closed' })`)，避免被網頁既有 CSS 影響
- 寬度：280px
- 外觀：白底、12px 圓角、陰影

### 13.2 內容區塊

```
┌────────────────────────────────┐
│ 翻譯中… 40 / 236   1 分 23 秒 × │
│ ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░ │
└────────────────────────────────┘
```

- **訊息文字**（左）：狀態 + 當前進度
- **計時器**（中偏右）：顯示經過時間，0.5 秒更新一次（`0 秒` / `1 分 23 秒`）
- **關閉按鈕 `×`**（右）
- **進度條**（下方）：4px 高，藍色/綠色/紅色依狀態

### 13.3 狀態

| 狀態 | 主訊息 | 第二行（detail） | 進度條 | 自動消失 |
|---|---|---|---|---|
| loading（有確定進度） | `翻譯中… N / Total` | - | 藍色，寬度 = N/Total | 否 |
| loading（無確定進度） | `翻譯中…` | - | 藍色，流動動畫 | 否 |
| success（有成本） | `翻譯完成 （N 段）` | **兩行格式**（v0.48 起）：第一行 `X,XXX tokens (XX% hit)`、第二行 `$0.0028 (XX% saved)`，數字皆為 implicit cache 折扣後的實付值；命中率為 0 時不顯示括號 | 綠色，100% | **否**（v0.47 起：點擊 toast 以外任何區域即關閉；× 按鈕保留作為備援） |
| success（全部快取命中） | `翻譯完成 （N 段）` | `全部快取命中 · 本次未計費` | 綠色，100% | 否 |
| success（無統計） | `翻譯完成 （N 段）` | - | 綠色，100% | 否 |
| error | `翻譯失敗：<msg>` | - | 紅色，100% | 否 |
| 還原成功 | `已還原原文` | - | 綠色，100% | 是，2 秒 |

**兩行設計**：token 與費用放在 `<div class="detail">` 第二行，主訊息只保留段數，避免同一行文字過長被擠到換行。`showToast` 多接受一個 `opts.detail` 參數；沒給的話 detail 列以 `hidden` 隱藏。

**stale setTimeout 防禦**：`showToast` 模組內維護一個 `toastHideHandle` 追蹤當前的 autoHide timer。每次呼叫 `showToast` 都會先 `clearTimeout` 這個 handle，避免前一個 toast（例如「已還原原文」2 秒自動消失）的 setTimeout 在新 toast 出現後還照原訂時間觸發 hideToast，把新 toast 也一起殺掉。此 bug 在以下情境會出現：
1. 使用者剛翻完頁面
2. 按 Option+S 還原，觸發「已還原原文」+ autoHide 2 秒
3. 2 秒內又按 Option+S 重翻，因快取命中瞬間完成並顯示「翻譯完成」
4. 原本的 setTimeout 時間到就把「翻譯完成」一起關掉

**成本計算**（v0.48 起改為顯示實付值）：token 數來自 Gemini API 回應的 `usageMetadata.promptTokenCount`、`candidatesTokenCount` 與 `cachedContentTokenCount`。**實付費用**套用 Gemini implicit context cache 折扣：
```
billedCost = ((inputTokens − cachedTokens) + cachedTokens × 0.25) × inputPerMTok / 1M
           + outputTokens × outputPerMTok / 1M
```
`computeBilledCostUSD()` 實作在 `background.js`。toast 第二行 `$X.XXXX` 顯示的就是這個值，popup 「累計：$X.XX」也是這個值（`addUsage` 改為累計實付）。**實付等效 input tokens**：`billedInputTokens = max(0, inputTokens − cachedTokens × 0.75)`，代表「如果用原價算、相當於多少 tokens」，toast 第一行顯示的 `X,XXX tokens` 就是 `billedInputTokens + outputTokens`。**快取命中的段落（本地 `tc_<sha1>` 翻譯快取）不計算 token 與成本**（因為根本沒打 API）。

**Implicit cache 命中統計**（v0.46 起，v0.48 調整顯示方式）：`translateChunk` 會讀 `usageMetadata.cachedContentTokenCount`，這是本次輸入中被 Gemini implicit context cache 命中的 token 數（輸入 tokens 的子集）。累加到 `pageUsage.cachedTokens` 後，toast 兩行 detail 的括號內容如下：
- **第一行 `(XX% hit)`** = `cachedTokens / inputTokens × 100%`（分母是原始 promptTokenCount 總和，分子是其中命中的部分）— 代表「input 層 cache 命中比例」
- **第二行 `(XX% saved)`** = `(originalCostUSD − billedCostUSD) / originalCostUSD × 100%` — 代表「費用層節省比例」。因為 output tokens 沒折扣，saved% 通常會比 hit% 略低幾個百分點
- 只在 `cachedTokens > 0` 時才把括號附加到兩行末尾，避免顯示「0% hit」「0% saved」刺眼
- 完整數字（`inputTokens / cachedTokens / outputTokens / billedInputTokens / billedTotalTokens / implicitCacheHitRate / originalCostUSD / billedCostUSD / costSavedRate / localCacheHitSegments`）會在 `translatePage` 成功時 `console.log` 一筆，方便事後在 DevTools 查實際數據與原價對照
- 注意：`pageUsage.cachedTokens` 與本地翻譯快取 `pageUsage.cacheHits` 是不同概念，前者是 Gemini 伺服器端的 prompt 前綴 cache（以 token 計）、後者是本地 `tc_<sha1>` 翻譯結果快取（以段數計），兩者同時存在互不干擾

### 13.4 設計原則

- **不使用轉圈 spinner**：改用橫向進度條 + 流動動畫，視覺上更明確
- **不使用左邊色條 border-left**：整個 toast 用單色陰影浮在畫面上
- **計時器持續跳動**：即使 Gemini 處理時間長，使用者看計時器在跳就知道 extension 還活著
- **成功提示不自動消失**：避免使用者沒注意到就錯過
- **翻譯完成的主 toast 以「點擊外部區域」為主要關閉方式**（v0.47 起）：right-hand `×` 按鈕保留為備援，但預期使用者大多直接點內容區即可關閉。「已還原原文」與「補抓」這類次要提示仍維持 `autoHideMs` 自動消失或完全不顯示
- **延遲 rescan 補抓在 UI 層完全隱形**（v0.47 起）：成功補抓只 `console.log`、失敗只 `console.warn`，不再 `showToast`，避免蓋掉帶著 token / 費用 / 快取命中率資訊的翻譯完成主 toast

### 13.5 API

```js
showToast(kind, msg, opts)
// kind: 'loading' | 'success' | 'error'
// opts: { progress?: 0..1, startTimer?: bool, stopTimer?: bool, autoHideMs?: number }
```

---

## 14. LLM 除錯 Log

設定頁提供開關 `debugLog`。開啟後，每次 API 呼叫會透過 `lib/logger.js` 記錄：
- 時間戳記
- 請求模型與參數
- 輸入段落（可截斷顯示）
- 輸出譯文
- 耗時（ms）與 token 使用量
- 錯誤訊息（若有）

Log 輸出到：
1. 瀏覽器 DevTools Console，加上 `[Shinkansen]` 前綴
2. 內建 Log 檢視頁（`options.html#logs`，規劃中）：最近 100 筆，可清空、可匯出 JSON

---

## 15. Popup 面板規格

### 15.1 版面

```
┌─────────────────────────────┐
│ 🚄 Shinkansen         v0.13 │  ← header（版本號動態讀取）
├─────────────────────────────┤
│  ┌─────────────────────┐    │
│  │  翻譯本頁/顯示原文  │    │  ← primary button （依狀態切換標籤）
│  └─────────────────────┘    │
│                             │
│  白名單自動翻譯       [ ]   │
│                             │
│  ────────────────────────   │
│  快取： 1234 段 / 456 KB   清除快取
│  累計： $0.032 / 85.2K tok  重置統計
│                             │
│  就緒                       │  ← status
├─────────────────────────────┤
│ ⚙ 設定     Option+S 快速切換 │  ← footer
└─────────────────────────────┘
```

### 15.2 互動

- **主按鈕**：開啟 popup 時透過 `GET_STATE` 訊息查詢當前分頁是否已翻譯。
  - 未翻譯 → 按鈕顯示「翻譯本頁」
  - 已翻譯 → 按鈕顯示「顯示原文」
  - 點擊一律發送 `TOGGLE_TRANSLATE`（content.js 內部依當前狀態 toggle 翻譯／還原）
  - 若頁面尚未注入 content script（例如 `chrome://` 頁），按鈕維持預設「翻譯本頁」
- **白名單自動翻譯**：toggle `autoTranslate` 設定
- **快取資訊**：開啟 popup 時透過 `CACHE_STATS` 訊息向 background 查詢
- **清除快取**：confirm → 發送 `CLEAR_CACHE` 訊息 → 更新顯示
- **累計費用**：開啟 popup 時透過 `USAGE_STATS` 訊息查詢，顯示格式 `累計： $X.XXXX / N tokens`
- **重置統計**：confirm → 發送 `RESET_USAGE` 訊息 → 歸零並更新顯示（不會動到翻譯快取）
- **設定**：`chrome.runtime.openOptionsPage()`

### 15.3 版本顯示

Popup 右上角版本號 **必須** 透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死在 HTML 中。

---

## 16. 訊息協定（content ↔ background ↔ popup）

### 16.1 content → background

| type | payload | 回應 |
|---|---|---|
| `TRANSLATE_BATCH` | `{ texts: string[] }` | `{ ok, result: string[], usage: { inputTokens, outputTokens, costUSD, cacheHits } }` / `{ ok: false, error }` |

**usage 欄位說明**：只反映「這一批實際打 API 的部分」。完全快取命中時 `inputTokens = outputTokens = costUSD = 0`，`cacheHits = batch size`。

### 16.2 popup → background

| type | payload | 回應 |
|---|---|---|
| `CACHE_STATS` | - | `{ ok, count, bytes }` |
| `CLEAR_CACHE` | - | `{ ok, removed }` |
| `USAGE_STATS` | - | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` |
| `RESET_USAGE` | - | `{ ok, totalInputTokens: 0, ... }` |

### 16.3 background / popup → content

| type | 用途 | 回應 |
|---|---|---|
| `TOGGLE_TRANSLATE` | 觸發 `content.js` 的 `translatePage()`（toggle：已翻譯則還原） | - |
| `GET_STATE` | popup 開啟時查詢當前分頁是否已翻譯，用來決定按鈕標籤 | `{ ok, translated: bool }` |

### 16.4 content → background (icon badge)

| type | 用途 | 回應 |
|---|---|---|
| `SET_BADGE_TRANSLATED` | 翻譯完成後點亮當前分頁的紅點 badge（`●`，背景色 `#cf3a2c`） | `{ ok }` |
| `CLEAR_BADGE` | 還原原文、或 content script 初始化載入時清除 badge | `{ ok }` |

**實作細節**：
- background 透過 `chrome.action.setBadgeText({ text, tabId })` 設定 per-tab badge，`sender.tab.id` 取得發訊息的分頁 ID。
- `chrome.tabs.onUpdated` 監聽 `status === 'loading' && changeInfo.url`，在分頁跨站導航時自動清 badge（避免舊站的紅點殘留到新站）。
- content.js 在 IIFE 結尾也會主動發 `CLEAR_BADGE`，保險處理 SPA 同站內部導航（此時 `onUpdated` 的 `changeInfo.url` 可能不會觸發）。

---

## 16.5 Debug API（v0.29 新增，v0.30 擴充）

供自動化測試（Playwright）在 isolated world 查詢 content script 內部狀態。`content.js` 載入後會在自己的 isolated world window 掛上 `window.__shinkansen`：

```
window.__shinkansen = {
  version: string,                         // manifest version（getter，動態讀取）
  collectParagraphs(): Array,              // 純偵測：呼叫真實 collectParagraphs()，
                                           // 回傳序列化安全的 plain object 陣列
  collectParagraphsWithStats(): Object,    // v0.30 新增：同上但附帶 walker 跳過統計
  serialize(el): { text, slots },          // v0.32 新增：純函式曝露,供巢狀佔位符單元測試
  deserialize(text, slots): { frag, ok, matched }, // v0.32 新增：同上
  getState(): Object,                      // 當前翻譯狀態快照
}
```

**`collectParagraphs()` 回傳格式**：
```
[
  {
    index: number,
    tag: string,              // 'P' / 'LI' / 'H2' ...
    textLength: number,
    textPreview: string,      // 最多 200 字
    hasMedia: boolean,
    selectorPath: string,     // 'body > div#main > ul.refs > li'（最多 6 層）
  },
  ...
]
```

**`collectParagraphsWithStats()` 回傳格式**（v0.30 新增）：
```
{
  units: [ ...同 collectParagraphs() 回傳 ],
  skipStats: {
    hardExcludeTag: number,       // SCRIPT/STYLE/NOSCRIPT/TEMPLATE/CODE/PRE... 被硬擋
    alreadyTranslated: number,    // 帶 data-shinkansen-translated 屬性
    notBlockTag: number,          // 非 BLOCK_TAGS 成員（walker SKIP，非 REJECT）
    excludedContainer: number,    // 命中語意容器排除（nav/footer/role=banner 等）— v0.31 起不再包含 class selector 命中
    invisible: number,            // isVisible 判為不可見
    hasBlockDescendant: number,   // 有 block 子孫，讓葉子優先規則往下找
    notCandidateText: number,     // 沒有足夠文字內容
    acceptedByWalker: number,     // walker 階段通過
    includedBySelector: number,   // INCLUDE_BY_SELECTOR 補抓到的額外單位
  }
}
```

**設計細節**：`collectParagraphs(root, stats)` 在 v0.30 加了選擇性的 `stats` 參數，內部 walker 每條分支都會在命中時 tick 對應計數器；外部呼叫若不傳 `stats` 完全無副作用（正常翻譯路徑仍走 `collectParagraphs()` 不傳第二個參數）。這個設計取代了 v0.28 detector-probe 鏡像裡的 embedded counters——現在統計直接由真實偵測邏輯產出，不會再 drift。

**`getState()` 回傳格式**：
```
{
  translated: boolean,
  replacedCount: number,
  cacheSize: number,          // 當前 STATE.cache 的 Map size
}
```

**設計原則**：
1. **只查詢，不執行**：絕不暴露 `translatePage` / `injectTranslation` 這類會燒 API 額度或改變 DOM 的函式，避免測試誤觸真實翻譯。
2. **回 plain object，不回 DOM 參考**：DOM Element 無法跨 Playwright page↔node boundary 序列化，必須預先攤平成 JSON-safe 結構。
3. **`version` 動態對應 manifest**：測試端可 assert「debug API 版本 === 真實 Extension 版本」，若 drift 至少能被立即偵測。
4. **掛在 content script isolated world**：測試端（Playwright）存取需指定 `world: 'context'` 或透過 CDP 對 isolated world 跑 `Runtime.evaluate`。不從 main world 注入、不使用 page-script 注入。
5. **永遠啟用**：無 options 開關。理由是此 API 純唯讀、無副作用、不洩漏使用者資料，關閉它反而會讓「任意時刻都能檢查狀態」的可除錯性變差。未來若有效能疑慮再加 feature flag。

**相關測試**：`test/edo-detection.spec.js`（由 Claude Code 側維護的 Playwright 測試）使用此 API 取代先前臨時的 `detector-probe.js` 鏡像邏輯。

---

## 17. 已知議題與待辦

- **~~含媒體區塊的文字消失（v0.33 / v0.34 兩輪修復）~~**：Wikipedia 文章右上角的 `#coordinates` 在 `containsMedia` 路徑底下走「挑最長文字節點塞譯文、其餘清空」的策略時踩到兩個坑：(a) 內含一個 295 字元的 inline `<style>` CSS 區塊，比任何可見文字都長 → v0.33 在 walker 加 `HARD_EXCLUDE_TAGS`（SCRIPT/STYLE/NOSCRIPT/CODE/PRE）過濾修掉；(b) 過掉 STYLE 之後，剩下最長的反而是隱形的 `<span class="geo-nondefault"><span class="geo-dec">`（Wikipedia 座標的十進制備用格式，被 CSS `display:none`），而可見的 DMS 座標被切成 `Coordinates` / `35°41′02″N` / `139°46′28″E` 多個短節點 → 譯文還是塞進看不到的地方 → v0.34 再加 `display:none` / `visibility:hidden` 祖先過濾修掉。序列化側因為用 `el.innerText` 原本就會忽略 `<style>` 與 `display:none`，送給 Gemini 的原文無誤，只有注入側有 bug。教訓：text-node-replacement 策略本質上容易誤選到隱形或技術性節點，任何「挑最長」的啟發式都必須先過濾掉技術 / 隱形節點。
- **Wikipedia 維護模板翻譯品質**：v0.31 起 ambox 家族（`.ambox / .box-AI-generated / .box-More_footnotes_needed`）不再被 selector 排除，會送去翻譯。若未來觀察到某些維護模板被 LLM 翻得特別差、或特別浪費 token，應改走 `systemInstruction` 指示 LLM「這類警告框如何處理」，而非回頭新增 selector 排除。
- **分批 chunk 邊界**：v0.37 起改為 `MAX_UNITS_PER_BATCH = 20` + `MAX_CHARS_PER_BATCH = 3500` 雙門檻。需要觀察這組數字在不同頁面長度下對翻譯品質、速度、rate limit 觸發率的影響（尤其是超大段獨佔批次的頻率與對齊 fallback 率）。
- **快取 key 粒度**：目前 key 只含原文；若未來要支援多目標語言，需加入 targetLanguage 到 key。

---

## 18. 開放議題（未來再決定）

- Gemini 免費額度是否足夠日常使用？若不夠，加入速率與用量統計。
- 是否支援自動語言偵測後「只翻譯非中文內容」。
- 是否加入簡易的「翻譯歷史紀錄」查詢頁。
- 多 Provider 支援（OpenAI / Claude / DeepSeek / Ollama）的優先順序。
- 是否需要「部分重新翻譯」功能（清除特定段落的快取再翻）。

---

## 19. 未來架構規劃（v0.35+）

本節記錄下一階段確定會做的兩項主線架構升級：**並行翻譯** 與 **全文術語表一致化**。兩者合在一起可以同時解決「長文翻譯慢」與「長文名詞不一致」兩個目前最明顯的痛點。

**實作順序原則**：先做 19.1 並行翻譯，穩定後再做 19.2 術語表。原因是並行化本身就會引入 rate limit、注入順序、失敗重試等新的複雜度，先把純並行跑穩再疊上術語表，比較好除錯。

### 19.1 並行翻譯（✅ 已於 v0.35 實作）

> **狀態**：已實作並上線，此節作為架構歷史紀錄保留。實作檔案：`lib/rate-limiter.js`、`lib/tier-limits.js`、`background.js`（limiter 整合）、`content.js`（concurrency pool）、`lib/gemini.js`（429 重試）、`options/*`（效能與配額設定 UI）。

**現況（v0.34 以前）**：`content.js` 把段落切成 20 段一批，逐批呼叫 background 的 `TRANSLATE_BATCH`，**序列**等待每批回來才送下一批。長文（>100 段）會花十幾秒甚至更久，使用者體感很拖。

**目標**：改成「受 Gemini rate limit 三維度同時約束的並行 dispatcher」，同時間有多個請求在飛。以 Tier 1 + Gemini 2.5 Flash 為基準（300 RPM、2M TPM、1,500 RPD），理論上一分鐘可以處理 300 批 × 20 段 = 6,000 段。

#### Gemini Rate Limit 事實基礎（2026 年 4 月查詢）

Gemini 以**三個維度**同時限制請求，**任何一個超過就回 429**：

- **RPM**（Requests Per Minute）每分鐘請求數
- **TPM**（Tokens Per Minute，輸入側）每分鐘輸入 token 數
- **RPD**（Requests Per Day）每日請求數，太平洋時間午夜重置

**官方規格沒有 per-second 限制**，只有 per-minute。我們的 dispatcher 把 RPM / 60 當成平均 RPS 來攤平 burst 是自訂策略，不是 Gemini 的硬性規則。

**Rate limit quota 綁定在 Google Cloud Project，不是 API Key**——多把 key 共用一個 project 會共享額度。

**Rolling window**：Gemini 本身用滑動視窗評估，過去 60 秒連續計算，這與我們的 sliding window limiter 對齊。

**429 回應**會在 response header 帶 `Retry-After`（秒數），並在 response body 的 `details` 陣列中標示是哪個維度爆了。我們的 backoff 邏輯必須尊重 `Retry-After`。

**主要模型的各層數值**（MVP 只需關注 Tier 1，其他用於 tier 對照表預設值）：

| 層級 | 模型 | RPM | TPM | RPD |
|---|---|---|---|---|
| Free | Gemini 2.5 Pro | 5 | 250,000 | 100 |
| Free | Gemini 2.5 Flash | 10 | 250,000 | 250 |
| Free | Gemini 2.5 Flash-Lite | 15 | 250,000 | 1,000 |
| Tier 1 | Gemini 2.5 Pro | 150 | 1,000,000 | 1,000 |
| Tier 1 | **Gemini 2.5 Flash** | **300** | **2,000,000** | **1,500** |
| Tier 1 | Gemini 2.5 Flash-Lite | 300 | 2,000,000 | 1,500 |
| Tier 2 | Gemini 2.5 Pro | 1,000 | 2,000,000 | 10,000 |
| Tier 2 | Gemini 2.5 Flash | 2,000 | 4,000,000 | 10,000 |

免費層所有模型**共用**一個 250K TPM 池；付費層則是 per-model 各自獨立的池。

**資料來源**：ai.google.dev/gemini-api/docs/rate-limits 與 2026 年 Q1 業界整理文章。數字有可能改動，程式內的對照表屬於 v0.35 當下的快照，未來有變動時以 bump + 更新對照表的方式維護。

#### 核心元件

1. **三維 sliding window Rate Limiter**（`lib/rate-limiter.js`，新檔）
   - 內部維護兩個時間戳環形緩衝區：`requests[]`（時間戳）與 `tokens[]`（{時間戳, tokenCount}）
   - 另外維護一個 `dailyRequestCount` + 太平洋時間的日界判斷，用於 RPD
   - 每次要發請求前呼叫 `await limiter.acquire(estimatedInputTokens)`：
     - 先清除 60 秒前的舊時間戳
     - 判斷「現有請求數 + 1 > RPM 上限」、「過去 60 秒 token 累計 + estimate > TPM 上限」、「今日請求數 + 1 > RPD 上限」任一條件成立 → 計算最近一個會滑出視窗的時間點，`setTimeout` 等待後 retry
     - 三個維度都 OK 才落時間戳、增加計數、立即 return
   - `estimatedInputTokens` 用簡易估算：`Math.ceil(text.length / 3.5)`（英文約 4 字元/token，中文約 1.5 字元/token，取中間值偏保守）
   - **安全邊際**：每個上限乘以 `(1 - safetyMargin)`，預設 `safetyMargin = 0.1`，即實際只用 90% 的 quota，避免踩邊緣觸發 429

2. **Priority Queue + Dispatcher**（整合進 `background.js`）
   - 兩條 queue：`p0Queue`（保留給未來術語表請求）、`p1Queue`（翻譯批次）
   - Dispatcher 是一個 loop，`while (hasWork()) { await limiter.acquire(est); dispatch(task); }`
   - Dispatcher tick 每次**先看 p0 queue 再看 p1 queue**，確保術語表請求永遠插隊
   - `dispatch(task)` 不 await 任務完成，只 fire-and-forget——真正的 await 發生在 limiter.acquire，目的是讓下一個 tick 可以立刻開始排
   - 任務完成（成功或失敗）透過 callback / promise 回到 message handler

3. **In-flight 批次追蹤**
   - 每個批次有唯一 `batchId`（`${tabId}-${chunkIndex}-${timestamp}` 或單純 UUID）
   - Content.js 送出 `TRANSLATE_BATCH` 時附上 batchId 與該批段落的原始 index 陣列
   - Background 回傳 `TRANSLATE_BATCH_RESULT` 時帶回 batchId，content.js 用它找回 index 對照並注入到正確位置
   - **注入必須以段落原始 index 為準**，不可按到達順序線性注入

#### Tier 對照表與設定

**`shinkansen/lib/tier-limits.js`（新檔）** 匯出一張 hardcoded 對照表：

```js
export const TIER_LIMITS = {
  free: {
    'gemini-2.5-pro':        { rpm: 5,   tpm: 250_000,   rpd: 100 },
    'gemini-2.5-flash':      { rpm: 10,  tpm: 250_000,   rpd: 250 },
    'gemini-2.5-flash-lite': { rpm: 15,  tpm: 250_000,   rpd: 1000 },
  },
  tier1: {
    'gemini-2.5-pro':        { rpm: 150, tpm: 1_000_000, rpd: 1000 },
    'gemini-2.5-flash':      { rpm: 300, tpm: 2_000_000, rpd: 1500 },
    'gemini-2.5-flash-lite': { rpm: 300, tpm: 2_000_000, rpd: 1500 },
  },
  tier2: {
    'gemini-2.5-pro':        { rpm: 1000, tpm: 2_000_000, rpd: 10000 },
    'gemini-2.5-flash':      { rpm: 2000, tpm: 4_000_000, rpd: 10000 },
    'gemini-2.5-flash-lite': { rpm: 2000, tpm: 4_000_000, rpd: 10000 },
  },
};
```

**DEFAULT_SETTINGS 新增欄位**：

- `tier`: `'tier1'`（預設，合理推測大多使用者會升級付費）
- `safetyMargin`: `0.1`
- `maxRetries`: `3`
- `rpmOverride`: `null`（null 代表用 tier 對照表；非 null 時覆寫 RPM）
- `tpmOverride`: `null`（同上）
- `rpdOverride`: `null`（同上）

Rate limiter 初始化時：
```
const limits = TIER_LIMITS[settings.tier]?.[settings.model] ?? TIER_LIMITS.tier1['gemini-2.5-flash'];
const rpm = settings.rpmOverride ?? limits.rpm;
// ... 同理
```

**設定頁新增「效能與配額」區塊**：

- Tier 下拉（Free / Tier 1 / Tier 2 / 自訂）
- 當前模型的 RPM / TPM / RPD 顯示（根據 tier 自動計算，自訂 tier 才可編輯）
- 安全邊際 slider（0–30%，預設 10%）
- 今日已用 RPD 顯示（近似值，extension 自計）

#### 429 處理

在 `lib/gemini.js` 的 fetch wrapper 裡：

1. 收到 HTTP 429：
   - 讀 `Retry-After` header（若是整數秒數）或 `response.headers.get('retry-after')`
   - 若有值 → 等待該秒數 + 100ms 緩衝後重試
   - 若無值 → 指數退避 `2^n * 500ms`，上限 8 秒
2. 從 response body 的 `details` 陣列取出爆掉的維度（RPM/TPM/RPD），記錄到 debug log
3. 若爆的是 RPD → 不重試，直接回報「今日配額已用盡」
4. 其他維度重試次數計入 `settings.maxRetries`
5. 連續失敗 → 該批次標記為翻譯失敗，toast 提示

#### 其他實作要點

- **錯誤隔離**：某一批失敗不應該拖累其他批。非 429 的網路錯誤用 exponential backoff 重試 `maxRetries` 次。
- **Toast 進度條**：現行「X / Y 段完成」在並行下依然成立，但進度不再單調連續（可能跳段）。`toast` 用「已完成段數」做分子而非「已送出批次數」，避免進度條亂跳。計時器照舊。
- **取消邏輯**：使用者按還原原文時，background 側的 dispatcher 要能清空 queue 並 abort 所有 in-flight fetch。實作：per-tab 維護一個 `AbortController`，取消時呼叫 `abort()` 並把該 tab 的所有 pending task 從 queue 移除。
- **Service Worker 生命週期**：background 是 MV3 service worker，可能在 idle 時被 Chrome 回收。Rate limiter 狀態（sliding window 緩衝區）可以在回收後重建（視為全空），這是安全的——最壞情況是 worker 剛醒來時可能瞬間爆 burst，但由於 `safetyMargin` 存在，加上 Gemini 本身 rolling window 寬容度，實際風險低。RPD 計數需要 persist 到 `chrome.storage.local`（key `rateLimit_rpd_<YYYYMMDD>`），每天第一次寫入時順手清舊 key。

#### 為什麼 MVP 先不做這些

- **動態 rate limit 偵測**：從 429 回應學習真實 RPM。第一版先用靜態 tier 表，夠準。
- **TPM 精準計算**：第一版用字元數估算 input token，誤差可接受。未來可考慮用 Gemini 的 countTokens API，但會多一次往返，成本不值。
- **Priority-based 插隊的真正使用者**：MVP 階段 p0 queue 永遠是空的，留著給 19.2。架構先做對，使用留白。

### 19.2 全文術語表一致化（並行翻譯穩定後）

**問題陳述**：分批翻譯會造成同一個專有名詞在不同批次被翻成不同中文（例如 Einstein 在第 1 批變「愛因斯坦」，到第 5 批變「艾因斯坦」）。在 v0.35 並行翻譯上線後，這個問題會被放大——因為並行 dispatch 時，完全沒有「後一批可以看到前一批結果」的機會，rolling glossary 方案在並行下**徹底失效**，預先建立術語表成為唯一可行解。

**核心決策：術語表必須用與翻譯相同的模型**  
實測發現用較小的模型（例如 Flash Lite）擷取術語表，擷取出的譯名品質會顯著劣化，進而污染整篇譯文的一致性。因此術語表擷取固定使用使用者當前的翻譯模型（`settings.model`），不得降級。這會讓術語表請求吃掉翻譯的 rate limit 預算，dispatcher 設計必須把術語表請求放在 priority 0 讓它插隊優先發出。

**依文章長度自適應的策略**：

| 批次數 | 術語表策略 | 首批是否等術語表 |
|---|---|---|
| 1 批（≤ 20 段） | 不建術語表 | — |
| 2–5 批（20–100 段） | 平行發出，首批不等術語表 | 否 |
| > 5 批（> 100 段） | **阻塞等術語表回來再灑翻譯** | 是 |

- **短文**完全跳過術語表，一批之內 Gemini 內部本來就會保持一致。
- **中文**術語表與第一批同時發出，第一批不等；從第二批起帶術語表。代價是前 20 段沒術語表保護。
- **長文**等術語表回來再並行灑出所有翻譯批次。因為長文 time-to-first-paint 本來就不可能快，多等術語表的 1–2 秒在感知上幾乎無差，但換到從第一段起全篇一致，效益最高。

門檻用常數控制：
```
GLOSSARY_SKIP_THRESHOLD = 1       // ≤ 此批次數完全不建術語表
GLOSSARY_BLOCKING_THRESHOLD = 5   // > 此批次數則阻塞等術語表
```

**術語表擷取的 prompt 設計**：

- 明確要求「只列專有名詞、人名、地名、作品名、技術術語；普通名詞不要列」
- 強制 JSON structured output，schema `{source, target, type}`，`type` 四選一：`person / place / tech / work`
- 上限 200 條（超過截斷，邊際效益遞減）
- `systemInstruction` 重用翻譯用的系統提示骨幹，但尾端追加「本次任務只做術語擷取，不翻譯段落」

**輸入壓縮**：整篇長文送進去會浪費 token。只送「名詞最常出現的地方」：所有 heading（h1–h6）、每段第一句、`<figcaption>`、表格 caption、頁面標題。這樣通常可壓到原文 20–30%，而且召回率仍高（第二次出現的名詞一定被第一次出現過）。

**術語表注入翻譯 prompt 的方式**：

在 `systemInstruction` 尾端追加一段：

```
以下是本篇文章的術語對照表，遇到這些原文一律使用指定譯名，不可自行改寫：
<source> → <target>
<source> → <target>
...
```

放在 `systemInstruction` 比放 user message 穩定，Gemini 比較不會「忘記」。

**術語表快取**：

- 存在 `chrome.storage.local`
- key 格式：`gloss_<sha1(壓縮後的輸入)>`
- 命中時直接使用，不再發術語表請求
- Extension 版本變更時與翻譯快取一起清空
- 設定頁的「清除快取」要同時清 `tc_*` 與 `gloss_*`
- Popup 的快取統計可選擇是否分開顯示術語表條目

**Rate limit 預算互動**：

- 術語表請求入 priority 0，下一次 dispatcher tick 立刻發出
- 該秒內其他 priority 1 翻譯請求只能拿剩下 4 個 slot
- 術語表發出後不影響後續秒數的 slot 配額
- 若使用者把 `maxRequestsPerSecond` 設為 1（極端情況），術語表請求會完全阻塞第 1 秒的翻譯——這是預期行為，使用者自己的取捨

**失敗處理**：

- 術語表請求失敗或逾時（例如 10 秒內沒回）→ fallback 成「不帶術語表」的一般翻譯流程，不卡住整個翻譯
- Toast 不顯示術語表失敗（這是錦上添花，不是必要功能），但 debug log 要記錄
- 若術語表回傳但 JSON 格式錯誤 → 視為失敗走 fallback，不嘗試 partial parse

**Toast 顯示**：

- 長文阻塞等術語表期間，toast 顯示「建立術語表⋯」
- 術語表拿到後，toast 切換為平常的「翻譯 X / Y」
- 中文平行模式下不顯示術語表狀態（避免訊息過多干擾）

**一致性 fix-up pass（明確不做）**：

中檔文章的前 20 段在沒有術語表的狀態下翻譯完成後，理論上可以對已注入的譯文做 search/replace 對齊術語表。**v0.35+ 階段明確不做**，因為：

1. DOM 重繪會造成字幕閃爍，使用者體驗差
2. search/replace 容易誤傷（例如譯名出現在複合詞裡）
3. 複雜度與收益不成比例

若中檔文章的前段不一致顯著才重新評估。

### 19.3 與現有規格的互動

- **第 3.5 節（分段請求協定）**：v0.37 起改為字元預算 + 段數上限雙門檻 greedy 打包（原 `CHUNK_SIZE = 20` 已廢），但打包策略本身不變。術語表是另一種請求類型，不走 `TRANSLATE_BATCH` 而是新的 `EXTRACT_GLOSSARY` 訊息（見 19.4）。
- **第 9 節（翻譯快取）**：術語表快取與譯文快取共用 `chrome.storage.local` 但 key prefix 分開（`tc_*` vs `gloss_*`）。版本變更時一起清。
- **第 16 節（訊息協定）**：19.1 不新增訊息類型，只改 `TRANSLATE_BATCH` 的內部實作讓它變成佇列任務。19.2 新增 `EXTRACT_GLOSSARY` 與 `GLOSSARY_READY` 兩個訊息。
- **第 13 節（Toast）**：進度條規格不變，只是更新邏輯從單調遞增變成「按段落 index 累計」。

### 19.4 待決定事項（實作前要確認）

- Gemini 對同一 API Key 的實際 rate limit 是多少？`MAX_REQUESTS_PER_SECOND = 5` 是推估值，需查 Gemini 官方文件或從 429 回應學習。
- 429 回應的 backoff 策略是否要尊重 `Retry-After` header？預設是。
- 術語表請求的 `temperature` 要另設更低值（例如 0.1）還是用使用者翻譯設定？傾向另設更低。
- 長文阻塞等術語表時，超過多久要放棄（例如 10 秒）直接 fallback？
