// Unit test: 中國用語黑名單 Debug 偵測層（v1.5.6 regression）
//
// 驗證 detectForbiddenTermLeaks 在譯文含黑名單詞時呼叫 logger.warn
// 並帶上正確的 category / message / data 結構。
//
// 純函式測試，不需要任何 mock chrome 或 fetch。
import { test, expect } from '@playwright/test';
import { detectForbiddenTermLeaks } from '../../shinkansen/lib/forbidden-terms.js';

const FORBIDDEN_SAMPLE = [
  { forbidden: '視頻', replacement: '影片', note: '' },
  { forbidden: '軟件', replacement: '軟體', note: '' },
  { forbidden: '數據', replacement: '資料', note: '' },
];

/** 建一個 spy 形 logger，記錄所有 warn 呼叫。 */
function makeSpyLogger() {
  const calls = [];
  return {
    calls,
    warn: (category, message, data) => {
      calls.push({ category, message, data });
    },
  };
}

test.describe('detectForbiddenTermLeaks', () => {
  test('譯文含「視頻」→ logger.warn 被呼叫且帶 forbidden=視頻 / replacement=影片', async () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['這是一個視頻網站，內容很豐富'],
      ['This is a video website with rich content'],
      FORBIDDEN_SAMPLE,
      logger,
    );

    expect(logger.calls.length).toBeGreaterThanOrEqual(1);
    const leakCall = logger.calls.find(c => c.category === 'forbidden-term-leak');
    expect(leakCall, '應有一筆 category=forbidden-term-leak 的 warn').toBeDefined();
    expect(leakCall.data.forbidden).toBe('視頻');
    expect(leakCall.data.replacement).toBe('影片');
    expect(leakCall.data.translationSnippet).toContain('視頻');
    expect(leakCall.data.sourceSnippet).toContain('video');
    expect(leakCall.message).toContain('視頻');
  });

  test('譯文同時含多個黑名單詞 → 每個都記一筆', async () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['這個軟件處理大量數據'],
      ['This software processes lots of data'],
      FORBIDDEN_SAMPLE,
      logger,
    );

    const leaks = logger.calls.filter(c => c.category === 'forbidden-term-leak');
    expect(leaks.length).toBe(2);
    const forbiddenWords = leaks.map(c => c.data.forbidden).sort();
    expect(forbiddenWords).toEqual(['數據', '軟件']);
  });

  test('譯文乾淨（全用台灣慣用語）→ logger.warn 不被呼叫', async () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['這個軟體處理大量資料，是個影片網站'],
      ['This software processes lots of data, is a video website'],
      FORBIDDEN_SAMPLE,
      logger,
    );
    const leaks = logger.calls.filter(c => c.category === 'forbidden-term-leak');
    expect(leaks.length).toBe(0);
  });

  test('forbiddenTerms 空陣列 → 不掃描，不呼叫 logger', async () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['含視頻軟件數據的譯文'],
      ['source'],
      [],
      logger,
    );
    expect(logger.calls.length).toBe(0);
  });

  test('譯文陣列有空值 → 略過該段不噴錯', async () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['含視頻', '', null, '含軟件'],
      ['a', 'b', 'c', 'd'],
      FORBIDDEN_SAMPLE,
      logger,
    );
    const leaks = logger.calls.filter(c => c.category === 'forbidden-term-leak');
    expect(leaks.length).toBe(2);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/forbidden-terms.js 內的 `if (tr.indexOf(t.forbidden) !== -1)` 條件改成
//   `if (false)` → 第一條與第二條測試 fail（leakCall undefined / leaks.length=0）。
//   還原後全部 pass。
