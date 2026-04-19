# Shinkansen — 規格文件（SPEC）

> 一款專注於網頁翻譯的 Chrome Extension，作為 Immersive Translation 的輕量相容品。

- 文件版本：v1.0
- 建立日期：2026-04-08
- 最後更新：2026-04-19（v1.4.14）
- 目標平台：Chrome（Manifest V3）
- 作業系統：macOS 26
- 目前 Extension 版本：1.4.14

---

## 0. 文件維護政策

**每次修改 Extension 的行為、UI、設定結構、或檔案組織，都必須同步更新本文件。**

- Extension 版本號規則：三段式格式（`1.0.0` → `1.0.1`）。v1.0.0 以前的歷史版本使用兩段式。
- Extension 版本號統一由 `manifest.json` 的 `version` 欄位控管；Popup 顯示版本透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。
- 本 SPEC 文件的版本號與 Extension 版本號獨立管理；SPEC 有結構性變動時 +0.1。

---

## 1. 專案目標

Shinkansen 是一款 Chrome 擴充功能，將英文（或其他外語）網頁翻譯成台灣繁體中文，協助使用者流暢閱讀外語內容。名稱「新幹線」象徵快速、平穩、流暢的閱讀體驗。

授權：Elastic License 2.0 (ELv2)。允許查看、學習、修改與個人使用；禁止將本軟體（含改寫版本）作為託管或受管理的服務提供給第三方。完整條款見專案根目錄 `LICENSE`。

---

## 2. 功能範圍

### 2.1 已實作（v1.4.14 為止）

詳細版本歷史見 [`CHANGELOG.md`](CHANGELOG.md)。

| 功能區塊 | 狀態 | 簡述 |
|---------|------|------|
| 網頁翻譯 | ✅ | Option+S（Gemini）/ Option+G（Google Translate）切換；單語覆蓋顯示；漸進分批注入；還原原文 |
| YouTube 字幕翻譯 | ✅ | XHR 預翻 + on-the-fly 備援；時間視窗批次；seek/rate 補償；字幕框展開置中；SPA 導航自動重啟 |
| SPA 支援 | ✅ | History API 攔截 + URL 輪詢；MutationObserver rescan；Content Guard；stickyTranslate 續翻 |
| 段落偵測 | ✅ | walker + mixed-content fragment；PRE 條件排除；leaf DIV / grid cell 補抓；nav 放行 |
| 佔位符序列化 | ✅ | 配對型 ⟦N⟧…⟦/N⟧ + 原子型 ⟦*N⟧；媒體保留；含圖連結重建 |
| 並行翻譯 + Rate Limiter | ✅ | 三維滑動視窗（RPM/TPM/RPD）；Priority Queue；429 退避；concurrency pool |
| 自動術語擷取 | ✅ | Gemini 預翻前擷取專有名詞；長度三級策略；術語快取（`gloss_` prefix） |
| 固定術語表 | ✅ | 全域 + 網域兩層；設定頁編輯；優先覆蓋 LLM 自動術語 |
| 翻譯快取 | ✅ | `chrome.storage.local`；SHA-1 key；版本變更自動清空 |
| 設定頁 | ✅ | 5 Tab：一般設定 / Gemini / 術語表 / 用量紀錄 / Debug；匯入匯出 |
| Popup 面板 | ✅ | 翻譯/還原；快取/費用統計；自動翻譯開關；YouTube 字幕 toggle |
| Toast 提示 | ✅ | 進度條 + 計時器；可調透明度與位置；`toastAutoHide` 自動關閉選項 |
| 用量紀錄 | ✅ | IndexedDB + 折線圖 + CSV 匯出；日期/模型/網域/文字搜尋篩選 |
| Debug 工具 | ✅ | Debug Bridge（CustomEvent）；Log buffer 1000 筆；YouTube `GET_YT_DEBUG` action |
| Google Docs 支援 | ✅ | 偵測編輯頁自動導向 `/mobilebasic` 閱讀版再翻譯 |
| 自動語言偵測 | ✅ | 跳過繁中頁面（可設定關閉）；比例制偵測；日韓文排除 |
| 自動翻譯網站 | ✅ | 網域白名單（支援萬用字元）；`autoTranslate` 總開關 |

### 2.2 規劃中（尚未實作）

| 功能區塊 | 優先度 | 簡述 |
|---------|--------|------|
| EPUB 翻譯 | 中 | 擴充頁面（epub.html）；JSZip 解壓縮 + OPF 解析；重用現有 Gemini 批次翻譯流程；拖曳 EPUB 檔案進頁面後逐章翻譯並顯示 |

### 2.3 明確不做

滑鼠懸停顯示、原文樣式客製、輸入框翻譯、劃詞翻譯、DeepL / Yandex 等第三方付費翻譯服務、PDF/影片字幕、延遲載入、多國語言介面、淺色/深色主題切換、雙語對照顯示模式。

> 備注：v1.4.0 起已加入 Google Translate 非官方免費端點（Opt+G，不需 API Key），同時保留 Gemini（Opt+S）。Google 官方 Cloud Translation v2 API（付費）不在支援範圍內。

---

## 3. 翻譯服務：Google Gemini

### 3.1 API 端點

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={API_KEY}
```

### 3.2 開放使用者微調的參數

- `model`：模型名稱（預設 `gemini-3-flash-preview`，可改為其他 Gemini 模型或自行輸入模型 ID）
- `serviceTier`：推論層級（DEFAULT / FLEX / STANDARD / PRIORITY），設定頁存大寫短形式，API 送出時轉小寫（`flex`/`standard`/`priority`），DEFAULT 時不送此欄位
- `temperature`：創造性，範圍 0–2，預設 1.0（Gemini 3 Flash 原廠預設值）
- `topP`：核採樣，預設 0.95
- `topK`：預設 40（Gemini 3 Flash 原廠預設值，Pro 系列為 64）
- `maxOutputTokens`：最大輸出長度，預設 8192
- `systemInstruction`：系統提示詞（見 3.3）
- `safetySettings`：安全過濾等級（預設 BLOCK_NONE 四大類別全開）

> **Thinking 功能**：`gemini.js` 固定送 `thinkingConfig: { thinkingBudget: 0 }`（永遠關閉），不開放使用者設定。原因是思考 token 會吃掉 `maxOutputTokens` 額度，導致譯文被截斷。

### 3.3 預設 System Prompt

完整預設 prompt 定義在 `lib/storage.js` 的 `DEFAULT_SYSTEM_PROMPT`（v0.83 升級）。採 XML tag 結構，分四大區塊：

- **`<role_definition>`**：定位為「精通英美流行文化與台灣在地文學的首席翻譯專家」，追求出版級台灣當代語感
- **`<critical_rules>`**：禁止輸出思考過程、忠實保留不雅詞彙（不做道德審查）、專有名詞保留英文原文（地理位置例外，須翻為台灣標準譯名）
- **`<linguistic_guidelines>`**：台灣道地語感（拒絕翻譯腔）、禁用中國大陸用語（附具體對照表）、台灣通行譯名、特殊詞彙首次出現加註原文
- **`<formatting_and_typography>`**：全形標點、破折號改寫、中英夾雜半形空格、數字格式（1–99 中文數字、100 以上阿拉伯數字）、年份格式

`lib/gemini.js` 的 `buildEffectiveSystemInstruction()` 會依批次內容動態追加規則。追加順序為：基礎指令 → 多段分隔符（含 `«N»` 序號標記規則） → 段內換行 → 佔位符 → 術語對照表。

### 3.4 分段請求協定

多段文字以 `\n<<<SHINKANSEN_SEP>>>\n` 串接後一次送出，回應以相同分隔符拆分對齊。

**分批策略**：字元預算 + 段數上限雙門檻 greedy 打包。`maxCharsPerBatch`（預設 3500，設定頁可調）與 `maxUnitsPerBatch`（預設 12，設定頁可調）任一觸發即封口。超大段落獨佔一批，不切段落本身。

**對齊失敗 fallback**：回傳段數不符時退回逐段單獨呼叫模式。

**實作位置**：`content.js` 的 `packBatches()` 為主要打包層，`lib/gemini.js` 的 `packChunks()` 為雙重保險層。

### 3.5 Rate Limiter

三維滑動視窗（RPM / TPM / RPD），實作於 `lib/rate-limiter.js`。

- **RPM**：60 秒滑動視窗，時間戳環形緩衝區
- **TPM**：60 秒滑動視窗，token 估算 `Math.ceil(text.length / 3.5)`
- **RPD**：太平洋時間午夜重置，持久化至 `chrome.storage.local`（key `rateLimit_rpd_<YYYYMMDD>`）
- **安全邊際**：每個上限乘以 `(1 - safetyMargin)`，預設 10%
- **429 處理**：尊重 `Retry-After` header，否則指數退避 `2^n * 500ms`（上限 8 秒）。RPD 爆則不重試

Tier 對照表在 `lib/tier-limits.js`，涵蓋 Free / Tier 1 / Tier 2 各模型的 RPM / TPM / RPD。設定頁可選 Tier 或自訂覆寫。

### 3.6 術語表一致化

翻譯長文前先呼叫 Gemini 擷取全文專有名詞對照表，注入所有翻譯批次的 systemInstruction。

**策略依文章長度分三級**（由 `glossary.skipThreshold` 和 `glossary.blockingThreshold` 控制）：

- ≤ `skipThreshold`（預設 1）批 → 完全跳過，不建術語表
- `skipThreshold` < 批數 ≤ `blockingThreshold`（預設 5）→ fire-and-forget（首批不等術語表）
- \> `blockingThreshold` → 阻塞等待術語表回來再開始翻譯

**擷取 prompt**：定義在 `lib/storage.js` 的 `DEFAULT_GLOSSARY_PROMPT`，XML 結構，限定四類實體（人名/地名/專業術語/作品名），附排除規則與 JSON 格式範例。上限 `glossary.maxTerms`（預設 200）條。

**其他細節**：

- 輸入壓縮：只送 heading、每段第一句、caption、頁面標題（約原文 20–30%）
- 術語表快取於 `chrome.storage.local`（key `gloss_<sha1>`），版本變更時清空
- 術語表請求走 rate limiter priority 0 插隊
- 逾時 `glossary.timeoutMs`（預設 60000ms），`gemini.js` 內部 fetch 層另有 `fetchTimeoutMs`（預設 55000ms）
- 失敗或逾時 → fallback 成不帶術語表的一般翻譯
- 術語表 temperature 獨立設定（預設 0.1，要穩定不要有創意）
- 預設停用（`glossary.enabled` 預設 `false`），使用者可在設定頁或 Popup 開啟

---

## 4. 翻譯顯示規格

### 4.1 顯示模式

**單語覆蓋（僅此一種）**：將原文段落的文字節點替換成譯文，元素本身保留不動。**不提供雙語對照模式**。

### 4.2 替換策略

依元素內含的內容走兩條路徑，共用 `resolveWriteTarget()` + `injectIntoTarget()` 兩個 helper：

**`resolveWriteTarget(el)`**：回答「要把譯文寫到哪個元素」。預設回傳 `el` 自己；若 `el` 的 computed `font-size < 1px`（MJML email 模板常見），改回傳第一個 font-size 正常且非 slot 系元素的後代。descent 時整個 slot subtree 以 `FILTER_REJECT` 跳過（含子孫）。

**`injectIntoTarget(target, content)`**：回答「怎麼寫進 target」。預設走 clean slate（清空 children 後 append）；若 target 含媒體元素（img/svg/video/picture/audio/canvas），改走「就地替換最長文字節點」保留媒體。

**路徑 A — 含可保留行內元素**：

1. `serializeWithPlaceholders(el)`：遞迴把行內元素換成 `⟦N⟧…⟦/N⟧` 佔位符（支援巢狀），slot 存 shallow clone
2. LLM 翻譯純文字，佔位符原樣保留
3. `selectBestSlotOccurrences(text)`：處理 LLM 重複引用同一 slot 的情況（挑首次非空出現為 winner，其餘降級為純文字）
4. `deserializeWithPlaceholders(translation, slots)`：遞迴 `parseSegment()` 重建 DocumentFragment
5. `replaceNodeInPlace(el, frag)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入

驗證採寬鬆模式：至少一對佔位符配對即視為成功，殘留標記由 `stripStrayPlaceholderMarkers` 清除。

**路徑 B — 無可保留行內元素**：

`replaceTextInPlace(el, translation)`：透過 `resolveWriteTarget` → `injectIntoTarget` 注入。含 `\n` 時用 `buildFragmentFromTextWithBr` 產生帶 `<br>` 的 fragment。

**`<br>` ↔ `\n` round-trip**：序列化時用 sentinel `\u0001` 標記來自 `<br>` 的換行，與 source HTML 排版空白區分。normalize 先收所有原生 whitespace 為 space，再把 sentinel 還原為 `\n`。反序列化時 `\n` 還原為 `<br>`。

### 4.2.1 可保留行內元素清單

`PRESERVE_INLINE_TAGS`：A, STRONG, B, EM, I, CODE, MARK, U, S, SUB, SUP, KBD, ABBR, CITE, Q, SMALL, DEL, INS, VAR, SAMP, TIME

`SPAN`：僅當帶有 `class` 或非空 `style` 屬性時才保留。

**原子保留（`isAtomicPreserve`）**：`<sup class="reference">` 整個 deep clone 進 slot，用自閉合 `⟦*N⟧` 取代，內部文字不送 LLM。

佔位符字元：`⟦` (U+27E6) 與 `⟧` (U+27E7)。配對型 `⟦N⟧…⟦/N⟧`，自閉合 `⟦*N⟧`。

### 4.3 還原機制

`STATE.originalHTML`（Map，el → innerHTML）備份每個被替換元素的原始 HTML。再次按 Option+S 呼叫 `restorePage()` 逐一還原。

### 4.4 視覺樣式

原文元素的 font-family、font-size、color、layout 完全不動。不加邊框、背景、左邊線等任何裝飾。

---

## 5. 段落偵測規則

### 5.1 納入的 block tags

```
P, H1, H2, H3, H4, H5, H6, LI, BLOCKQUOTE, DD, DT,
FIGCAPTION, CAPTION, TH, TD, SUMMARY,
PRE, FOOTER
```

### 5.2 硬排除

- **Tags**（整個子樹不走）：SCRIPT, STYLE, CODE, NOSCRIPT, TEXTAREA, INPUT, BUTTON, SELECT
- **PRE 條件排除**：含 `<code>` 子元素時視為程式碼區塊跳過；不含 `<code>` 的 `<pre>` 視為普通容器，納入 walker（見 §5.1）
- **語意容器**：FOOTER 在無 `<article>` / `<main>` 祖先時跳過（站底 footer）；有祖先時視為內容 footer 放行（見 §5.1）
- **ARIA role**：祖先鏈含 `banner` / `contentinfo` / `search` / `grid` 則跳過。HEADER 僅在 `role="banner"` 時排除

**不做內容性 selector 排除**：content.js 不以 class/selector 判斷「該不該翻」。此類判斷交給 Gemini systemInstruction。

### 5.3 選擇器補抓（`INCLUDE_BY_SELECTOR`）

```
#siteSub, #contentSub, #contentSub2, #coordinates,
.hatnote, .mw-redirectedfrom, .dablink, [role="note"], .thumbcaption
```

### 5.4 Mixed-content fragment 單位

若 block 元素既有直接文字又含 block 後代（如 `<li>` 含巢狀 `<ul>`），walker 先讓 block 子孫獨立處理，再用 `extractDirectTextFragment()` 從父元素收集「不屬於任何 block 後代」的直接文字（含夾在中間的行內元素），建立虛擬 fragment 單位。fragment 單位注入時走原節點就地替換，不新增 DOM 容器。

### 5.5 可見性過濾

`isVisible(el)` 排除 `display:none`、`visibility:hidden`、`getBoundingClientRect()` 面積為零的元素。候選文字須含拉丁字母、CJK 或數字才算有效。

---

## 6. 專案檔案結構

```
shinkansen/
├── manifest.json
├── content-ns.js         # 命名空間、共用狀態 STATE、常數、工具函式
├── content-toast.js      # Toast 提示系統（Shadow DOM 隔離）
├── content-detect.js     # 段落偵測（語言偵測、容器排除、collectParagraphs）
├── content-serialize.js  # 佔位符序列化/反序列化（⟦N⟧…⟦/N⟧ 協定）
├── content-inject.js     # DOM 注入（resolveWriteTarget、injectIntoTarget）
├── content-spa.js        # SPA 導航偵測 + Content Guard + MutationObserver
├── content-youtube-main.js  # YouTube XHR 攔截（MAIN world, document_start, v1.2.8）
├── content-youtube.js    # YouTube 字幕翻譯（isolated world, v1.2.11）
├── content.js            # 主協調層（translatePage、Debug API、初始化）
├── content.css
├── background.js         # Service Worker（ES module）
├── lib/
│   ├── gemini.js         # Gemini API 呼叫、分批、重試
│   ├── cache.js          # 翻譯快取（LRU + debounced flush）
│   ├── storage.js        # 設定讀寫、預設值
│   ├── rate-limiter.js   # 三維 Rate Limiter
│   ├── tier-limits.js    # Tier 對照表
│   ├── logger.js         # 結構化 Log 系統
│   ├── usage-db.js       # 用量追蹤（IndexedDB）
│   ├── format.js         # 共用格式化函式（formatBytes/formatTokens/formatUSD）
│   └── vendor/           # 第三方程式庫
├── popup/
│   ├── popup.html
│   ├── popup.js          # ES module
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js        # ES module
│   └── options.css
├── _locales/
│   └── zh_TW/
│       └── messages.json # Chrome i18n 繁體中文語系檔
└── icons/
```

---

## 7. 資料流程

1. 使用者按 Option+S 或 Popup「翻譯本頁」
2. `content.js` 的 `collectParagraphs()` 遍歷 DOM 收集翻譯單位
3. `packBatches()` 依字元預算 + 段數上限打包成批次
4. 術語表前置流程（依文章長度決定策略）
5. `runWithConcurrency()` 平行送出批次，每批經 `TRANSLATE_BATCH` 訊息到 background
6. background 的 handler 查快取 → 未命中則走 Rate Limiter → 呼叫 Gemini API
7. 每批回來立即注入 DOM（`injectTranslation`），Toast 更新進度
8. 全部完成後顯示成功 Toast（含 token 數、費用、快取命中率）

---

## 8. 設定資料結構

### 8.1 `chrome.storage.sync`（跨裝置同步，100KB 上限）

以下為 `lib/storage.js` 的 `DEFAULT_SETTINGS` 完整結構（含預設值）：

```json
{
  "geminiConfig": {
    "model": "gemini-3-flash-preview",
    "serviceTier": "DEFAULT",
    "temperature": 1.0,
    "topP": 0.95,
    "topK": 40,
    "maxOutputTokens": 8192,
    "systemInstruction": "（見 §3.3 DEFAULT_SYSTEM_PROMPT）"
  },
  "pricing": { "inputPerMTok": 0.50, "outputPerMTok": 3.00 },
  "glossary": {
    "enabled": false,
    "prompt": "（見 DEFAULT_GLOSSARY_PROMPT）",
    "temperature": 0.1,
    "skipThreshold": 1,
    "blockingThreshold": 5,
    "timeoutMs": 60000,
    "maxTerms": 200
  },
  "domainRules": { "whitelist": [] },
  "autoTranslate": false,
  "debugLog": false,
  "tier": "tier1",
  "safetyMargin": 0.1,
  "maxRetries": 3,
  "rpmOverride": null,
  "tpmOverride": null,
  "rpdOverride": null,
  "maxConcurrentBatches": 10,
  "maxUnitsPerBatch": 12,
  "maxCharsPerBatch": 3500,
  "maxTranslateUnits": 1000,
  "toastOpacity": 0.7,
  "toastAutoHide": true,
  "skipTraditionalChinesePage": true,
  "ytSubtitle": {
    "autoTranslate": true,
    "temperature": 0.1,
    "systemPrompt": "（見 DEFAULT_SUBTITLE_SYSTEM_PROMPT）",
    "windowSizeS": 30,
    "lookaheadS": 10,
    "debugToast": false,
    "onTheFly": false,
    "model": "",
    "pricing": null
  }
}
```

- **API Key** 存 `chrome.storage.local`（key `apiKey`），不跨裝置同步。舊版（≤v0.61）存在 sync 的 Key 會自動遷移至 local
- 快捷鍵由 Chrome 原生 `commands` API 管理，不存設定
- `rpmOverride` / `tpmOverride` / `rpdOverride`：非 null 時覆寫 tier 對照表的對應值
- `maxTranslateUnits`：單頁翻譯段落數上限，超過截斷（0 = 不限制）

### 8.2 `chrome.storage.local`（本地，5MB 上限）

- **翻譯快取**：key `tc_<sha1>` → 譯文字串
- **術語表快取**：key `gloss_<sha1>` → 術語對照 JSON
- **版本標記**：key `__cacheVersion` → manifest version（不一致時清空所有快取）
- **RPD 計數**：key `rateLimit_rpd_<YYYYMMDD>` → 當日請求數

### 8.3 同步策略

- `chrome.storage.sync` 自動跨裝置同步設定（不含 API Key）
- 翻譯快取與術語表快取只存 local，不同步
- 設定頁提供匯出/匯入 JSON（API Key 不含在匯出範圍），匯入時 `sanitizeImport()` 驗證所有欄位

---

## 9. 翻譯快取

### 9.1 Key 設計

`tc_` + SHA-1（原文十六進位）= 43 字元。同一段原文跨頁面共用同一 key。key 只 hash 原文，不含模型/prompt；換模型改 prompt 時以版本自動清空處理。

有術語表時，快取 key 追加 `_g<glossary hash 前 12 字元>` 後綴，確保有/無術語表的翻譯分開快取。

### 9.2 批次讀寫

- `cache.getBatch(texts)`：一次 `storage.local.get(allKeys)`。讀取時累積 LRU 時間戳到 `pendingTouches`，由 5 秒 debounce 統一 flush
- `cache.setBatch(texts, translations)`：一次 `storage.local.set(updates)`。eviction check 最多每 30 秒一次

### 9.3 清空邏輯

- `cache.clearAll()`：filter 出 `tc_` 和 `gloss_` 開頭的 key 全部 remove
- `cache.checkVersionAndClear(currentVersion)`：比對版本，不一致則 clearAll 並更新 `__cacheVersion`
- Service Worker 啟動時與 `onInstalled` 事件各執行一次

### 9.4 統計

`cache.stats()` 回傳 `{ count, bytes }`。bytes 為 key + value 字元長度粗估。

---

## 10. 快捷鍵

**Option + S**（macOS）/ **Alt + S**（其他 OS）—— 切換翻譯狀態。

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

## 11. 翻譯狀態提示（Toast）

### 11.1 容器

`position: fixed; z-index: 2147483647`，Shadow DOM 隔離（closed mode），280px 寬、白底圓角陰影。位置由 CSS class `pos-{position}` 控制，支援 `bottom-right`（預設）、`bottom-left`、`top-right`、`top-left` 四個選項，使用者可在設定頁調整。預設透明度 70%。翻譯完成的 success toast 預設 5 秒後自動關閉（`toastAutoHide` 開關，預設開啟）；關閉此選項時維持舊行為——需手動點 × 或點擊外部區域關閉。

### 11.2 狀態

| 狀態 | 主訊息 | 進度條 | 自動消失 |
|------|--------|--------|----------|
| loading | `翻譯中… N / Total` + 計時器 | 藍色（mismatch 時黃色閃爍） | 否 |
| success | `翻譯完成（N 段）` + token/費用/命中率 | 綠色 100% | 是（`toastAutoHide` 開啟時 5 秒；預設開啟） |
| error | `翻譯失敗：<msg>` | 紅色 100% | 否 |
| restore | `已還原原文` | 綠色 100% | 2 秒 |

成功 Toast 的 detail 兩行：token 數 + implicit cache hit%、實付費用 + 節省%。費用套用 Gemini implicit context cache 折扣（cached tokens ×0.25 計費）。

### 11.3 設計原則

- 不用轉圈 spinner，用橫向進度條 + 計時器
- 不用左邊色條 border-left
- 成功提示預設 5 秒後自動消失（`toastAutoHide` 設定控制；關閉時需手動點 × 或點擊外部區域）
- 延遲 rescan 補抓在 UI 層完全隱形

---

## 12. LLM 除錯 Log

`lib/logger.js` 提供結構化 Log，記錄 API 呼叫的時間、模型、參數、耗時、token、錯誤等。

- **記憶體 buffer**：最近 1000 筆，設定頁「Debug」分頁可瀏覽（分類/等級篩選、搜尋、匯出 JSON）
- **DevTools Console**：設定頁可選啟用同步輸出
- **Debug Bridge**：content.js 透過 CustomEvent 橋接，main world 可用 `shinkansen-debug-request` / `shinkansen-debug-response` 事件讀取 log（支援 `GET_LOGS`、`CLEAR_LOGS`、`CLEAR_CACHE`、`TRANSLATE`、`RESTORE`、`GET_STATE`）

---

## 13. Popup 面板規格

### 13.1 版面

- Header：emoji 🚄 + 名稱「Shinkansen」+ 版本號（動態讀取）
- 主按鈕：「翻譯本頁」/「顯示原文」（依 `GET_STATE` 切換）
- 編輯譯文按鈕（預設 `hidden`，翻譯完成後才顯示；切換 `TOGGLE_EDIT_MODE`）
- 白名單自動翻譯 toggle
- 術語表一致化 toggle
- YouTube 字幕翻譯 toggle（只在 YouTube 影片頁面顯示）
- 快取統計（段數 / 大小）+ 清除快取按鈕
- 累計費用 / token 顯示（透過 `USAGE_STATS` 訊息讀取；重置功能在 options 頁面）
- 狀態列（「狀態：就緒」/ 「狀態：正在翻譯…」/ 錯誤訊息等）
- Footer：設定按鈕（開啟 options 頁面）+ 快捷鍵提示（動態讀取 `chrome.commands`）

### 13.2 版本顯示

**必須**透過 `chrome.runtime.getManifest().version` 動態讀取，不得寫死。

---

## 14. 訊息協定（content ↔ background ↔ popup）

### 14.1 content → background

| type | payload | 回應 |
|------|---------|------|
| `TRANSLATE_BATCH` | `{ texts, slots, … }` | `{ ok, result, usage }` |
| `EXTRACT_GLOSSARY` | `{ input }` | `{ ok, terms, _diag }` |
| `LOG` | `{ level, category, message, data }` | — |
| `LOG_USAGE` | `{ inputTokens, outputTokens, … }` | `{ ok }` |
| `SET_BADGE_TRANSLATED` | — | `{ ok }` |
| `CLEAR_BADGE` | — | `{ ok }` |
| `STICKY_QUERY` | — | `{ ok, shouldTranslate, slot }` — 查當前 tab 是否在跨 tab sticky set，回傳 preset slot（v1.4.12 從 engine 改存 slot） |
| `STICKY_SET` | `{ slot: number }` | `{ ok }` — 翻譯成功後將當前 tab 加入 sticky set 記錄 slot（v1.4.12） |
| `STICKY_CLEAR` | — | `{ ok }` — 還原原文時將當前 tab 從 sticky set 移除（v1.4.11） |

### 14.2 popup / options → background

| type | 回應 | 用途 |
|------|------|------|
| `CACHE_STATS` | `{ ok, count, bytes }` | 快取統計 |
| `CLEAR_CACHE` | `{ ok, removed }` | 清空翻譯快取 |
| `USAGE_STATS` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 累計費用/token 顯示 |
| `RESET_USAGE` | `{ ok, totalInputTokens, totalOutputTokens, totalCostUSD, since }` | Popup 重置累計統計 |
| `QUERY_USAGE_STATS` | `{ ok, stats }` | Options 用量彙總卡片 |
| `QUERY_USAGE_CHART` | `{ ok, data }` | Options 用量折線圖 |
| `QUERY_USAGE` | `{ ok, records }` | Options 用量明細表格 |
| `EXPORT_USAGE_CSV` | `{ ok, csv }` | Options 匯出 CSV |
| `CLEAR_USAGE` | `{ ok }` | Options 清除用量紀錄 |
| `GET_LOGS` | `{ logs }` | 讀取 Log buffer（同步） |
| `CLEAR_LOGS` | — | 清空 Log buffer（同步） |
| `CLEAR_RPD` | `{ ok, removedKeys }` | 清除 RPD 計數（除錯用） |

> **設定讀寫**：popup 和 options 直接透過 `chrome.storage.sync` / `chrome.storage.local` 存取設定，不經 message handler。

### 14.3 background / popup → content

| type | 用途 |
|------|------|
| `TRANSLATE_PRESET` | v1.4.12：依 `payload.slot`（1/2/3）觸發對應 preset 翻譯；已翻譯時任一 slot 皆 `restorePage`；翻譯中任一 slot 皆 abort |
| `TOGGLE_TRANSLATE` | 舊訊息（popup 按鈕用）；v1.4.12 起映射為 preset slot 1 |
| `GET_STATE` | 查詢翻譯狀態 |
| `TOGGLE_EDIT_MODE` | 切換編輯譯文模式 |

### 14.4 Badge

翻譯完成後 `SET_BADGE_TRANSLATED` 點亮紅點 badge（`●`，`#cf3a2c`）。分頁跨站導航時 `chrome.tabs.onUpdated` 自動清除。

### 14.5 跨 tab sticky 翻譯（v1.4.11 / v1.4.12 schema 更新）

`background.js` 維護 `stickyTabs: Map<tabId, slot>`（v1.4.12 起 value 為 preset slot number），持久化於 `chrome.storage.session.stickyTabs`（service worker 休眠重啟時 hydrate 回 memory）。

行為：
- 任一 tab 按 preset 快速鍵（Alt+A/S/D）翻譯成功 → content.js 送 `STICKY_SET {slot}` → 該 tab 進入 set。
- `chrome.tabs.onCreated`：若新 tab 的 `openerTabId` 在 set 中，把新 tab 也加入 set 並繼承相同 slot。涵蓋 Cmd+Click、`target="_blank"`、`window.open()` 等所有由瀏覽器標記 opener 的開法。
- content script 載入時送 `STICKY_QUERY`，若回 `shouldTranslate=true` 則用回傳的 slot 呼叫 `SK.handleTranslatePreset(slot)`，忠實繼承使用者當時按的 engine+model 組合（優先順序：sticky > whitelist autoTranslate）。
- `restorePage()` 送 `STICKY_CLEAR`，只移除當前 tab，不影響樹中其他 tab。
- `chrome.tabs.onRemoved` 自動從 set 清掉關閉的 tab id，避免長期累積。

不繼承的情境（無 `openerTabId`）：手動在新分頁打網址、從 bookmark 開、從外部 app 開。

### 14.6 Preset 快速鍵（v1.4.12）

- manifest commands：`translate-preset-1`（Alt+A 預設 Flash）/ `translate-preset-2`（Alt+S 預設 Flash Lite）/ `translate-preset-3`（Alt+D 預設 Google MT）。
- storage schema：`translatePresets: [{ slot, engine, model, label }]`，三組預設值內建於 `lib/storage.js` `DEFAULT_SETTINGS`。
- 統一行為：
  - 閒置狀態按任一 preset 鍵 → 依該 slot 的 `engine` + `model` 啟動翻譯
  - 翻譯中按任一 preset 鍵 → abort
  - 已翻譯完成按任一 preset 鍵 → `restorePage`（不分 slot）
- `modelOverride` 傳輸：content.js `SK.translateUnits` 把 slot 對應的 model 放進 `TRANSLATE_BATCH` payload.modelOverride → background `handleTranslate` 透過 `geminiOverrides.model` 覆蓋 `geminiConfig.model`（與 YouTube 字幕用的同一條機制，用 `cacheTag` 參數區分快取分區避免污染）。
- 未來 Options UI（v1.4.13 規劃）提供 engine/model/label 編輯；v1.4.12 使用者要改 preset 可暫時直接寫 `chrome.storage.sync.translatePresets`。

background.js 使用 `messageHandlers` 物件 map 做 O(1) dispatch，統一的 listener 負責 sendResponse 包裝與錯誤處理。

---

## 15. Debug API

供自動化測試（Playwright）在 isolated world 查詢 content script 內部狀態。`content.js` 載入後在 isolated world 掛上 `window.__shinkansen`：

```js
window.__shinkansen = {
  version: string,                          // manifest version（getter）
  collectParagraphs(): Array,               // 回傳序列化安全的段落陣列
  collectParagraphsWithStats(): Object,     // 同上 + walker 跳過統計
  serialize(el): { text, slots },           // 佔位符序列化
  deserialize(text, slots): { frag, ok, matched }, // 佔位符反序列化
  testInject(el, translation): { sourceText, slotCount }, // 測試用：跑完整 serialize → inject 路徑，跳過 API 層
  selectBestSlotOccurrences(text): Object,  // 測試用：暴露 slot 重複排除邏輯
  getState(): Object,                       // 翻譯狀態快照
}
```

**設計原則**：查詢類方法只讀不寫、回 plain object 不回 DOM 參考、永遠啟用（無開關）、掛在 isolated world。`testInject` 和 `selectBestSlotOccurrences` 是測試專用 helper（v0.59 起），供 regression spec 驗證注入路徑而不需要呼叫 Gemini API。

---

## 16. 用量追蹤

`lib/usage-db.js` 使用 IndexedDB 儲存每次翻譯的詳細紀錄（時間、URL、模型、token 數、費用、段落數等）。

- 設定頁「用量」分頁：彙總卡片（總費用/token/筆數/最常用模型）、折線圖（日/週/月粒度）、明細表格
- 支援日期範圍篩選、CSV 匯出、清除
- 費用計算套用 Gemini implicit cache 折扣後的實付值
