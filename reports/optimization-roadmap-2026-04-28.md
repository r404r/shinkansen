# 翻譯流程優化路線圖

**撰寫日期**:2026-04-28
**資料來源**:`tools/probe-priority.js` 真實 10 個 URL × glossary on/off 兩種模式實測,搭配 `content.js` milestone instrumentation log。完整實測資料見 `reports/priority-sort-probe-2026-04-28.md`。

---

## 1. 真實時間預算

### OFF 模式(沒啟用 glossary)

```
t=0          Option+S
t≈30-100ms   batch 0 send  ← storage.get + 繁中偵測 + collectParagraphs +
                              prioritize + serialize + packBatches 加總 30-100ms
t≈3000-7000ms batch 0 recv → 注入 DOM ← 第一個中文字
              同步 dispatch batch 1-N
t≈10-17s     全部完成
```

**首字延遲 ≈ Gemini API 一次往返 3-7s,前置邏輯不到 100ms**

### ON 模式(啟用 glossary blocking)

```
t=0          Option+S
t≈10ms       glossary_decision 進 blocking → 送 EXTRACT_GLOSSARY 並 await
t≈1500-7400ms glossary 回 → batch 0 send
t≈4500-14000ms batch 0 recv → 第一個中文字
t≈14-21s     全部完成
```

**首字延遲 ≈ EXTRACT_GLOSSARY(1.5-7.4s) + batch 0 翻譯(3-7s)= 5-14s**

---

## 2. 優化候選清單

### 候選 A:batch 0 變小

**目前**:batch 0 = `min(maxUnitsPerBatch=20, maxCharsPerBatch=3500)` 抓滿
**改成**:batch 0 專用更小 limit,例如 `maxUnits=10` 或 `maxChars=1500`

實測 batch 0 token 量 → Gemini 等待時間:
- TWZ:16 units / 2921 chars → 6627ms
- GitHub:20 units / 514 chars → 3080ms
- Cloudflare:20 units / 2888 chars → 6542ms

**chars 越多回送越慢**。把 batch 0 砍半到 ~1500 chars 預期 Gemini 回送從 6-7s → 3-4s。

**節省**:OFF 模式首字 3-7s → **2-4s**(需實測驗證)
**代價**:整頁完成時間幾乎不變(總工作量沒變,只是切批方式改),batch 1+ 多一批
**實作成本**:**極低**(translateUnits 內 packBatches 第一批用獨立 limit 即可)
**風險**:極低
**適用**:OFF + ON

---

### 候選 B:Readability content score(tier 0 細分)

**現狀**:GitHub / Wikipedia 因 `<main>` 內混了 UI chrome,tier 0 命中過多元素 → batch 0 還是吃到 tab / 工具列

**做法**:不引進整個 `@mozilla/readability` 套件(60KB bundle、改寫整個 DOM),只把它的 content score 啟發式抄過來:

```js
function readabilityScore(el) {
  let score = 0;
  score += (el.textContent || '').length / 100;         // 文字長度
  score += ((el.textContent || '').match(/[,,]/g) || []).length;  // 逗號數
  if (/^H[1-3]$/.test(el.tagName)) score += 5;         // 標題加分
  if (el.querySelector('p')) score += 3;                // 含 <p> 加分
  const idClass = (el.id + ' ' + el.className).toLowerCase();
  if (/article|content|post|main|story|body/.test(idClass)) score += 5;
  if (/comment|sidebar|nav|menu|footer|widget|share|related/.test(idClass)) score -= 5;
  return score;
}
```

tier 規則升級:
- **tier 0a**:祖先有 main/article + score >= 5(高信心內文)
- **tier 0b**:祖先有 main/article + score < 5(可能是工具列)
- tier 1 / 2 維持

**節省**:GitHub README + Wikipedia 等「`<main>` 包 chrome」的網站排序成功率提升,batch 0 拿真內文
**代價**:0 KB bundle 增加,只是新增一個 helper。class/id 啟發式有「軟性 selector 黑名單」味道,但這是評分扣分(不是硬排除),且來源是 Mozilla 過十年累積的 reader mode 觀察
**實作成本**:**低**(content-detect.js 加 helper + prioritizeUnits 改條件)
**驗證**:同一組 10 個 URL 重跑 probe,看 GitHub / Wikipedia 的 batch 0 是否吃到真內文
**適用**:全部

---

### 候選 C:glossary 跟 batch 0 並行

**目前**:`Option+S → EXTRACT_GLOSSARY blocking → batch 0 send → wait → recv`
**改成**:同時 fire EXTRACT_GLOSSARY + send batch 0(不帶 glossary)→ batch 0 之後檢查 glossary 是否回來,batch 1+ 帶 glossary

**節省**:ON 模式首字 5-14s → **3-7s**(等於 OFF 模式速度,中位數約 3s)
**代價**:batch 0 翻的內容沒 glossary,可能跟 batch 1+ 用詞不一致。batch 0 通常是 H1 + 文章開頭,術語密度低,風險小;但若文章開頭就有大量人名 / 品牌,可能 batch 0 翻「川普」、batch 1+ glossary 指定「特朗普」(或反向)
**實作成本**:**中**(translatePage 流程改寫,需處理 STATE._glossaryPromise / abort signal / glossary timeout 三方互動)
**風險**:術語不一致(限 batch 0 內)
**適用**:ON

---

### 候選 D:glossary 用更小 / 更快的 model

**目前**:`extractGlossary` 用 `gemini-3-flash-preview`(跟翻譯同一個 model)
**改成**:用 `gemini-3-flash-lite-preview`

**節省**:預估 1.5-7.4s → 0.5-2.5s(需先實測 Flash Lite vs Flash 對比)
**代價**:glossary 抽取品質可能下降,術語表可能有錯
**實作成本**:**低**(`background.js` extractGlossary 加 `glossaryModel` 設定)
**驗證**:Flash vs Flash Lite 各跑一次 glossary 抽取,比對 30-50 個 term 的正確率
**風險**:術語品質下降會讓所有 batch 翻譯品質一起下降(glossary 是全頁共用)
**適用**:ON

---

### 候選 E:Gemini API streaming 邊收邊注入

**目前**:每個 batch 是一次性 request → 等完整 response 回來 → 解析 JSON → 注入
**改成**:用 Gemini 的 `streamGenerateContent` SSE,邊收 chunk 邊增量解析 → 譯文字串將完整時就先注入該段

Gemini Flash 一般 first-token-latency 約 500-1000ms,之後 streaming 約 100-200 tokens/sec。對 20 unit / 1500 chars 的 batch 0,完整輸出 token 約 800-1500,但首句可能 1-2s 就出現。

**節省**:OFF 首字 3-7s → **可能 1-3s**(視 LLM 開始輸出的時間)
**代價**:占位符對齊邏輯複雜化(streaming 中段可能切到 `⟦N⟧` 中間),需要 incremental JSON parser 或 split-by-line 策略
**實作成本**:**高**(`background.js` Gemini fetch 路徑大改,`content.js` 收 partial response 的注入路徑也要新邏輯)
**風險**:中(占位符斷裂、解析失敗的回退路徑要重做)
**適用**:全部

---

## 3. 比較矩陣

| 候選 | 預期效果 | 實作成本 | 風險 | 適用模式 |
|---|---|---|---|---|
| **A. batch 0 變小** | OFF 首字 3-7s → 2-4s | 極低 | 極低 | OFF + ON |
| **B. Readability tier 0 細分** | GitHub / Wikipedia 排序成功 | 低 | 低 | 全部 |
| **C. glossary 跟 batch 0 並行** | ON 首字 5-14s → 3-7s | 中 | batch 0 術語不一致 | ON |
| **D. glossary 換 Flash Lite** | ON 首字再省 1-3s | 低 | 術語品質下降 | ON |
| **E. Gemini streaming** | OFF 首字 3-7s → 1-3s | 高 | 中 | 全部 |

---

## 4. 不做的選項

- **lazy serialize**:實測 serialize 全部 unit 只佔 0-3ms,改成 lazy 最多省 1-2ms,不值得
- **預熱 Gemini 連線**:跨頁面 service worker 重啟成本高,且每次 page load 打 Gemini 浪費 quota
- **整套 `@mozilla/readability` 引入**:60KB bundle、會改寫 DOM,跟 in-place 翻譯模型衝突,而且 SPA rescan 多次跑會嚴重拖慢

---

## 5. 候選清單給你選

請告訴我要做哪些、按什麼順序。每個候選都是獨立 PR,做完該候選的 bump 流程跟 v1.7.1 一樣(test + bump 6 處同步點 + release)。

---

## 6. v1.7.2 進度(2026-04-28 下午)

| 候選 | 狀態 | 實測結果 |
|---|:---:|---|
| A. batch 0 變小 | ✅ 已實作於 v1.7.2 | OFF 首字延遲平均 -29%(中位數 -36%),最佳 -43% |
| B. Readability tier 0 細分 | ✅ 已實作於 v1.7.2 | GitHub / Wikipedia 排序徹底解決——README H1 / 文章內文 P 衝到 batch 0 |
| C. glossary 跟 batch 0 並行 | 未做 | ON 模式再省 1.5-7s 的潛力,但 batch 0 內術語可能不一致 |
| D. glossary 換 Flash Lite | ✅ 已實作於 v1.7.2(改成使用者可選,預設 Flash Lite) | Flash Lite 比 Flash 快 18% + 便宜 5 倍,terms 品質接近 |
| E. Gemini API streaming | 未做 | OFF 首字再省 1-3s 的潛力,實作成本高 |

完整實測資料見 `priority-sort-probe-2026-04-28.md` 的 v1.7.2 章節(§8-§10)。
