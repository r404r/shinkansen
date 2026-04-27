// constants.js — lib/ 與 content script 共用的批次翻譯數值常數
//
// 注意：content-ns.js（content script 環境）因為不能用 ES module import，
// 以 SK.DEFAULT_UNITS_PER_BATCH / SK.DEFAULT_CHARS_PER_BATCH 鏡像這兩個值。
// 修改此檔時必須同步更新 content-ns.js 的對應常數。

/** 每批翻譯段數上限：避免單批 placeholder slot 過多導致 LLM 對齊失準（v1.5.8 起 12 → 20） */
export const DEFAULT_UNITS_PER_BATCH = 20;

/** 每批字元預算上限（3500 chars ≈ 1000 英文 tokens），留足 output headroom */
export const DEFAULT_CHARS_PER_BATCH = 3500;
