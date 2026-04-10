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
4. 讀 `test/PENDING_REGRESSION.md`：**若該檔案非空（除了 header 外有任何待辦條目）**，第一句話必須主動提醒 Jimmy「目前 pending regression queue 還有 N 條未清，要不要先處理？」這條提醒不可省略，也不可放在回應後段——因為 Jimmy 不是工程師，看不到檔案內容變化，需要 Claude 主動代他注意這個技術債
5. 視任務需要讀相關 source（`content.js`、`background.js`、`lib/*.js` 等）
6. 再動手

**絕對不要** 憑記憶或猜測就動手改，因為新對話的 Claude 沒有前一次對話的上下文。

---

## 硬規則（不可違反）

### 1. 版本號管理

- 每次修改 Extension 功能、UI、設定結構、檔案組織，**必須** bump `manifest.json` 的 `version`
- 格式是 **三段式**：`1.0.0` → `1.0.1` → `1.0.2` …（v1.0.0 起改用三段式，因為 Chrome 會把兩段式的 `1.01` 解析成 `1.1`，前導零被吃掉。歷史版本 v0.13–v0.99 使用兩段式）
- Popup 顯示的版本號必須用 `chrome.runtime.getManifest().version` 動態讀取，**絕對不可寫死**在 HTML
- **版本 bump 同步清單**（每次 bump 都必須全部更新，少一個測試就會 fail）：
  1. `shinkansen/manifest.json` 的 `version`
  2. `SPEC.md` 的「目前 Extension 版本」標頭
  3. `SPEC.md` §2.1「已實作（vX.Y.Z 為止）」標題
  4. `test/version-check.spec.js` 的 `EXPECTED_VERSION` 常數（此常數是 forcing function，刻意設計成 bump 後不改就 fail，用來提醒測試期望值要跟著更新；不要為了讓測試過而動態讀 manifest 繞過它。v0.59 起從原本的 `test/edo-detection.spec.js` 搬到獨立檔，因為 edo-detection 被 regression suite 取代後刪掉了）

### 1.5 版本快照備份（Backup & Restore）

此規則有兩種實作，**依工作環境擇一**：

**A. Cowork 環境（本檔 Claude 預設環境，無 git 的沙盒）**

- **動手改 `shinkansen/` 前必須先快照**：每次要修改 `shinkansen/` 內任何檔案之前，**必須先**把當前 `shinkansen/` 整個複製到 `.backups/shinkansen-v<當前 manifest 版本>/`，確認快照建立後才動手改 code 並 bump 版本號
- **指令**：`cp -a shinkansen .backups/shinkansen-v<版本號>`
- **範圍**：只備份 `shinkansen/` 資料夾（程式本體），不備份 `SPEC.md` / `CLAUDE.md` / `README.md`
- **保留策略**：固定保留最新 5 份快照。每次建立新快照後，若 `.backups/` 裡超過 5 份，必須刪除版本號最舊的那幾份，讓總數回到 5
- **冪等**：若對應版本的快照資料夾已存在（例如同一版本內第二次修改），**不要**覆蓋，略過即可（因為舊快照才是「被改之前的原始狀態」）
- **絕對不要在 Cowork 環境碰 git**：Cowork sandbox 的 `.git/` 對 Claude 是唯讀或受保護的，`git add` / `commit` / `tag` 會因 `index.lock` 權限問題失敗，**不要嘗試**。即使使用者說「更新 git」，在 Cowork 裡的正確回應是：「Cowork 端已修改完畢，git commit 與 tag 請切到 Claude Code 側執行」——不要幫忙抓指令貼給使用者，也不要幫忙下 `rm .git/index.lock` 試圖繞過。Cowork 單純只負責「編輯檔案 + 快照 `.backups/`」，git 是 Claude Code 的責任範圍。歷史：v0.41 一次 Claude 試圖在 Cowork 跑 `git add` 被 sandbox 擋，然後生了一串長指令貼給使用者請他自己到終端機執行，這是錯的——正確做法是什麼都不做，告訴使用者「換 Claude Code 開工」即可

**B. Claude Code 環境（本機有 git 的環境，自 v0.28 起使用）**

- **改 `shinkansen/` 前先確認 working tree 乾淨**：若有未 commit 的變更先 commit 或 stash，再動手
- **bump 版本號後必須立刻 `git tag v<新版本>`**：tag 取代 `.backups/` 的角色，作為可回復點
- **不需要手動複製資料夾**：git 本身就是版本快照。`git checkout v0.29 -- shinkansen/` 即可還原
- **`.backups/` 已列入 `.gitignore`**：不進版控，保留於 Cowork 端作為雙保險，兩邊不互相依賴
- **Cowork 改動優先 commit**：開新對話時若 `git status` 顯示有 Cowork 端產生的 unstaged 改動（`shinkansen/` / `SPEC.md` / `CLAUDE.md` 等），**必須先把這些改動 commit 並 `git tag v<對應版本>`**，再做任何 Claude Code 側的 commit（例如 test / lint / docs 修正）。理由：Cowork 改動是新版本的「主線」，Claude Code 側 commit 是依附在主線之上的側線。若順序顛倒，側線 commit 會落在缺主線改動的 tree 上，事後就要靠 rebase 或 cherry-pick 重排，徒增破壞性操作機會。若 Cowork 改動跨越多個版本（例如同時含 v0.31 與 v0.32 變動），依 §1 的版本 bump 同步清單判斷是否拆兩個 commit；總原則不變：**主線先、側線後**。v0.32 一次就是因為沒有這條而被迫做 reset + cherry-pick，記下來避免再犯

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

### 8. Bug 修法必須是「結構性通則」，不可以是「站點 / edge case 特判」

- **測試樣本少 ≠ 可以用特判矇過**：Jimmy 目前反覆測試的頁面不到 10 個（Gmail、Wikipedia、Twitter/X、Medium、Stratechery、幾封 email newsletter），每一個 bug 都代表一**類**真實世界網頁排版會遇到的問題，不是孤立事件。修法必須是「這一**類**結構特徵 → 這一**類**處理邏輯」，不是「這個網站 → 特判」。
- **判斷標準**：問自己「這條規則描述的是 DOM / CSS 的結構特徵，還是某個網站 / class / selector 的身份？」
  - ✅ 可以：`el` 自己 computed `font-size < 1px` → 這是 MJML / Mailjet / 任何 `font-size:0` inline-block-gap 技巧的結構特徵
  - ✅ 可以：sentinel 區分「`<br>` 語意換行」vs「source HTML 排版 `\n`」→ 描述的是空白的語意來源
  - ❌ 不可以：`el.matches('.ambox, .box-AI-generated')` → 綁定 Wikipedia 特定 class name
  - ❌ 不可以：`if (location.hostname === 'mail.google.com')` → 綁定站點身份
  - ❌ 不可以：內容品味判斷（「這段維護警告讀者該不該看」），這類交給 system prompt（見硬規則 6）
- **找不到通用規則時的正確反應**：**停下來追問根因**，不要先加一個可以矇過當下測試頁的特判。寧可花時間看 DOM、用 Chrome MCP 實地診斷，也不要為了「這個頁面先修好」留下特判技術債。特判會在下一個類似結構的網站上再炸一次，而且屆時很難追查。
- **舊路徑也要跟著更新**：遇到某個注入路徑的 bug 時，要主動檢查「其他類似路徑是不是也有同樣的 pattern 問題」。例如 v0.54 修 `replaceNodeInPlace` 時應該一併檢查 `plainTextFallback` 與 `replaceTextInPlace` 有沒有共用同一個「寫入目標解析」邏輯——三條路徑不該各自實作自己的 MJML 檢測。共用 helper 才能確保下次 MJML 排版變種不會在其中一條路徑先炸。
- **歷史教訓**：v0.51–v0.53 三輪都試圖修 Wikipedia ambox，前兩輪（serialize normalize、slot dedup + plainTextFallback）都是把新規則當 edge case 在疊，沒有回頭審視 `replaceNodeInPlace` 這個**通用 injection 路徑**的根本問題。v0.54 才是真正的通則（「fragment 由 slots 重建，正常情況整段覆蓋就對了」），但三條注入路徑當時沒統一，v0.55 才補上。往後遇到注入 / 段落偵測 / 序列化相關 bug，先問「是不是所有同類路徑都需要一起改」。

### 9. 修 shinkansen bug 必須同步寫 regression 測試（不可累積技術債）

- **背景**：v0.59 起 `test/regression/` 已有 10 條 spec 鎖死 v0.49–v0.58 期間踩過的 bug。但 Jimmy 反覆測試的網頁不到 10 個,他平常會把新發現的排版/翻譯問題丟進 Cowork 對話讓 Claude 修。問題是 bug 修了之後若沒有當場補 regression 測試,新 bug 就會在下一輪改動時悄悄回來,而 Jimmy(非工程師)不會自己去檢查 `test/regression/` 是否同步。
- **強制規則**：每次在 `shinkansen/` 內修 bug + bump 版本號的同一輪對話,**必須**選下面其中一條路徑:
  - **路徑 A(首選)**：在同一輪編輯把 regression spec + fixture HTML + canned response 一起寫進 `test/regression/`。Cowork 可以寫完整的 spec(只是文字檔編輯),sanity check 留一行 HTML 註解 `<!-- SANITY-PENDING: 描述要破壞哪個 fix 來驗證 -->`,等切到 Claude Code 端再實際跑驗證後拿掉。
  - **路徑 B(fallback)**：若當下抽不出最小重現結構(例如真實頁面太複雜、不確定 bug 的觸發條件),在 `test/PENDING_REGRESSION.md` 加一筆條目。**絕對不可以兩條都不做**。
- **判斷要走 A 還是 B**：
  - 已經有清楚的最小結構(知道哪個 tag 配什麼 attribute 會炸) → 走 A
  - 還在「這個頁面 LLM 翻得怪怪的,但不知道哪個結構是元兇」 → 走 B,先把現象記下來,等下次再追根因
  - 有疑慮就走 B,**不要為了走 A 而硬寫一條斷言模糊的 spec** —— 測試本身的品質比覆蓋率重要
- **路徑 A 的最小流程**(Cowork 端能做到的範圍)：
  1. 修 `shinkansen/` 程式碼
  2. 在 `test/regression/fixtures/` 建 `<bug-name>.html` 與 `<bug-name>.response.txt`
  3. 在 `test/regression/` 建 `inject-<bug-name>.spec.js` 或 `detect-<bug-name>.spec.js`,參照已有 spec 的格式
  4. spec 檔案頂部用 HTML 註解 `<!-- SANITY-PENDING: ... -->` 標記,告訴 Claude Code 端「跑 sanity check 時要破壞什麼」
  5. bump 版本號 + 更新 SPEC changelog,告知 Jimmy「你下次到 Claude Code 端時記得跑 npm test + 完成 sanity check」
- **路徑 B 的條目格式**：見 `test/PENDING_REGRESSION.md` 自己的範例。
- **Cowork 在宣告任務完成之前必須自我檢查**：「我有修 `shinkansen/` 嗎?有的話我有走 A 或 B 嗎?」沒有的話不能說任務完成。
- **為什麼要這條規則**：上一次 v0.49–v0.58 連 10 個 bug 沒有對應測試,事後補 regression suite 花了一整輪對話 + 大量 sanity check。若當時每次修 bug 都當場補測試,成本是 1+1 而不是 N+1,且不會留下任何「我這次改動會不會踩到舊 bug」的不確定性。

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

### 除錯時：自動化優先，不要什麼都要使用者截圖

**這是長期開發方向**：Claude 除錯時應盡可能自動化地讀取資訊、診斷問題，讓 Jimmy 只需要在最後一步（reload extension + 按快捷鍵）手動介入。

- 我有 `mcp__Claude_in_Chrome__*` 工具，可以 navigate 到測試頁、跑 JavaScript、讀 DOM、檢查選擇器
- 使用者曾明確說：「有沒有方法能讓你自行測試，自行重新載入，自行修改而不需要我截圖？」

#### Debug Bridge（v0.88 起可用）

`content.js` 內建了 main world ↔ isolated world 的 CustomEvent 橋接，Claude 可以在**任何載入了 content script 的頁面**上用 Chrome MCP `javascript_tool` 讀取 extension 的 Log buffer：

```js
// 讀取全部 log（或帶 afterSeq 做差異查詢）
new Promise(r => {
  window.addEventListener('shinkansen-debug-response', e => r(e.detail), { once: true });
  window.dispatchEvent(new CustomEvent('shinkansen-debug-request',
    { detail: { action: 'GET_LOGS', afterSeq: 0 } }));
  setTimeout(() => r('TIMEOUT'), 5000);
});
```

支援的 action：`GET_LOGS`（帶 `afterSeq` 參數）、`CLEAR_LOGS`。

#### 標準除錯流程

1. 用 Chrome MCP navigate 到出問題的網頁
2. **透過 Debug Bridge 拉 Log**：篩選 warn / error，讀取結構化 data 欄位
3. 根據 Log 資料判斷 bug 原因（不要靠猜）
4. 若 Log 資訊不足，再用 Chrome MCP 注入 JS 讀 DOM、檢查選擇器
5. 改完 code 後，請使用者 reload extension 驗收
6. 驗收後再透過 bridge 確認 log 是否乾淨

#### 自動除錯流程（v0.88 起可用，優先使用）

Debug Bridge 除了 `GET_LOGS` / `CLEAR_LOGS`，還支援操控翻譯流程的 action：
- `CLEAR_CACHE` — 清除翻譯快取（**除錯前必做，否則 cache hit 會遮蔽 API 行為**）
- `TRANSLATE` — 觸發 translatePage()，等同使用者按 Option+S
- `RESTORE` — 還原原文
- `GET_STATE` — 回傳 `{ translated, translating, segmentCount }`

完整自動除錯循環（Claude 自行完成，不需要使用者介入）：
1. Chrome MCP navigate 到目標頁面
2. Bridge `CLEAR_CACHE`（清快取）
3. Bridge `CLEAR_LOGS`（清 log，確保只看本次翻譯的 log）
4. Bridge `TRANSLATE`（觸發翻譯）
5. 輪詢 `GET_STATE` 等待 `translating === false`
6. Bridge `GET_LOGS` 拉 log，分析 warn / error
7. 若有 bug → 改 code → **請使用者 reload extension**（唯一需要人工介入的步驟）→ 回到步驟 1 驗證

**重要**：除錯時清快取是必要步驟，不清快取等於在看舊結果。

#### 遇到 Log 系統能力不足時

如果除錯過程中發現 Log 缺少關鍵欄位、缺少某類事件的記錄、或 bridge 無法到達某個情境（例如 extension 頁面本身、service worker crash），**必須主動提醒 Jimmy**：「Log 系統在這方面的記錄不足，要不要讓我加強？」——不要默默放棄自動化、回到請使用者截圖的舊路徑。

#### 限制

- 不能直接 reload extension（`chrome://extensions/` 是受保護頁面）
- 不能模擬 Chrome 層級的快捷鍵（Option+S）
- 所以最後一步一定要使用者手動 reload 並按快捷鍵
- Debug Bridge 只在有 content script 的頁面上可用（extension 內部頁面如 options.html 不行）

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

## 不要做的事

- ❌ 不要自行執行財務交易、下單、轉帳
- ❌ 不要寫死版本號到 Popup HTML
- ❌ 不要加回雙語對照模式
- ❌ 不要在沒同步更新 SPEC.md 的情況下結束任務
- ❌ 不要在沒 bump 版本號的情況下結束任務
- ❌ 不要用簡體字或中國大陸用語
- ❌ 不要在除錯前就急著改 prompt
- ❌ 不要過度使用 emoji（使用者沒要求就別加）
- ❌ 不要用 `git --no-verify`、強制推送等破壞性操作。破壞性操作包含但不限於：`git reset --hard`、`git push --force`（含 `--force-with-lease`）、`git checkout -- <path>` / `git restore --staged` 覆蓋未 commit 的變更、`git clean -f`、`git branch -D`、`git rebase --onto` 跨 tag 範圍等。**「結果可逆」不是動手的理由**——即使 commit 物件還留在 object db、即使能 cherry-pick 救回來、即使當下 working tree 會是對的，只要操作本身屬於上述範疇，**必須先跟使用者確認**再執行。歷史教訓：v0.32 收尾時 Claude Code 為了重排 commit 順序，先 `git reset --hard HEAD~1` 再 cherry-pick 救回，結果雖然正確但程序上跳過了確認，屬於前例不可重複的特例
