# Shinkansen — 規格文件（SPEC）

> 一款專注於網頁翻譯的 Chrome Extension，作為 Immersive Translation 的輕量相容品。

- 文件版本：v0.6
- 建立日期：2026-04-08
- 最後更新：2026-04-08
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：0.32

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

### 2.1 已實作（v0.32 為止）

1. **單語覆蓋顯示**：直接把原文段落的文字節點替換成譯文，保留元素本身的 font-family、font-size、color、layout，維持網頁原本排版。
2. **手動翻譯**：Popup「翻譯本頁」按鈕、Option+S 快捷鍵都可觸發。
3. **自動翻譯（白名單）**：網域若在白名單內則自動翻譯（M3 調優中）。
4. **Gemini API 整合**：使用 Google Gemini REST API，所有參數開放使用者微調（模型、service tier、temperature、topP、topK、maxOutputTokens、systemInstruction）。
5. **網域黑白名單**：設定頁可設定「永不翻譯」或「總是翻譯」清單。
6. **持久化翻譯快取**：以 SHA-1（原文） 為 key 存在 `chrome.storage.local`，跨頁面、跨會話都有效。相同段落第二次見到直接從快取讀取，不打 Gemini。
7. **快取管理**：Popup 顯示快取統計（段數 / 大小），提供「清除快取」按鈕。Extension 版本變更時自動清空快取。
8. **分批漸進式翻譯**：段落以 20 段為一批送出，每批翻譯完成立刻注入 DOM，使用者看到頁面逐段變成中文。
9. **翻譯狀態提示（Toast）**：畫面右下角顯示進度條 + 當前段數 + 耗時計時器。詳見第 13 節。
10. **LLM 除錯 Log 開關**：設定頁開關，開啟後記錄每次 API 請求與回應。
11. **快捷鍵**：預設 Option+S(macOS)/ Alt+S（其他 OS），可在 `chrome://extensions/shortcuts` 變更。
12. **設定同步**：`chrome.storage.sync` 透過 Google 帳號跨裝置同步。
13. **翻譯成本顯示**：設定頁可填入 Gemini 模型的 Input / Output tokens 單價（USD per 1M tokens）。翻譯完成時 Toast 顯示本次頁面的 token 數與費用；Popup 顯示跨頁面的累計使用量與費用，並提供「重置統計」按鈕。
14. **Extension Icon 紅點 Badge**：翻譯完成時在 extension icon 上點亮旭日紅（`#cf3a2c`）的 `●` 標記，讓使用者一眼就知道當前分頁已翻譯。還原原文或切換到未翻譯分頁時自動清除。badge 是 per-tab 狀態，每個分頁獨立。
15. **回復預設設定**：設定頁下方有「回復預設設定」按鈕。會把所有設定（模型、參數、計價、網域規則、系統提示等）還原為 `DEFAULT_SETTINGS`，**API Key 保留**，翻譯快取與累計使用統計不動（各自有專屬的清除／重置按鈕）。
16. **完整保留連結與行內樣式**：段落內的 `<a>`、`<strong>`、`<em>`、`<code>`、`<mark>`、帶 class/style 的 `<span>` 等行內元素，在翻譯後完整保留外殼（包括 `href`、`class`、`style` 等屬性），譯文文字會塞回原本的位置。實作上 content.js 會在送 LLM 前把這些行內元素抽掉換成 `⟦N⟧…⟦/N⟧` 佔位符（U+27E6 / U+27E7），LLM 翻譯純文字並原樣保留佔位符，回來後 content.js 再把佔位符替換回原本的「殼」。若 LLM 弄丟佔位符（驗證失敗），會 fallback 到純 textContent 替換以避免內容遺失。

### 2.2 規劃中（尚未實作）

- 四大測試網站（Gmail、Twitter/X、Wikipedia、Medium）的網站專屬偵測規則調優
- 設定匯出 JSON 到 iCloud 雲碟（備援同步方案）
- 內建 Log 檢視頁

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、多 Provider（Google 翻譯、DeepL、Yandex 等）、PDF/EPUB/影片字幕、延遲載入、多國語言介面、淺色/深色主題切換、雙語對照顯示模式。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-2.0-flash`，可改 `gemini-2.5-pro`、`gemini-3-flash-preview` 等）
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

**分批大小**：`CHUNK_SIZE = 20`（段）。超過此數的批次會在 `content.js` 端先切成多個子批次，每個子批次各自向 background 發送 `TRANSLATE_BATCH` 訊息。`lib/gemini.js` 內部也有 20 段的雙重保險。

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
4. 用 `el.textContent = ''; el.appendChild(frag)` 替換內容；連結與樣式完整保留。
5. **驗證（寬鬆模式，v0.24）**：deserialize 回傳 `{ frag, ok, matched }`。只要 `matched > 0`（至少一對佔位符成功配對）就視為 `ok = true`，使用 fragment 注入；LLM 漏放的佔位符會用 `stripStrayPlaceholderMarkers` 把殘留 `⟦N⟧` / `⟦/N⟧` 標記從文字節點裡清掉。只有 `matched === 0`（完全沒配對）才退回純 `textContent` fallback。先前 v0.23 採嚴格全配對模式，碰到段落內含 14 個 slot 的 Wikipedia lede 時容易整段崩成純文字、所有連結消失。
7. **CJK 空白清理**(v0.20)：LLM 翻譯時會把英文「連結+空格+下一個字」的空格原樣保留，但中文字之間不需要。deserialize 前會先跑 `collapseCjkSpacesAroundPlaceholders`，只收掉「CJK 字元 ↔ 佔位符 ↔ CJK 字元」之間的空白，其他地方（例如數字與中文之間的 "1600 年"）不動。
8. **技術元素過濾**(v0.22)：`serializeWithPlaceholders` 與 `hasPreservableInline` 都會跳過 `HARD_EXCLUDE_TAGS`（`STYLE` / `SCRIPT` / `NOSCRIPT` 等），避免 Wikipedia infobox TH 裡內嵌的 `<style>.mw-parser-output …</style>` 把 CSS 原始碼當成純文字送進 LLM。
9. **降低佔位符密度**(v0.24)：為了避免 LLM 在遇到大量 slot 時直接放棄（觀察到 Wikipedia「Edo」首段一句話有 14 個 slot），`isPreservableInline` 會額外過濾掉沒有實質內容的 inline 元素——透過 `hasSubstantiveContent`（要求文字含拉丁字母、CJK 或數字）排除像 `<span class="gloss-quot">'</span>` 這種純標點殼。
10. **腳註參照原子保留**(v0.25)：`isAtomicPreserve` 會把 `<sup class="reference">…</sup>`（Wikipedia 腳註參照如 `[2]`）視為「原子單位」——`serializeWithPlaceholders` 會把整個元素 deep clone 存進 slot，並用單一自閉合佔位符 `⟦*N⟧` 取代。LLM 完全看不到 `[2]` 三個字元，不會把它翻譯也不會改成全形。`deserializeWithPlaceholders` 配對到 `⟦*N⟧` 時直接把原始的 `<sup><a>[2]</a></sup>` deep clone 塞回去，連結與樣式一起保留。先前 v0.24 採「攤平成純文字」策略雖然少了 slot，但代價是連結消失且 LLM 會把 `[2]` 改成全形 `［2］`。
11. **佔位符半形強制（system prompt 路線，v0.27）**：含密集連結的段落容易讓 LLM 在繁中模式下把 `⟦0⟧` 自動寫成 `⟦０⟧`（全形數字）或 `⟦/0⟧` 寫成 `⟦／0⟧`（全形斜線），造成正則配對失敗、整段崩成純文字。修法是在 `gemini.js` system instruction 裡明確警告 LLM「佔位符裡的數字、斜線、星號必須是半形 ASCII」，而**不在 content.js 做事後 normalize**。`normalizeLlmPlaceholders` 只負責「把佔位符 `⟦…⟧` 內部多餘空白收掉」這種範圍嚴格鎖在標記內、不會誤傷正文的清理；全形⇄半形這種「中文格式偏好」交給 prompt 處理，避免 parse 路徑與 prompt 規則互相衝突或誤傷譯文中合法的全形內容。
12. **連結優先於樣式**(v0.28，v0.32 起廢止)：v0.28–v0.31 期間，非 `<a>` 的保留行內元素若內部含 `<a>` 會讓位給內部 `<a>`（放棄外殼只保留連結），以解決 v0.23 shallow-clone 外殼把內部連結攤平成純文字的問題。v0.32 改走遞迴序列化 + 遞迴反序列化後這個權衡已不需要——外層 `<b>` 與內層 `<a>` 都能同時保留，因此此規則已從 `isPreservableInline` 移除。觸發情境：Wikipedia 維護模板 `<b>may incorporate text from a <a>large language model</a>, which is ...</b>`，v0.31 失去 bold、v0.32 兩者皆保留。

**路徑 B — 純文字元素（不含媒體、不含可保留行內元素）**：
```js
el.textContent = translation;
```
最簡單、最快、保留元素的所有屬性與樣式。

**路徑 C — 含媒體元素**：
1. 用 `TreeWalker(SHOW_TEXT)` 收集元素內所有非空文字節點
2. 選出最長的那個作為「主承載節點」，把整段譯文塞進去
3. 其他文字節點清空（`nodeValue = ''`）
4. 所有 element 子節點（img、a、span…）原封不動保留

這確保 Wikipedia infobox 裡「圖片 + 說明」的 TD 翻譯後圖片仍在。含媒體段落不走路徑 A，避免複雜度爆炸。

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

### 5.2 葉子優先規則（Leaf Block）

若一個 block 元素內含其他 block tag 子孫（例如 TD 裡有 FIGCAPTION），walker 會 SKIP 父元素，下降處理子元素。避免父層被當成翻譯單位、用 textContent 把子層（含圖片）清光。

實作：`containsBlockDescendant(el)` 走 `el.getElementsByTagName('*')` 檢查是否有任何後代 tag 在 `BLOCK_TAGS_SET`。

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

- **Wikipedia**：通用規則 + INCLUDE_BY_SELECTOR 已支援基本需求。Infobox 的含圖 TD 透過媒體保留策略處理。References 區翻譯品質尚在調優。
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
3. `content.js` 把 elements 的 `innerText` 組成 texts 陣列，**分批** 20 段一組。
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
| success（有成本） | `翻譯完成 （N 段）` | `X,XXX tokens · $0.0028` | 綠色，100% | **否**（使用者必須點 × 關閉） |
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

**成本計算**：token 數來自 Gemini API 回應的 `usageMetadata.promptTokenCount` 與 `candidatesTokenCount`。成本 = `(inputTokens / 1M) × inputPerMTok + (outputTokens / 1M) × outputPerMTok`，幣別 USD。**快取命中的段落不計算 token 與成本**（因為根本沒打 API）。

### 13.4 設計原則

- **不使用轉圈 spinner**：改用橫向進度條 + 流動動畫，視覺上更明確
- **不使用左邊色條 border-left**：整個 toast 用單色陰影浮在畫面上
- **計時器持續跳動**：即使 Gemini 處理時間長，使用者看計時器在跳就知道 extension 還活著
- **成功提示不自動消失**：避免使用者沒注意到就錯過

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

- **Wikipedia References 區翻譯品質**：書目引用（例如 `^ Jump up to: a b Sansom, George. A History of Japan...`）經常只翻譯前綴「Jump up to」，書名與作者名保持英文。原因與 prompt 或送出文字格式有關，待進一步調查（非 prompt 方向）。
- **Wikipedia 維護模板翻譯品質**：v0.31 起 ambox 家族（`.ambox / .box-AI-generated / .box-More_footnotes_needed`）不再被 selector 排除，會送去翻譯。若未來觀察到某些維護模板被 LLM 翻得特別差、或特別浪費 token，應改走 `systemInstruction` 指示 LLM「這類警告框如何處理」，而非回頭新增 selector 排除。
- **分批 chunk 邊界**：目前 CHUNK_SIZE=20，需要觀察不同大小對翻譯品質與速度的影響。
- **快取 key 粒度**：目前 key 只含原文；若未來要支援多目標語言，需加入 targetLanguage 到 key。

---

## 18. 開放議題（未來再決定）

- Gemini 免費額度是否足夠日常使用？若不夠，加入速率與用量統計。
- 是否支援自動語言偵測後「只翻譯非中文內容」。
- 是否加入簡易的「翻譯歷史紀錄」查詢頁。
- 多 Provider 支援（OpenAI / Claude / DeepSeek / Ollama）的優先順序。
- 是否需要「部分重新翻譯」功能（清除特定段落的快取再翻）。
