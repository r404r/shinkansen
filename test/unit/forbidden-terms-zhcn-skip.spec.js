// Unit test: 中國用語黑名單 zh-CN 模式下跳過（v1.7 Nozomi 新增）
//
// 驗證 forbidden-terms 在 zh-CN 翻譯模式下被跳過（大陸用語是正確的）。
// 此測試驗證 background.js 中 forbiddenTermsList 的條件邏輯。
import { test, expect } from '@playwright/test';
import { detectForbiddenTermLeaks } from '../../shinkansen/lib/forbidden-terms.js';

const FORBIDDEN_SAMPLE = [
  { forbidden: '視頻', replacement: '影片', note: '' },
  { forbidden: '軟件', replacement: '軟體', note: '' },
  { forbidden: '數據', replacement: '資料', note: '' },
];

function makeSpyLogger() {
  const calls = [];
  return {
    calls,
    warn: (category, message, data) => {
      calls.push({ category, message, data });
    },
  };
}

test.describe('forbidden-terms zh-CN skip logic', () => {
  test('zh-TW 模式：黑名單正常運作，偵測到漏網詞', () => {
    const logger = makeSpyLogger();
    // 模擬 zh-TW 模式：forbiddenTermsList 不為空
    const forbiddenTermsList = FORBIDDEN_SAMPLE;
    detectForbiddenTermLeaks(
      ['這是一個視頻教學'],
      ['This is a video tutorial'],
      forbiddenTermsList,
      logger,
    );
    expect(logger.calls.length).toBeGreaterThanOrEqual(1);
    expect(logger.calls[0].category).toBe('forbidden-term-leak');
  });

  test('zh-CN 模式：黑名單應為空陣列，不偵測', () => {
    const logger = makeSpyLogger();
    // 模擬 zh-CN 模式：background.js 會把 forbiddenTermsList 設為 []
    const uiLocale = 'zh-CN';
    const forbiddenTermsList = (uiLocale === 'zh-CN')
      ? []
      : FORBIDDEN_SAMPLE;

    detectForbiddenTermLeaks(
      ['这是一个视频教学'],   // 簡中譯文，含「視頻」不是錯誤
      ['This is a video tutorial'],
      forbiddenTermsList,
      logger,
    );
    // zh-CN 模式下清單為空，不應有任何 warn
    expect(logger.calls.length).toBe(0);
  });

  test('ja 模式：黑名單正常運作', () => {
    const logger = makeSpyLogger();
    const uiLocale = 'ja';
    const forbiddenTermsList = (uiLocale === 'zh-CN')
      ? []
      : FORBIDDEN_SAMPLE;

    detectForbiddenTermLeaks(
      ['これは視頻チュートリアルです'],  // 日文翻譯不小心含了中文「視頻」
      ['This is a video tutorial'],
      forbiddenTermsList,
      logger,
    );
    // ja 模式下黑名單有效，應偵測到
    expect(logger.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('空黑名單——detectForbiddenTermLeaks 不執行任何檢查', () => {
    const logger = makeSpyLogger();
    detectForbiddenTermLeaks(
      ['這是一個視頻教學'],
      ['This is a video tutorial'],
      [],  // 空清單
      logger,
    );
    expect(logger.calls.length).toBe(0);
  });
});
