# Bing Translate 引擎實作方案

## 目標

新增 Bing Translate 作為第四翻譯引擎，免費、無需 API Key，且在中國大陸可用（`cn.bing.com`）。

## 設計原則

1. **模組獨立**：所有 Bing 邏輯放在新檔案中，最小化對現有檔案的修改，降低 upstream 合併衝突
2. **介面對齊**：`translateBingBatch()` 與 `translateGoogleBatch()` 同簽名，方便 background.js 統一調度
3. **YouTube 字幕暫不支援**：降低初始複雜度，後續可擴展

---

## 技術細節

### Token 管理（`lib/bing-token.js`）

Bing 翻譯端點（`/ttranslatev3`）需要先從翻譯頁面取得 token：

1. **GET** `https://www.bing.com/translator`（或 `cn.bing.com/translator`）
2. 從 HTML 中正則提取：
   - `IG`：頁面 session ID（`IG:"xxxxxxxx"`）
   - `IID`：元素 ID（通常為 `translator.xxxx`）
   - `key` + `token`：從嵌入的 JS 物件中提取
   - `tokenTs` + `tokenExpiryInterval`：token 過期時間
3. **持久化**到 `chrome.storage.session`（Chrome）或 `storage.local`（Firefox fallback），避免 Service Worker 掛起後丟失
4. **並發鎖**：用 Promise lock 防止多個 batch 同時刷新 token
5. **Auth 失敗重試**：翻譯請求返回 auth 錯誤時，強制刷新 token 重試一次

```javascript
// lib/bing-token.js 導出介面
export async function getBingToken(endpointMode)
  // → { ig, iid, key, token, baseUrl }
  // 自動快取 + 過期刷新 + 並發鎖 + fallback 域名
```

### 翻譯 API（`lib/bing-translate.js`）

```javascript
// lib/bing-translate.js 導出介面
export async function translateBingBatch(texts, targetLang = 'zh-TW')
  // → { translations: string[], chars: number }
```

**請求格式**：
```
POST https://www.bing.com/ttranslatev3?isVertical=1&IG={ig}&IID={iid}
Content-Type: application/x-www-form-urlencoded

fromLang=auto-detect&to={targetLang}&text={text}&token={token}&key={key}
```

**Batch 策略**：
- Bing 單次上限 **1000 字元**（公開頁面標示）
- 不使用 SEP 串接（Bing 不保證保留分隔符）
- 改為**逐段翻譯 + 並發控制**（每段獨立 POST，最多 3 並發）
- 短文本可多段串接測試，但初版保守逐段處理

**語言代碼映射**：
| uiLocale | Bing targetLang |
|----------|----------------|
| `zh-TW`  | `zh-Hant`      |
| `zh-CN`  | `zh-Hans`      |
| `ja`     | `ja`           |

**回應格式**：
```json
[{"translations":[{"text":"翻譯結果","to":"zh-Hant"}]}]
```

**域名策略**（`endpointMode`）：
- `auto`（預設）：先嘗試 `www.bing.com`，失敗則 fallback `cn.bing.com`，記住成功的域名
- `global`：強制 `www.bing.com`
- `china`：強制 `cn.bing.com`

### Cache Key

使用 `_bt` 後綴，與 Google (`_gt`) / Gemini (`''`) / OpenAI-compat (`_oc`) 分區：
```
tc_<sha1>_bt
```

---

## 需修改的檔案清單

### 新建檔案（零衝突風險）

| 檔案 | 內容 |
|------|------|
| `lib/bing-token.js` | Token 獲取/快取/刷新/並發鎖 |
| `lib/bing-translate.js` | `translateBingBatch()` 翻譯 + batch 管理 |

### 最小修改檔案（低衝突風險）

| 檔案 | 改動 | 行數 |
|------|------|------|
| `background.js` | import + `TRANSLATE_BATCH_BING` handler | ~20 行 |
| `content.js` | preset dispatch 加 `'bing'` + `SK.translatePageBing` 或複用 Google 路徑 | ~10 行 |
| `content-ns.js` | 合法引擎列表加 `'bing'` | ~1 行 |
| `lib/storage.js` | `bingTranslate: { endpointMode: 'auto' }` | ~5 行 |
| `options/options.html` | preset 引擎 `<option value="bing">` + 設定 UI | ~10 行 |
| `options/options.js` | 引擎切換邏輯 | ~5 行 |
| `lib/i18n.js` + `content-ns.js` | Bing 相關 i18n key（三語） | ~15 行 |
| `privacy-policy.html` | 加 Bing 說明 | ~5 行 |

---

## TODO List

### TODO-01: lib/bing-token.js — Token 管理模組
- 從 bing.com/translator 頁面提取 IG/IID/key/token
- 持久化到 storage.session（sessionStore 跨平台）
- 過期自動刷新 + 並發鎖
- endpointMode auto/global/china 域名策略
- 單元測試

### TODO-02: lib/bing-translate.js — 翻譯 API 模組
- translateBingBatch(texts, targetLang) 介面
- 語言代碼映射（zh-TW→zh-Hant, zh-CN→zh-Hans）
- 逐段翻譯 + 並發控制
- 錯誤處理 + auth 失敗重試
- 單元測試

### TODO-03: background.js — 訊息處理
- import bing-translate.js
- TRANSLATE_BATCH_BING handler（對齊 TRANSLATE_BATCH_GOOGLE）
- cache key '_bt' 後綴
- forbidden-terms zh-CN skip 適用

### TODO-04: content.js — 翻譯流程
- handleTranslatePreset 加 'bing' 分支
- 複用 translatePageGoogle 路徑（改 message type 即可）
- Toast 標示 [Bing]

### TODO-05: 設定 UI + i18n
- options.html preset 引擎下拉加 Bing 選項
- options.html 新增 Bing 域名設定（endpointMode）
- options.js 載入/儲存 bingTranslate 設定
- storage.js DEFAULT_SETTINGS 加 bingTranslate
- i18n.js 三語新增 Bing 相關 key
- content-ns.js 字串表同步

### TODO-06: 隱私政策 + 文檔
- privacy-policy.html 加 Bing 外連說明
- README / README.ja 加 Bing 引擎說明
- SPEC.md 更新
