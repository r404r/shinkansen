# CLAUDE.md — Shinkansen 專案協作指引

> 這份文件給 Claude 讀。每次在這個 Project 內開始新對話時，請先讀本檔與 `SPEC.md`，再動手。

---

## 使用者資料

- **名字**：Jimmy
- **語言/文化**：台灣使用者，**一律使用繁體中文 + 台灣用語**，絕不使用簡體字或中國大陸用語（例如：軟體不是「軟件」、資料庫不是「數據庫」、影片不是「視頻」、程式不是「程序」、介面不是「界面」、滑鼠不是「鼠標」、網路不是「網絡」）
- **技術背景**：沒有開發經驗，但理解概念、會看截圖、會操作 Chrome 擴充功能
- **環境**：macOS 26、Chrome 最新版、VS Code
- **心態**：把 Claude 當協作者，會提供清楚的 bug 回報與方向指引

---

## 專案概觀

- **專案名稱**：Shinkansen
- **類型**：Chrome Extension(Manifest V3)
- **目標**：Immersive Translation 的輕量相容品，專注於網頁翻譯（繁中）
- **翻譯引擎**：Google Gemini REST API（使用者自備 API Key）
- **測試目標網站**：Gmail、Twitter/X、Wikipedia、Medium
- **完整規格**：見 `SPEC.md`（**開始任何工作前必讀**）

---

## 開始新對話時的標準動作

1. 讀本檔（`CLAUDE.md`）了解協作規則
2. 讀 `SPEC.md` 了解專案全貌、已完成功能、待辦事項
3. 讀 `shinkansen/manifest.json` 確認目前版本號
4. 視任務需要讀相關 source（`content.js`、`background.js`、`lib/*.js` 等）
5. 再動手

**絕對不要** 憑記憶或猜測就動手改，因為新對話的 Claude 沒有前一次對話的上下文。

---

## 硬規則（不可違反）

### 1. 版本號管理

- 每次修改 Extension 功能、UI、設定結構、檔案組織，**必須** 把 `manifest.json` 的 `version` +0.01
- 格式是 **兩段式**：`0.13` → `0.14` → `0.15` …（不是 `0.1.13`）
- Popup 顯示的版本號必須用 `chrome.runtime.getManifest().version` 動態讀取，**絕對不可寫死**在 HTML
- **版本 bump 同步清單**（每次 bump 都必須全部更新，少一個測試就會 fail）：
  1. `shinkansen/manifest.json` 的 `version`
  2. `SPEC.md` 的「目前 Extension 版本」標頭
  3. `SPEC.md` §2.1「已實作（v0.XX 為止）」標題
  4. `test/edo-detection.spec.js` 的 `EXPECTED_VERSION` 常數（此常數是 forcing function，刻意設計成 bump 後不改就 fail，用來提醒測試期望值要跟著更新；不要為了讓測試過而動態讀 manifest 繞過它）

### 1.5 版本快照備份（Backup & Restore）

此規則有兩種實作，**依工作環境擇一**：

**A. Cowork 環境（本檔 Claude 預設環境，無 git 的沙盒）**

- **動手改 `shinkansen/` 前必須先快照**：每次要修改 `shinkansen/` 內任何檔案之前，**必須先**把當前 `shinkansen/` 整個複製到 `.backups/shinkansen-v<當前 manifest 版本>/`，確認快照建立後才動手改 code 並 bump 版本號
- **指令**：`cp -a shinkansen .backups/shinkansen-v<版本號>`
- **範圍**：只備份 `shinkansen/` 資料夾（程式本體），不備份 `SPEC.md` / `CLAUDE.md` / `README.md`
- **保留策略**：固定保留最新 5 份快照。每次建立新快照後，若 `.backups/` 裡超過 5 份，必須刪除版本號最舊的那幾份，讓總數回到 5
- **冪等**：若對應版本的快照資料夾已存在（例如同一版本內第二次修改），**不要**覆蓋，略過即可（因為舊快照才是「被改之前的原始狀態」）

**B. Claude Code 環境（本機有 git 的環境，自 v0.28 起使用）**

- **改 `shinkansen/` 前先確認 working tree 乾淨**：若有未 commit 的變更先 commit 或 stash，再動手
- **bump 版本號後必須立刻 `git tag v<新版本>`**：tag 取代 `.backups/` 的角色，作為可回復點
- **不需要手動複製資料夾**：git 本身就是版本快照。`git checkout v0.29 -- shinkansen/` 即可還原
- **`.backups/` 已列入 `.gitignore`**：不進版控，保留於 Cowork 端作為雙保險，兩邊不互相依賴

**共用的回復流程**（兩種環境邏輯相同）

當使用者說「回復到 0.XX」，執行：
  1. 確認 `.backups/shinkansen-v0.XX/`（Cowork）或 `git tag v0.XX`（Claude Code）存在
  2. 把當前 `shinkansen/` 先保留一份（Cowork: 快照；Claude Code: commit 或 stash），避免回復動作本身遺失現狀
  3. 用對應方法還原：Cowork 刪除當前 `shinkansen/` 再複製 `.backups/shinkansen-v0.XX/` 回來；Claude Code 跑 `git checkout v0.XX -- shinkansen/`
  4. 確認 `manifest.json` 的 version 已經是 0.XX
  5. 告訴使用者要 reload extension

**起點**：v0.28 的 Cowork 快照與 git tag `v0.28` 均已於機制建立時補存。

### 2. SPEC.md 同步

- 每次修改 Extension 行為、UI、設定、檔案組織，**必須** 同步更新 `SPEC.md`
- SPEC.md 有自己的文件版本號（目前 v0.2），結構性變動時 +0.1
- 程式碼改完還沒同步 Spec = 工作沒做完

### 3. 顯示模式

- **只有單語覆蓋模式**。原地替換文字節點，保留元素的 font/size/color/layout
- **不做雙語對照**（使用者明確拒絕過）
- 含媒體元素（img/video/svg…）必須走「保留媒體 + 替換最長文字節點」策略，不可用 `el.textContent = x` 把圖片清掉

### 4. Gemini Service Tier 格式

- 用 **短形式**：`FLEX` / `STANDARD` / `PRIORITY` / `DEFAULT`
- **不要** 用 `SERVICE_TIER_FLEX` 長形式（API 會拒絕）
- `DEFAULT` 代表完全不送此欄位

### 5. 翻譯快取

- 存在 `chrome.storage.local`，key 格式 `tc_<sha1>`
- Extension 版本變更時 service worker 會自動清空快取
- 修改 prompt、模型、段落偵測邏輯後，搭配版本 +0.01 可自動讓使用者的舊快取失效

### 6. 翻譯範圍由 system prompt 決定，不由 selector 決定

- **`content.js` 只負責「技術性必須跳過」的排除**：`<script>` / `<style>` / `<code>` / `<pre>` / `<noscript>` / 表單控制項（`input` / `button` / `select` / `textarea`），以及 HTML5 語意容器 `<nav>` / `<footer>` 和 ARIA role `banner` / `navigation` / `search` / `contentinfo`。這些是「結構上本來就不該翻」的東西。
- **「這段讀者該不該看」之類的內容品味判斷一律交給 Gemini `systemInstruction`**，不要在 `content.js` / `lib/` 加 class 或 selector 層級的內容排除（例如不要再加 `.ambox`、`.box-*`、`.editnotice` 之類的黑名單）。
- **原因**：selector 與 prompt 兩條路徑若同時定義「該不該翻」，容易互相衝突，且 selector 一刀切會造成誤傷（例如 Wikipedia 的維護警告框其實是讀者需要看到的內容）。統一由 prompt 控制才能依語意判斷。
- **歷史**：v0.29–v0.30 曾用 `EXCLUDE_BY_SELECTOR = '.ambox, .box-AI-generated, .box-More_footnotes_needed'` 排除 Wikipedia 維護模板，v0.31 起移除，改由 system prompt 決定。
- **例外**：若未來觀察到某類內容 LLM 翻得特別差 / 特別浪費 token，**不要**回頭加 selector 黑名單，而是改去 `systemInstruction` 指示 LLM 怎麼處理。

### 7. 中文排版偏好一律交給 system prompt 處理

- **全半形、中文標點、斷行、字距等「中文排版偏好」不要在 `content.js` / `lib/` 裡做事後 normalize**，一律透過修改 Gemini 的 `systemInstruction` 來達成。
- **原因**：parse 路徑與 prompt 規則若同時定義同一件事容易互相衝突；全文 replace 也容易誤傷譯文中合法的全形內容（例如譯文裡的「２０２５」若被強制打回「2025」就壞掉了）。
- **唯一例外**：範圍嚴格鎖在佔位符 `⟦…⟧` 標記內部（用 regex 明確包住 `⟦` 與 `⟧`）的清理可以接受——因為佔位符是協定層的元資料，不是譯文。

---

## 規則變更流程（重要）

使用者 Jimmy 不是專業開發者，不會每次都去看 diff，所以 SPEC.md / CLAUDE.md 的變更必須謹慎，不可自動寫入。

**判斷規則**：當使用者在對話中講出聽起來像「長期規則」或「方向轉變」的內容時（例如帶有「以後都」、「不要再」、「一律」、「預設」、「從現在開始」這類語氣），Claude 必須：

1. **先用一句話確認是長期規則還是一次性需求**，例如：
   > 「這個我理解成長期規則——以後翻譯都跳過 `<code>` 區塊。我把它寫進 CLAUDE.md 硬規則，OK 嗎？」
2. **得到使用者明確同意後**，才寫進 SPEC.md 或 CLAUDE.md
3. **判斷該寫進哪一份文件**：
   - SPEC.md：功能行為、檔案結構、訊息協定、設定欄位、UI 規格（Extension 本身的事實）
   - CLAUDE.md：協作風格、版本號規則、除錯流程、不要做的事（Claude 該怎麼跟使用者工作）
   - 兩份都要改：例如新增顯示模式，SPEC 要寫規格、CLAUDE.md 硬規則也要更新

**不需要先問就可以直接改的情況**（這些本來就是硬規則或明確指令）：

- 使用者已經明講「請更新 SPEC.md / CLAUDE.md」
- 剛改完程式碼、行為已經跟 SPEC.md 不一致（硬規則第 2 條要求同步）
- 版本號 bump（硬規則第 1 條要求每次改 Extension 必 bump）

**為什麼要這樣做**：使用者不是每天看 diff 的人，自動寫入會讓錯誤規則悄悄污染後續所有對話，半年後很難追查。先問一句的成本很低，但能確保每條寫進文件的規則都被使用者親自點頭過。

---

## 工作風格偏好

### 除錯時：先用 Chrome MCP 自行驗證，不要什麼都要使用者截圖

- 我有 `mcp__Claude_in_Chrome__*` 工具，可以 navigate 到測試頁、跑 JavaScript、讀 DOM、檢查選擇器
- 使用者曾明確說：「有沒有方法能讓你自行測試，自行重新載入，自行修改而不需要我截圖？」
- **標準除錯流程**：
  1. 用 Chrome MCP navigate 到實際網頁
  2. 注入跟 content.js 相同的偵測邏輯跑一次
  3. 收集真實 DOM 結構與選擇器命中狀況
  4. 根據真實資料判斷 bug 原因（不要靠猜）
  5. 改完 code 後再跑一次模擬驗證
  6. 最後才請使用者 reload extension 驗收
- **限制**：
  - 不能直接 reload extension（`chrome://extensions/` 是受保護頁面）
  - 不能模擬 Chrome 層級的快捷鍵（Option+S）
  - 所以最後一步一定要使用者手動 reload 並按快捷鍵

### 修正 bug 的方向優先序

當翻譯結果品質不佳時，使用者明確表示 **先不要往 prompt 方向修**。應該先查：
1. 送給 Gemini 的原文內容是否有噪音（例如 Wikipedia 的 `^ Jump up to: a b` 前綴）
2. 段落偵測是否抓到錯誤單位
3. 分批邊界、對齊是否正確
4. background ↔ content 訊息傳遞是否正確
5. 快取是否殘留舊結果

最後才考慮 prompt 與模型參數。

### 程式碼風格

- Content script **不能** 用 ES module import，所有邏輯要自包含在 `content.js`
- Background script / popup / options 可以用 ES module
- 註解用繁體中文
- 不要亂加功能或過度工程；MVP 優先
- 不要動沒要求的檔案

### 檔案組織

- 目前 `lib/detector.js` 與 `lib/injector.js` 是預留空殼，實際邏輯都整併在 `content.js` 裡
- 未來若 content script 變太大再考慮拆分策略（例如用 dynamic `<script>` 注入）

---

## Toast 設計原則

- **不用** 轉圈 spinner（使用者看不出是動畫還是靜態圖）
- **不用** 左邊彩色邊條 border-left（被誤認為奇怪的色塊）
- **要用** 橫向進度條 + 數字計時器（使用者能明確看出 extension 還在跑）
- **成功提示不自動消失**（使用者可能沒注意到就錯過），需點 × 關閉
- **還原原文提示** 可以 2 秒自動消失（次要操作）

---

## 分批翻譯與漸進注入

- `CHUNK_SIZE = 20`（content.js 與 lib/gemini.js 雙重保險）
- 每批翻譯完成立刻注入 DOM，讓使用者看到頁面逐段變成中文
- 這是「extension 沒當掉」的最重要證據：進度條在動 + 計時器在跳 + 頁面在變

---

## 回覆風格

- 簡潔直接，不要過度鋪陳
- 使用者有開發概念但不是工程師，技術術語可用但要解釋清楚
- 遇到不確定的狀況寧可問一句，不要瞎猜亂改
- 修完 bug 後要告訴使用者具體操作步驟（例如「到 chrome://extensions/ 按 reload」）
- 不要在每次回應後加長篇總結（使用者可以自己看 diff）

---

## 已知議題

- **Wikipedia References 區翻譯品質**：書目引用經常只翻前綴「Jump up to」而保留書名與作者名。根因不確定，但使用者明確表示非 prompt 方向。待後續對話深入追查。

---

## 不要做的事

- ❌ 不要自行執行財務交易、下單、轉帳
- ❌ 不要寫死版本號到 Popup HTML
- ❌ 不要加回雙語對照模式
- ❌ 不要在沒同步更新 SPEC.md 的情況下結束任務
- ❌ 不要在沒 bump 版本號的情況下結束任務
- ❌ 不要用簡體字或中國大陸用語
- ❌ 不要在除錯前就急著改 prompt
- ❌ 不要過度使用 emoji（使用者沒要求就別加）
- ❌ 不要用 `git --no-verify`、強制推送等破壞性操作
