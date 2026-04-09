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

### v0.77/v0.78 — 2026-04-09 — Gemini 忽略分隔符導致 segment mismatch fallback
- **症狀**：翻譯某些頁面時，某批次的 Gemini 回應只有 1 段而非預期的 14 段（`SEGMENT MISMATCH: expected 14 segments, got 1`），觸發逐段 fallback（14 次依序 API 呼叫），造成該批次極慢
- **來源 URL**：https://www.culpium.com/p/introducing-the-worlds-most-powerful
- **修在**：`shinkansen/lib/gemini.js` 的 `translateChunk()`：(1) v0.77 加入 `thinkingConfig: { thinkingBudget: 0 }` 關閉思考功能（降低回應時間但未解決段數問題）；(2) v0.78 多段翻譯時動態追加明確分隔符規則到 effectiveSystem，告訴模型確切的 `<<<SHINKANSEN_SEP>>>` 分隔符和預期段數
- **為什麼還不能寫測試**：
    此 bug 的觸發條件是 Gemini 對特定內容忽略分隔符。本地 fixture + canned response 無法模擬「API 回傳段數不符」的情境（canned response 的段數是寫死的）。要寫有意義的 regression test 需要 mock fetch 層——這超出目前 regression test 架構的範圍。
- **建議 spec 位置**：`test/regression/mismatch-fallback.spec.js`（若未來架構支援 mock API 層）
- **觀察重點**：v0.78 修復後應該不再出現 segment mismatch。若仍出現，考慮改用 numbered format 取代 delimiter

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
