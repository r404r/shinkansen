// Unit test: i18n t() 函式（v1.5 Nozomi 新增）
//
// 驗證 t(key, ...args) 的翻譯查找、佔位符替換、語言切換、fallback 行為。
// 純函式測試，不需要 mock chrome 或 fetch。
import { test, expect } from '@playwright/test';
import { t, setLocale, getLocale, STRINGS } from '../../shinkansen/lib/i18n.js';

test.describe('i18n t() function', () => {
  test.afterEach(() => {
    setLocale('zh-TW'); // 每個測試後重置
  });

  test('預設語言為 zh-TW', () => {
    expect(getLocale()).toBe('zh-TW');
  });

  test('基本翻譯——zh-TW key 回傳正確文字', () => {
    expect(t('popup_translate')).toBe('翻譯本頁');
    expect(t('popup_settings')).toBe('設定');
  });

  test('切換到 zh-CN 後回傳簡體中文', () => {
    setLocale('zh-CN');
    expect(getLocale()).toBe('zh-CN');
    expect(t('popup_translate')).toBe('翻译本页');
    expect(t('popup_settings')).toBe('设置');
  });

  test('切換到 ja 後回傳日語', () => {
    setLocale('ja');
    expect(getLocale()).toBe('ja');
    expect(t('popup_translate')).toBe('このページを翻訳');
    expect(t('popup_settings')).toBe('設定');
  });

  test('佔位符替換——{0}, {1} 被替換為參數', () => {
    expect(t('popup_cost_total', '$1.23', '45.6K')).toBe('累計：$1.23 / 45.6K tokens');
    setLocale('ja');
    expect(t('popup_cost_total', '$0.50', '10K')).toBe('累計：$0.50 / 10K tokens');
  });

  test('不存在的 key——fallback 回傳 key 名', () => {
    expect(t('nonexistent_key_xyz')).toBe('nonexistent_key_xyz');
  });

  test('zh-CN 缺少的 key——fallback 到 zh-TW', () => {
    setLocale('zh-CN');
    // 假設有一個 key 只存在於 zh-TW（理論上不應該，但測 fallback 機制）
    const zhTWOnly = '_test_only_zhtw';
    STRINGS['zh-TW'][zhTWOnly] = '僅繁中';
    expect(t(zhTWOnly)).toBe('僅繁中');
    delete STRINGS['zh-TW'][zhTWOnly]; // 清理
  });

  test('無效語言代碼——setLocale 忽略', () => {
    setLocale('xx-XX');
    expect(getLocale()).toBe('zh-TW'); // 不變
  });

  test('三語字串表 key 數量一致', () => {
    const zhTWCount = Object.keys(STRINGS['zh-TW']).length;
    const zhCNCount = Object.keys(STRINGS['zh-CN']).length;
    const jaCount = Object.keys(STRINGS['ja']).length;
    // 允許少量差異（某些 key 可能只在一種語言存在），但大致一致
    expect(Math.abs(zhTWCount - zhCNCount)).toBeLessThan(5);
    expect(Math.abs(zhTWCount - jaCount)).toBeLessThan(5);
  });
});
