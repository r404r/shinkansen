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

### v0.85 — 2026-04-09 — chrome.storage 配額滿 LRU 淘汰
- **功能描述**：快取值改為 `{ v, t }` LRU 結構，配額滿時依時間戳淘汰最舊條目
- **來源 URL**：N/A（防禦性程式，長期使用後快取累積觸發）
- **修在**：shinkansen/lib/cache.js 的 `safeStorageSet`、`evictOldest`、`proactiveEvictionCheck`
- **為什麼還不能寫測試**：
    需要 mock `chrome.storage.local` API（模擬 set() 拋出 QUOTA_BYTES 錯誤），
    目前 regression suite 跑在 Playwright + real extension 環境，
    沒有 storage mock 機制。需要另建 unit test harness（例如用 Jest +
    chrome mock）或在 Playwright 裡用 CDP 注入假 storage 行為。
- **建議 spec 位置**：test/regression/cache-lru-eviction.spec.js
- **建議測試場景**：
    1. setBatch 成功時值為 { v, t } 結構
    2. getBatch 讀到舊格式（純字串）正常回傳
    3. getBatch 命中時更新時間戳
    4. safeStorageSet 遇 QUOTA_BYTES 錯誤 → 觸發 evictOldest → 重試成功
    5. evictOldest 按時間戳升序淘汰（t=0 的舊格式最先被淘汰）
    6. proactiveEvictionCheck 超過 90% 閾值觸發淘汰

### v0.84 — 2026-04-09 — API 回應非 JSON / 格式異常防護
- **功能描述**：translateChunk 的 resp.json() try-catch、candidates 結構驗證（空 candidates / blockReason / finishReason 異常）、fetchWithRetry 5xx 重試
- **來源 URL**：N/A（防禦性程式，非特定網站觸發）
- **修在**：shinkansen/lib/gemini.js 的 `translateChunk` 與 `fetchWithRetry`
- **為什麼還不能寫測試**：
    需要 mock fetch / HTTP 層才能模擬非 JSON 回應、空 candidates、5xx 錯誤。
    目前 regression suite 是走 canned response 的 inject 路徑測試，
    不涉及 HTTP 層。需要另建 API-mock harness（例如用 MSW 或
    custom fetch stub），等 Claude Code 端設計。
- **建議 spec 位置**：test/regression/api-error-handling.spec.js
- **建議測試場景**：
    1. resp.json() 拋 SyntaxError → 拋出包含 HTTP 狀態碼的可讀錯誤
    2. candidates 為空 + blockReason=SAFETY → 拋出安全過濾器錯誤
    3. finishReason=SAFETY + text 為空 → 拋出安全過濾器錯誤
    4. finishReason=MAX_TOKENS + text 為空 → 拋出 maxOutputTokens 錯誤
    5. HTTP 500 → 重試最多 maxRetries 次後拋錯
    6. HTTP 500 + 第二次正常 → 回傳正常結果

### v0.82 — 2026-04-09 — SPA 動態載入內容支援
- **功能描述**：SPA 導航偵測（pushState/replaceState/popstate）+ 翻譯後 MutationObserver
- **來源 URL**：Twitter/X（SPA 導航）、任何 lazy-load 內容的頁面
- **修在**：shinkansen/content.js 的 `handleSpaNavigation`、`resetForSpaNavigation`、`startSpaObserver`、`spaObserverRescan`
- **為什麼還不能寫測試**：
    SPA 導航偵測需要真正的 pushState 環境（靜態 fixture 做不到），
    MutationObserver 需要模擬動態新增 DOM 節點。需要一個可以
    programmatically 觸發 pushState 並在 callback 後新增 DOM 的測試頁面，
    且需要 mock chrome.storage.sync 的 domainRules。等切到 Claude Code 端
    再設計適當的 test harness。
- **建議 spec 位置**：test/regression/spa-navigation.spec.js
- **建議測試場景**：
    1. pushState 後 STATE 被重置（translated = false, originalHTML 清空）
    2. MutationObserver 偵測到新增段落後觸發 rescan
    3. MutationObserver 達到 MAX_RESCANS 後自動停止
    4. restorePage 後 Observer 被 disconnect

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
