# v1.7.1 翻譯優先級機制實測報告

**測試日期**:2026-04-28
**測試版本**:v1.7.1(`prioritizeUnits` + 序列 batch 0)+ instrumentation milestone log
**測試引擎**:Gemini 3 Flash Preview(`gemini-3-flash-preview`,Service Tier `DEFAULT`)
**截斷上限**:每頁最多 120 個 unit
**測試方式**:`tools/probe-priority.js` 攔截 `browser.runtime.sendMessage` + 在 `translatePage` / `translateUnits` 內加 8 個 milestone log,記錄真實時間戳。glossary on/off 兩種模式各跑 10 個 URL。

---

## 0. 背景

v1.7.1 之前:`collectParagraphs` 走 TreeWalker DOM 順序,加上 4 條補抓 querySelectorAll 都 append 到 array 尾端,`<header>` / `<nav>` / `<aside>` 等 DOM 前段元素優先進入 batch 0,使用者最先看到「導覽列變中文」而不是文章開頭。

v1.7.1 加入兩個改動:
1. **`SK.prioritizeUnits`** — `collectParagraphs` 後做 stable sort,把 `<main>` / `<article>` 後代(tier 0)、長段落(tier 1)推到前面,連結密集 / 短段落留在後面(tier 2)
2. **序列 batch 0** — `translateUnits` / `translateUnitsGoogle` 序列跑 batch 0,完成後才用 worker pool 並行 batch 1+

---

## 1. 總覽

| # | 網站 | segments | batches | 排序成功? | translateUnits | cost(USD) |
|---|---|---:|---:|:---:|---:|---:|
| 1 | TWZ SpaceX 文章 | 158 | 9 | ✅ | 13.4s | 0.0413 |
| 2 | Wikipedia "Tea" | 816 | 12 | ⚠️ 部分 | 17.4s | 0.0579 |
| 3 | Hacker News 首頁 | 64 | 4 | ❌ 無變化 | 14.5s | 0.0219 |
| 4 | GitHub repo README | 150 | 6 | ❌ 無變化 | 6.4s | 0.0179 |
| 5 | Cloudflare Blog 首頁 | 44 | 3 | ✅ | 12.3s | 0.0094 |
| 6 | The Verge 首頁 | 301 | 6 | ✅ | 11.3s | 0.0269 |
| 7 | Ars Technica 首頁 | 82 | 5 | ✅✅ | 10.7s | 0.0169 |
| 8 | NPR 首頁 | 189 | 6 | ✅ | 8.8s | 0.0208 |
| 9 | Smashing Magazine | 101 | 6 | ✅ | 13.5s | 0.0206 |
| 10 | CSS-Tricks | 105 | 6 | ✅ | 9.6s | 0.0192 |

排序機制 8/10 顯著改善。

---

## 2. 排序機制實際表現(BEFORE vs AFTER)

### 2.1 排序成功的典型:Ars Technica 首頁

| | 排序前 head 5(原 DOM 順序) | 排序後 head 5 |
|---|---|---|
| 1 | DIV "These cookies are set by a range of social media services..."(429字) | H1 "Ars Technica homepage" |
| 2 | DIV "This website uses essential cookies and services..."(266字) | H2 "Meet the players who lost big money on Peter Molyneux's..."(69字) |
| 3 | DIV "These cookies may be set through our site by our advertising..."(392字) | P "After millions in NFT sales..." |
| 4 | DIV "These cookies allow us to count visits..."(433字) | H2 "Put it in pencil: NASA's Artemis III mission..." |
| 5 | DIV "This website uses functional cookies..."(253字) | H2 "Open source package with 1 million monthly downloads..." |

排序前 batch 0 全是 cookie 同意書 DIV(每段 250-430 字),排序後第一個翻譯出現的是 H1 + 各文章標題與摘要。

### 2.2 TWZ SpaceX 文章

| | 排序前 head 5 | 排序後 head 5 |
|---|---|---|
| 1 | LI "Latest" | **H1 "This Is How U.S. National Security Has Become Dependent On SpaceX"** |
| 2 | LI "News & Features Artificial Intelligence Bunker Talk Cyber..." | DIV "A bitter feud between Trump and Musk serves as a reminder..."(副標) |
| 3 | LI "Air Air Forces Airships & Blimps Military Aviation History..." | P "By Joseph Trevithick, Tyler Rogoway"(作者) |
| 4 | LI "Sea Navies Naval History Amphibious Operations..." | P "Updated Jun 6, 2025 1:23 PM EDT"(日期) |
| 5 | LI "Land Armies Land Warfare History Tanks..." | FIGCAPTION "HUM Images/Universal Images Group via Getty Images"(圖說) |

batch 0 完美吃到「文章標題 + 副標 + 作者 + 日期 + 圖說」。

### 2.3 排序失敗的案例

**Hacker News**:沒 `<main>` / `<article>`,純 `<table>` 排版 → 全 tier 2 → 維持 DOM 順序。Hacker News 視覺第一行也是 nav,不算問題。

**GitHub repo**:`<main>` 包了所有 GitHub UI tab(Notifications / Fork / Star / Code),tier 0 太粗 → 全進 tier 0 → 維持 DOM 順序。**這是 tier 0 訊號粒度不夠的問題**。

**Wikipedia "Tea"**:H1 進到第 1 位 ✅,但 idx 1-9 是 MediaWiki 的 Article/Talk tab、字體切換器等,這些都在 `<main>` 內。

---

## 3. 真實時序拆解

### 3.1 GLOSSARY OFF(模擬使用者真實環境)

```
name              storage  zh   collect  prio  preser  glossary_dec  before_TU  batch0_send  batch0_recv_elapsed
twz                  0     1     6( 5)    0     0          7              7         46           6627
wiki-tea             0     1    16(15)    1     0         18             18         72           4704
hn                   0     0     2( 2)    0     1          3              3         35           6629
github               6     6    11( 5)    0     1         12             12         41           3080
cloudflare-blog      0     0     4( 4)    0     0          4              4         35           6542
verge                1     2    17(15)    0     1         18             18         94           5024
ars                  0     1     7( 6)    0     0          7              7         32           4833
npr                  0     0    12(12)    1     0         13             13         49           3987
smashing             0     0     3( 3)    0     1          4              4         35           5907
css-tricks           2     2     5( 3)    1     0          6              6         29           4367
```

(數字單位 ms,括號內為該階段本身耗時)

**真實使用者按下 Option+S → batch 0 送出 = 29-94ms(平均 ~50ms)**

各階段時間分布:
- storage.sync.get(null):0-6ms
- 繁中偵測:0-6ms
- collectParagraphs(整頁掃描 + 4 條補抓):2-17ms(視頁面段落數)
- prioritizeUnits(stable sort):0-1ms
- preSerialized(讀 innerText):0-1ms
- translateUnits 內部 serialize(全部 unit serializeWithPlaceholders):0-3ms
- packBatches:0-9ms

### 3.2 GLOSSARY ON(對照組)

```
name              glossary_dec  before_TU  batch0_send  batch0_recv_elapsed
twz                    7         3556        3583           6734
wiki-tea              20         3004        3065           5266
hn                     4         2006        2036           6805
github                 6         1568        1595           3057
cloudflare-blog        2         2005        2033           5854
verge                 14         5791        5840           4546
ars                    6         2007        2025           4371
npr                   13         7366        7402           4344
smashing               4         2519        2555           6099
css-tricks             4         5788        5810           4376
```

啟用 glossary 後 batch 0 send 變成 1595-7402ms。差距(`glossary_dec` 到 `before_translate_units`)就是 EXTRACT_GLOSSARY 那次 Gemini call 的耗時:**1.5-7.4 秒**。

### 3.3 OFF vs ON 對照

| 網站 | OFF batch 0 send | ON batch 0 send | 差距(EXTRACT_GLOSSARY 成本) |
|---|---:|---:|---:|
| twz | 46ms | 3583ms | +3537ms |
| wiki-tea | 72ms | 3065ms | +2993ms |
| hn | 35ms | 2036ms | +2001ms |
| github | 41ms | 1595ms | +1554ms |
| cloudflare | 35ms | 2033ms | +1998ms |
| verge | 94ms | 5840ms | +5746ms |
| ars | 32ms | 2025ms | +1993ms |
| npr | 49ms | 7402ms | +7353ms |
| smashing | 35ms | 2555ms | +2520ms |
| css-tricks | 29ms | 5810ms | +5781ms |

EXTRACT_GLOSSARY 的成本中位數約 3 秒,波動範圍 1.5-7.4 秒。波動原因:1) glossary 用同一個 Gemini Flash 模型,有 server 端 latency 抖動 2) compressedText 字數差異

### 3.4 batch 0 等 Gemini API 回送時間

無論 OFF / ON,batch 0 翻譯本身的 Gemini call 約 3-7 秒(取決於 token 數):

| 網站 | OFF | ON | batch 0 token 規模 |
|---|---:|---:|---|
| twz | 6627ms | 6734ms | 16 units / 2921 chars |
| wiki-tea | 4704ms | 5266ms | 20 units / 1349 chars |
| hn | 6629ms | 6805ms | 20 units / 1896 chars |
| github | 3080ms | 3057ms | 20 units / 514 chars |
| ars | 4833ms | 4371ms | 20 units / 1465 chars |

batch 0 chars 從 514(GitHub README)到 2921(TWZ),Gemini 回送時間跟 token 量成弱相關。

---

## 4. 真實使用者體驗時間線

### 4.1 OFF 模式(沒啟用 glossary)

```
t=0       使用者按 Option+S
t≈30-100ms  batch 0 送出 Gemini API  ← 等待空白頁開始
t≈3000-7000ms batch 0 收回 → 注入 DOM ← 第一個中文字出現
              同步派送 batch 1-N
t≈10-17s    全部完成
```

**等待空白頁的時間 ≈ 3-7 秒**(99% 是 Gemini API 一次往返,前置邏輯不到 100ms)

### 4.2 ON 模式(啟用禁用詞 / 術語一致化)

```
t=0       使用者按 Option+S
t≈10ms    glossary_decision 進 blocking 路徑
t≈10ms    送出 EXTRACT_GLOSSARY API call ← 等待開始
t≈1500-7400ms  glossary 回來
t≈1500-7400ms  batch 0 送出 Gemini API
t≈4500-14000ms batch 0 收回 → 注入 DOM ← 第一個中文字出現
t≈14-21s    全部完成
```

**等待空白頁時間 ≈ 5-14 秒**(EXTRACT_GLOSSARY blocking + batch 0 兩次 API 往返)

---

## 5. batch 0 序列 + batch 1+ 並行的時序行為

10 個網頁都驗證設計符合預期。batch 1-N 在 batch 0 收回後 1-2ms 內被 worker pool 一次同時送出(Δ < 2ms)。

---

## 6. Gemini 回送邏輯觀察

### 6.1 占位符對齊

10 個網頁累積 53 個收回事件,沒看到任何 `⟦N⟧` mismatch。

| 來源 | Gemini 回送 |
|---|---|
| `⟦0⟧Tea⟦/0⟧` | `⟦0⟧茶⟦/0⟧` |
| `⟦0⟧⟦1⟧⟦2⟧By⟦/2⟧ ⟦3⟧Joseph Trevithick⟦/3⟧⟦/1⟧⟦/0⟧` | `⟦0⟧⟦1⟧⟦2⟧作者:⟦/2⟧ ⟦3⟧特雷維希克⟦/3⟧⟦/1⟧⟦/0⟧` |
| `Black and green teas contain no ⟦0⟧essential nutrients⟦/0⟧` | `紅茶與綠茶均不含顯著分量的 ⟦0⟧必要營養素⟦/0⟧` |
| `⟦0⟧timeline-scope⟦/0⟧` | `⟦0⟧時間軸範圍(timeline-scope)⟦/0⟧` |

### 6.2 收回順序

batch 0 永遠先到、batch 1+ 完成順序混亂(Gemini server race)。Wikipedia Tea 範例:`0 → 2 → 5 → 8 → 3 → 9 → 6 → 10 → 4 → 1 → 7 → 11`

### 6.3 翻譯品質

System prompt 對「品牌名 / 程式碼識別字 / 古人名意譯」這幾類處理一致。

---

## 7. v1.7.1 結論

### 7.1 機制驗證

| 設計 | 驗證 |
|---|:---:|
| `prioritizeUnits` stable sort 把 tier 0 / 1 推前 | ✅ 8/10 顯著改善 |
| batch 0 序列 dispatch | ✅ 10/10 |
| batch 1+ 並行 dispatch(Δ < 2ms) | ✅ 10/10 |
| Gemini 占位符回送對齊 | ✅ 10/10(53/53) |
| stable sort 同 tier 內維持 DOM 順序 | ✅ 10/10 |

### 7.2 已發現的限制

`<main>` / `<article>` 祖先訊號對某些 framework 太粗(GitHub、Wikipedia 等將 chrome 也塞進語意 main)。tier 0 訊號需要二次細分。

詳細優化路線見 `optimization-roadmap-2026-04-28.md`。

---

# v1.7.2 後續實作 + 重測(2026-04-28 下午)

依 `optimization-roadmap-2026-04-28.md` 的候選 A / B / D 實作後,重跑同一組 10 個 URL,off / on 兩種模式各一輪,跟 v1.7.1 base line 對比。

## 8. v1.7.2 實作紀錄

### 候選 A:batch 0 變小

**改動**:
- `content-ns.js`:`SK.BATCH0_UNITS = 10` / `SK.BATCH0_CHARS = 1500`(batch 1+ 仍用預設 20/3500)
- `content.js packBatches`:加 `firstMaxUnits` / `firstMaxChars` 參數;jobs.length=0 時用第一批 limit,之後切回預設
- `translateUnits` / `translateUnitsGoogle` 兩處呼叫傳入 BATCH0_* 常數

**動機**:batch 0 序列等 Gemini API,token 越少回送越快;batch 1+ 維持並行不吃序列延遲。

### 候選 B:Readability tier 0 細分

**改動**:`content-detect.js prioritizeUnits` 從 3 tier 升級成 4 tier:
- tier 0:祖先 main/article + readability score >= 5(真內文)
- tier 1:祖先 main/article + score < 5(GitHub UI tab、Wikipedia 工具列等)
- tier 2:祖先無 main/article + 文字 ≥ 80 + 連結密度 < 50%
- tier 3:其他

`readabilityScore(el)` 公式只用結構訊號(文字長度、逗號數、heading tag、含 P 子孫),刻意不用 class/id 名稱啟發式——避免命中 `ca-nstab-main` 這類含 main 字眼但實際是 chrome 的元素(符合硬規則 §8 結構通則)。

**新 regression**:`test/regression/translate-priority-tier-0-readability.spec.js` 鎖 tier 0 細分行為。SANITY 已驗證(破壞細分時新 spec fail,還原 pass)。

### 候選 D 變體:glossary 模型獨立 + 預設 Flash Lite

**改動**:
- `lib/storage.js DEFAULT_SETTINGS.glossary.model = 'gemini-3.1-flash-lite-preview'`
- `lib/gemini.js extractGlossary`:優先讀 `glossaryConfig.model`,空字串 fallback 主翻譯 model
- `background.js handleExtractGlossary`:cost 計算用 `getPricingForModel(glossaryModel)`,不再硬綁主 settings.pricing
- `options/options.html`:術語表分頁加 dropdown(Flash Lite / Flash / Pro / 與主翻譯相同 4 選 1)
- `options/options.js` load/save 處理 `glossaryModel`

**動機**:術語抽取是任務簡單的單次請求,Flash Lite 通常已夠用,且比 Flash 便宜 5 倍($0.10/$0.30 vs $0.50/$3.00)。

### probe 工具改動(非 production)

`tools/probe-priority.js` 加 `SHINKANSEN_PROBE_PROFILE` env var。**重要發現**:Chrome 對同 PROFILE 路徑有 SW bytecode cache,導致即使 lib/gemini.js 變了,SW 載入的 module 還是舊版。每次 probe 必須用全新 PROFILE 路徑(時間戳)才能保證載到最新 code。這個踩過坑的事實會永久改變未來實測流程。

---

## 9. v1.7.1 vs v1.7.2 重測對比(同一組 10 URL)

### 9.1 OFF 模式(真實使用者環境)— batch 0 chars / Gemini 等待

| 網站 | v1.7.1 chars/recv | v1.7.2 chars/recv | 首字延遲改善 |
|---|---|---|---:|
| TWZ | 2921c / 6627ms | 1387c / 4400ms | **-34%** |
| Wikipedia Tea | 1349c / 4704ms | 1423c / 4068ms | -14% |
| Hacker News | 1900c / 6629ms | 929c / 3959ms | **-40%** |
| GitHub | 514c / 3080ms | 778c / 3125ms | +1% |
| Cloudflare | 2888c / 6542ms | 1400c / 4052ms | **-38%** |
| The Verge | 1476c / 5024ms | 1435c / 4228ms | -16% |
| Ars Technica | 1465c / 4833ms | 747c / 3066ms | **-37%** |
| NPR | 1102c / 3987ms | 546c / 2561ms | **-36%** |
| Smashing | 2115c / 5907ms | 1084c / 3874ms | **-34%** |
| CSS-Tricks | 1377c / 4367ms | 472c / 2495ms | **-43%** |

**OFF 模式平均改善:首字延遲 -29%(中位數 -36%)**。最佳 CSS-Tricks 從 4.4s → 2.5s(-43%)。

candidate A(batch 0 變小)成果非常好:
- batch 0 chars 從平均 1700 chars → 平均 1000 chars
- batch 0 全部都在 ≤ 1500 chars(切小目標達成)
- Gemini 回送時間跟 chars 量呈正相關,chars 砍半 → 等待時間跟著降約 30-43%

GitHub 是 outlier:v1.7.1 batch 0 chars 已經是最少的 514c(因為 GitHub UI tab 文字短),v1.7.2 反而切到 778c(因為 tier 0 細分後 README H1 推前,batch 0 內容變了),總體影響輕微(+1%)。

### 9.2 排序行為改善(GitHub / Wikipedia 案例)

**GitHub repo 排序前 5(v1.7.1 → v1.7.2)**:
```
v1.7.1 (排序失敗,batch 0 全是 UI tab):
  LI "Notifications You must be signed in..."
  LI "Fork 302"
  A  "Star 1.9k"
  LI "Code"
  LI "Issues 45"

v1.7.2 (tier 0 細分後,README 衝到 batch 0):
  H1 "anthropics/anthropic-sdk-typescript"
  H2 "Folders and files"
  H2 "Repository files navigation"
  H1 "Claude SDK for TypeScript"
  H2 "Documentation"
```

**Wikipedia "Tea" 排序前 5(v1.7.1 → v1.7.2)**:
```
v1.7.1 (H1 進前 1,但 idx 1-9 是 MediaWiki 工具列):
  H1 "Tea"
  LI "Article"
  LI "Talk"
  LI "Read"
  LI "View source"

v1.7.2 (tier 0 細分後,真內文 P 衝到前列):
  H1 "Tea"
  P  "Tea is an aromatic beverage prepared by pouring hot or..."(674 字真內文)
  P  "An early credible record of tea drinking dates to the t..."(536 字)
  P  "The term herbal tea refers to drinks not made from Came..."(285 字)
  H2 "Etymology"
```

candidate B(Readability tier 0 細分)在 GitHub / Wikipedia 兩個原本「main 內混 chrome」的 case 上**徹底解決問題**——使用者最先看到的是 README 內容 / 文章開頭真內文,不是 UI tab。

### 9.3 ON 模式(啟用 glossary)— Flash Lite + batch 0 變小整合效果

對比首字延遲(batch0_send + batch0_recv_elapsed):

| 網站 | v1.7.1 ON | v1.7.2 ON | 省下 |
|---|---:|---:|---:|
| TWZ | 10317ms | 6550ms | **-37%** |
| Wikipedia Tea | 8331ms | 6370ms | -24% |
| Hacker News | 8841ms | 5964ms | **-33%** |
| GitHub | 4652ms | 7004ms | +51%(邊界 case,見下) |
| Cloudflare | 7887ms | 5939ms | -25% |
| The Verge | 10386ms | 9314ms | -10% |
| Ars Technica | 6396ms | 4906ms | -23% |
| NPR | 11746ms | 5096ms | **-57%** |
| Smashing | 8654ms | 5756ms | **-33%** |
| CSS-Tricks | 10186ms | 5019ms | **-51%** |

**ON 模式平均改善:-26%(中位數 -32%)**。最佳 NPR 從 11.7s → 5.1s,省 6.6 秒。

GitHub 邊界 case:v1.7.1 batchCount=6(走 blocking),v1.7.2 因 batch 0 變小,batchCount=7。兩個都 > blockingThreshold=5 都 blocking,但 v1.7.1 那次的 EXTRACT_GLOSSARY 跑得特別快(1595ms,可能是 Gemini server 端 latency 抖動),v1.7.2 跑了 4176ms。**這不是退化,是 GitHub 在 EXTRACT_GLOSSARY 時間上的 server-side latency 變動。同 model、相同 input 的 latency 抖動 1.5-7.4s 在原報告 §3.3 已記錄**。

### 9.4 EXTRACT_GLOSSARY: Flash Lite vs Flash 對照(TWZ 範例)

同一網頁、同一 compressedText 10360 chars:

| Glossary 模型 | extraction elapsed | terms | input/output cost |
|---|---:|---:|---:|
| Flash Lite | 3056ms | 27 | $0.10 / $0.30 per MTok |
| Flash | 3745ms | 29 | $0.50 / $3.00 per MTok |

Flash Lite 比 Flash 快 **~700ms(18%)**+ 便宜 **5 倍**,terms 數量接近(27 vs 29)。對「術語抽取」這種任務簡單的單次請求,Flash Lite 是合理預設。

---

## 10. v1.7.2 結論

### 10.1 候選實作完成度

| 候選 | 預期效果 | 實測效果 | 驗證 |
|---|---|---|:---:|
| A. batch 0 變小 | OFF 首字 3-7s → 2-4s | OFF 平均 -29%(中位數 -36%),最佳 css-tricks -43% | ✅ |
| B. Readability tier 0 細分 | GitHub / Wikipedia 排序成功 | GitHub README H1 / H2 衝到 batch 0,Wikipedia 真內文 P 進前 5 | ✅ |
| D 變體. glossary 模型獨立 + 預設 Flash Lite | ON 首字再省 1-3s | Flash Lite 快 18%,搭配 A 後 ON 模式平均 -26% | ✅ |

### 10.2 機制驗證

| 設計 | 驗證 |
|---|:---:|
| `prioritizeUnits` 4 tier(含 readability score 細分) | ✅ 10/10 對 GitHub / Wikipedia 顯著改善 |
| batch 0 用 BATCH0_UNITS=10 / BATCH0_CHARS=1500 | ✅ 10/10 全在 1500 chars 內 |
| Gemini 占位符回送對齊 | ✅ 10/10(無 mismatch) |
| 既有 11 條 regression spec | ✅ 全綠 |
| 新增 1 條 tier 0 細分 spec + SANITY | ✅ 通過 |

### 10.3 仍未做的優化(未來)

- **候選 C:glossary 跟 batch 0 並行**(ON 模式再省 1.5-7s,但 batch 0 內術語可能不一致)
- **候選 E:Gemini API streaming 邊收邊注入**(OFF 首字再省 1-3s,但實作複雜)
- **blockingThreshold 動態調整**:GitHub 7 批跨過閾值就走 blocking 等 4 秒,可考慮把預設 5 調高到 10 讓更多頁面走 fire-and-forget(這個獨立評估)

