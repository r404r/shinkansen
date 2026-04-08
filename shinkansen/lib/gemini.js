// gemini.js — Google Gemini REST API 封裝
// 支援批次翻譯、Service Tier (Flex/Standard/Priority)、除錯 Log。

import { debugLog } from './logger.js';

const DELIMITER = '\n<<<SHINKANSEN_SEP>>>\n';
const CHUNK_SIZE = 20; // 每批最多送幾段（content.js 已經會分批，這裡只是雙重保險）

/**
 * 批次翻譯文字陣列（會自動切成多批送出）。
 * @param {string[]} texts 原文陣列
 * @param {object} settings 完整設定
 * @returns {Promise<{ translations: string[], usage: { inputTokens: number, outputTokens: number } }>}
 */
export async function translateBatch(texts, settings) {
  if (!texts?.length) return { translations: [], usage: { inputTokens: 0, outputTokens: 0 } };
  const out = new Array(texts.length);
  const usage = { inputTokens: 0, outputTokens: 0 };
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const slice = texts.slice(i, i + CHUNK_SIZE);
    const { parts, usage: u } = await translateChunk(slice, settings);
    for (let j = 0; j < parts.length; j++) out[i + j] = parts[j];
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
  }
  return { translations: out, usage };
}

async function translateChunk(texts, settings) {
  if (!texts?.length) return [];
  const { apiKey, geminiConfig } = settings;
  const {
    model,
    serviceTier,
    temperature,
    topP,
    topK,
    maxOutputTokens,
    systemInstruction,
  } = geminiConfig;

  // 將多段以分隔符合併，單次請求省費用
  const joined = texts.join(DELIMITER);

  // 若本批文字含 ⟦…⟧ 佔位符（content.js 為了保留連結 / 樣式而注入的）,
  // 在 systemInstruction 後面追加一條規則，要求 LLM 原樣保留這些標記。
  let effectiveSystem = systemInstruction;
  if (joined.indexOf('\u27E6') !== -1) {
    effectiveSystem = systemInstruction + '\n\n額外規則（極重要，處理佔位符標記）:\n輸入中可能含有兩種佔位符標記，都是用來保留原文結構，必須原樣保留、不可翻譯、不可省略、不可改寫、不可新增、不可重排。佔位符裡的數字、斜線、星號 **必須是半形 ASCII 字元**（0-9、/、*），絕對不可改成全形（０-９、／、＊），否則程式無法配對會整段崩壞。\n\n（A）配對型 ⟦數字⟧…⟦/數字⟧（例如 ⟦0⟧Tokugawa Ieyasu⟦/0⟧)：\n- 把標記視為透明外殼。外殼「內部」的文字跟外殼「外部」的文字一樣，全部都要翻譯成繁體中文。\n- ⟦數字⟧ 與 ⟦/數字⟧ 兩個標記本身原樣保留，數字不變。\n- **配對型可以巢狀嵌套**（例如 ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ...⟦/0⟧）。巢狀代表原文是 `<b>text <a>link</a> more text</b>` 這類嵌套結構。翻譯時必須**同時**保留外層與內層兩組標記、不可扁平化成單層、不可交換順序、不可遺漏任何一層。外層與內層的內部文字全部要翻成繁體中文。\n\n（B）自閉合 ⟦*數字⟧（例如 ⟦*5⟧)：\n- 這是「原子保留」位置記號，代表原文裡有一段不可翻譯的小區塊（例如維基百科腳註參照 [2])。\n- 整個 ⟦*數字⟧ token 原樣保留，不可拆開、不可翻譯、不可省略，數字不變。\n- 它的位置代表那段內容應該插在譯文的哪裡。\n\n具體範例 1（單層）：\n輸入： ⟦0⟧Tokugawa Ieyasu⟦/0⟧ won the ⟦1⟧Battle of Sekigahara⟦/1⟧ in 1600.⟦*2⟧\n正確輸出： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。⟦*2⟧\n錯誤輸出 1： ⟦0⟧Tokugawa Ieyasu⟦/0⟧於 1600 年贏得⟦1⟧Battle of Sekigahara⟦/1⟧。⟦*2⟧（配對型內部英文沒翻）\n錯誤輸出 2： ⟦0⟧德川家康⟦/0⟧於 1600 年贏得⟦1⟧關原之戰⟦/1⟧。[2]（自閉合 ⟦*2⟧ 被擅自還原成 [2])\n\n具體範例 2（巢狀）：\n輸入： This article ⟦0⟧may incorporate text from a ⟦1⟧large language model⟦/1⟧, which is ⟦2⟧prohibited in Wikipedia articles⟦/2⟧⟦/0⟧.\n正確輸出： 本條目⟦0⟧可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧⟦/0⟧。\n錯誤輸出 3： 本條目可能包含來自⟦1⟧大型語言模型⟦/1⟧的文字，這在⟦2⟧維基百科條目中是被禁止的⟦/2⟧。（外層 ⟦0⟧…⟦/0⟧ 被扁平化丟掉）';
  }

  const body = {
    contents: [{ role: 'user', parts: [{ text: joined }] }],
    systemInstruction: { parts: [{ text: effectiveSystem }] },
    generationConfig: {
      temperature,
      topP,
      topK,
      maxOutputTokens,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    ],
  };

  // 只有在使用者明確選擇 FLEX/STANDARD/PRIORITY 時才送 serviceTier。
  // 若為 'DEFAULT' 或空值則完全不送此欄位，避免舊模型拒絕。
  if (serviceTier && serviceTier !== 'DEFAULT') {
    body.serviceTier = serviceTier; // 短形式：FLEX / STANDARD / PRIORITY
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  await debugLog('info', 'gemini request', { model, serviceTier, segments: texts.length });

  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    await debugLog('error', 'gemini fetch failed', { error: err.message });
    throw new Error('網路錯誤：' + err.message);
  }

  const json = await resp.json();
  const ms = Date.now() - t0;

  if (!resp.ok) {
    await debugLog('error', 'gemini error', { status: resp.status, json, ms });
    const msg = json?.error?.message || `HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const meta = json?.usageMetadata || {};
  const chunkUsage = {
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: meta.candidatesTokenCount || 0,
  };
  await debugLog('info', 'gemini response', {
    ms,
    usage: meta,
    preview: text.slice(0, 200),
  });

  const parts = text.split(DELIMITER).map(s => s.trim());
  // 若回傳段數不符，且本批不只一段，則 fallback 改為逐段單獨翻譯，確保對齊
  if (parts.length !== texts.length) {
    await debugLog('warn', 'segment count mismatch — fallback to per-segment', {
      expected: texts.length, got: parts.length,
    });
    if (texts.length === 1) {
      // 單段模式：直接回傳整個 text(LLM 可能多吐了分隔符）
      return { parts: [text.trim()], usage: chunkUsage };
    }
    // 逐段 fallback：每段都會真的再打一次 API，需累加 usage
    // 注意：此時原本這一批的 chunkUsage 已經付過錢了，但結果沒法對齊要丟掉，
    // 所以還是要算進總成本裡。
    const aligned = [];
    const aggUsage = { ...chunkUsage };
    for (const seg of texts) {
      const r = await translateChunk([seg], settings);
      aligned.push(r.parts[0] || '');
      aggUsage.inputTokens += r.usage.inputTokens;
      aggUsage.outputTokens += r.usage.outputTokens;
    }
    return { parts: aligned, usage: aggUsage };
  }
  return { parts, usage: chunkUsage };
}
