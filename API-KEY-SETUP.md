[English](API-KEY-SETUP.en.md) | **繁體中文**

# Shinkansen — Google Gemini API Key 申請指南

> 本指引帶你申請 Gemini API Key，供 Shinkansen 呼叫 Google Gemini 翻譯網頁
> ，一般情況下 3 分鐘可完成

### 步驟 1：登入 Google AI Studio

1. 開啟 [Google AI Studio](https://aistudio.google.com/),用你的 Google 帳號登入
2. 第一次登入會要求同意服務條款,勾選後按「Continue」

### 步驟 2:建立 API Key

進入 [API keys 管理頁面](https://aistudio.google.com/api-keys)

1. 點頁面**右上角**的「**Create API key**」
2. 為這把 Key 命名（例如 `Shinkansen`，只是給你自己辨識用）
3. 「Choose an imported project」這欄選擇要關聯的 Google Cloud 專案
   - 可用預設的 **General Gemini Apps**
   - 或選「**Create new project**」，建立您的專案用途以供辨識，例如 `ShinkansenTranslation`
4. 點「**Create key**」

API Key 會立刻顯示，格式像 `AIzaSy...`（約 39 個字元）

> **小提醒**：Key 建立後可以隨時回到 API keys 管理頁面，點該 Key 的名稱 copy 完整字串，不必擔心一次沒複製到。但仍建議馬上複製到密碼管理員或安全的地方備份

### 步驟 3：在 Shinkansen 中設定 API Key

1. 在 Chrome 按 Shinkansen 工具列圖示 → 設定
2. 在「**Gemini API Key**」欄位貼上你剛才複製的 Key
3. 點「儲存」，按「測試」看是否開通成功
4. 開任何英文網頁，按 Option+S（Mac）或 Alt+S（Windows）測試翻譯

### 步驟 4：綁信用卡

Free tier 有 **RPD**（每日請求上限）、**RPM**（每分鐘請求上限）、**TPM**（每分鐘 token 上限）等限制。

1. 開 [Google AI Studio](https://aistudio.google.com/)
2. 點左側選單「**Billing**」
3. 點「**Set up billing**」
4. 填寫付款資訊（姓名、地址、信用卡）
5. 提交後 AI Studio 會自動把你的專案升到 Tier 1，RPD / RPM 上限放寬，可使用 Pro 等進階模型

**月度花費上限**：Tier 1 帳戶 Google 強制設每月 250 美元上限，這是保護機制，避免意外天價帳單。

*本文件最後更新:2026 年 4 月 30 日*
