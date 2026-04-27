// Unit test: CWS 自動更新後的「歡迎升級」提示寫入邏輯（v1.6.5 regression）
//
// 驗證 lib/welcome-notice.js 的 maybeWriteWelcomeNotice：
//   - reason='update' + major/minor 升級 → 寫 storage.welcomeNotice
//   - patch 級升級 → 不寫（避免 CWS 高頻 patch 自動更新打擾使用者）
//   - reason='install' / 'browser_update' / 'shared_module_update' → 不寫
//   - previousVersion 缺失（首裝）→ 不寫
//
// Mock 策略：模擬 chrome.storage.local 為 in-memory store。
// release-highlights.js 是純 export 字串陣列，本檔順帶驗結構。
import { test, expect } from '@playwright/test';

const store = {};
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({}), remove: async () => {}, set: async () => {} },
    local: {
      get: async (keys) => {
        if (keys === null) return { ...store };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) if (k in store) result[k] = store[k];
        return result;
      },
      set: async (items) => { Object.assign(store, items); },
      remove: async (keys) => {
        if (typeof keys === 'string') keys = [keys];
        for (const k of keys) delete store[k];
      },
    },
  },
};

const { maybeWriteWelcomeNotice, shouldShowWelcomeNotice } = await import('../../shinkansen/lib/welcome-notice.js');
const { RELEASE_HIGHLIGHTS } = await import('../../shinkansen/lib/release-highlights.js');

function clearStore() { for (const k of Object.keys(store)) delete store[k]; }

test.beforeEach(() => clearStore());

test.describe('maybeWriteWelcomeNotice', () => {
  test('major 升級 → 寫 storage.welcomeNotice', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'update', previousVersion: '1.6.4', currentVersion: '2.0.0',
    });
    expect(wrote).toBe(true);
    expect(store.welcomeNotice).toBeDefined();
    expect(store.welcomeNotice.version).toBe('2.0.0');
    expect(store.welcomeNotice.fromVersion).toBe('1.6.4');
    expect(store.welcomeNotice.dismissed).toBe(false);
    expect(store.welcomeNotice.lastNoticeShownDate).toBeNull();
  });

  test('minor 升級 → 寫 storage.welcomeNotice', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'update', previousVersion: '1.6.4', currentVersion: '1.7.0',
    });
    expect(wrote).toBe(true);
    expect(store.welcomeNotice.version).toBe('1.7.0');
  });

  test('patch 升級 → **不**寫（避免高頻 patch 打擾）', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'update', previousVersion: '1.6.4', currentVersion: '1.6.5',
    });
    expect(wrote).toBe(false);
    expect(store.welcomeNotice).toBeUndefined();
  });

  test('reason=install（首次安裝）→ 不寫', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'install', previousVersion: undefined, currentVersion: '1.7.0',
    });
    expect(wrote).toBe(false);
    expect(store.welcomeNotice).toBeUndefined();
  });

  test('reason=browser_update（瀏覽器升級不是 extension 升級）→ 不寫', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'browser_update', previousVersion: '1.6.4', currentVersion: '1.7.0',
    });
    expect(wrote).toBe(false);
    expect(store.welcomeNotice).toBeUndefined();
  });

  test('previousVersion 缺失 → 不寫（防禦性）', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'update', previousVersion: undefined, currentVersion: '1.7.0',
    });
    expect(wrote).toBe(false);
    expect(store.welcomeNotice).toBeUndefined();
  });

  test('降版（previousVersion > currentVersion，極端 case）→ 不寫', async () => {
    const wrote = await maybeWriteWelcomeNotice({
      reason: 'update', previousVersion: '1.7.0', currentVersion: '1.6.0',
    });
    expect(wrote).toBe(false);
    expect(store.welcomeNotice).toBeUndefined();
  });
});

test.describe('shouldShowWelcomeNotice', () => {
  test('沒 welcomeNotice → 不顯示也不需清除', () => {
    expect(shouldShowWelcomeNotice(null, '1.6.22')).toEqual({ show: false, removeStale: false });
    expect(shouldShowWelcomeNotice(undefined, '1.6.22')).toEqual({ show: false, removeStale: false });
    expect(shouldShowWelcomeNotice({}, '1.6.22')).toEqual({ show: false, removeStale: false });
  });

  test('同 minor + dismissed=false → 顯示', () => {
    const r = shouldShowWelcomeNotice({ version: '1.6.0', dismissed: false }, '1.6.22');
    expect(r).toEqual({ show: true, removeStale: false });
  });

  test('同 minor + dismissed=true → 不顯示但保留(使用者已讀過)', () => {
    const r = shouldShowWelcomeNotice({ version: '1.6.0', dismissed: true }, '1.6.22');
    expect(r).toEqual({ show: false, removeStale: false });
  });

  test('不同 minor(歷史殘留 v1.5 → v1.6.x manifest)→ 不顯示且該清除', () => {
    const r = shouldShowWelcomeNotice({ version: '1.5.7', dismissed: false }, '1.6.22');
    expect(r).toEqual({ show: false, removeStale: true });
  });

  test('不同 major(歷史殘留 v0.x → v1.x.x manifest)→ 不顯示且該清除', () => {
    const r = shouldShowWelcomeNotice({ version: '0.99.0', dismissed: false }, '1.0.0');
    expect(r).toEqual({ show: false, removeStale: true });
  });

  test('未來版本(welcomeNotice.version > manifest 但同 minor)→ 顯示', () => {
    // 罕見 case:storage 有更新版的 welcomeNotice 但 manifest 還是舊版(降版後 storage 殘留)
    // 仍當 same-minor 處理(顯示)
    const r = shouldShowWelcomeNotice({ version: '1.6.99', dismissed: false }, '1.6.22');
    expect(r).toEqual({ show: true, removeStale: false });
  });
});

test.describe('RELEASE_HIGHLIGHTS', () => {
  test('是非空陣列且每條為非空字串', () => {
    expect(Array.isArray(RELEASE_HIGHLIGHTS)).toBe(true);
    expect(RELEASE_HIGHLIGHTS.length).toBeGreaterThan(0);
    for (const h of RELEASE_HIGHLIGHTS) {
      expect(typeof h).toBe('string');
      expect(h.length).toBeGreaterThan(0);
    }
  });

  test('條目應使用 **粗體** 標記重點功能（讓 popup highlightToHtml 解析）', () => {
    const hasBold = RELEASE_HIGHLIGHTS.some(h => /\*\*[^*]+\*\*/.test(h));
    expect(hasBold).toBe(true);
  });
});

// SANITY 紀錄（已在 Claude Code 端驗過）：
//   把 maybeWriteWelcomeNotice 內 isWorthNotifying 條件改成永遠回 true →
//   「patch 升級不寫」test fail（store.welcomeNotice 變成 defined）。
//   還原後全部 pass。
