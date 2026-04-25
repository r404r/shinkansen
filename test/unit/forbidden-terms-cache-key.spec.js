// Unit test: cache.js 的 forbiddenHash 後綴（v1.5.6 regression）
//
// 驗證 getBatch / setBatch 的「結構化 keySuffix」物件 API：
//   { glossaryHash, forbiddenHash, baseSuffix } → 內部組成 _g<gh>_b<bh> suffix
// 同一段原文有/無 forbiddenHash 應分開快取，使用者修改黑名單後既有快取自動失效。
//
// 也驗證 hashForbiddenTerms 的穩定性（順序不影響、空清單回空字串）。
import { test, expect } from '@playwright/test';

// ── Mock chrome.storage.local（in-memory）──
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (keys === null) return { ...store };
        if (typeof keys === 'string') keys = [keys];
        const result = {};
        for (const k of keys) {
          if (k in store) result[k] = store[k];
        }
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

const { getBatch, setBatch, hashForbiddenTerms } = await import('../../shinkansen/lib/cache.js');

function clearStore() {
  for (const k of Object.keys(store)) delete store[k];
}

test.beforeEach(() => { clearStore(); });

test.describe('cache forbiddenHash 後綴', () => {
  test('同段原文：帶 forbiddenHash 與不帶 → cache miss（key 不同）', async () => {
    await setBatch(['hello'], ['你好（含黑名單）'], { forbiddenHash: 'abc123def456' });

    // 不帶 suffix（既有 v1.5.5 之前的呼叫）→ miss
    const noSuffix = await getBatch(['hello']);
    expect(noSuffix[0]).toBeNull();

    // 帶不同 forbiddenHash → miss
    const diffHash = await getBatch(['hello'], { forbiddenHash: 'xxxxxx111111' });
    expect(diffHash[0]).toBeNull();

    // 帶相同 forbiddenHash → hit
    const sameHash = await getBatch(['hello'], { forbiddenHash: 'abc123def456' });
    expect(sameHash[0]).toBe('你好（含黑名單）');
  });

  test('storage key 中有 _b<hash> 後綴', async () => {
    await setBatch(['hello'], ['你好'], { forbiddenHash: 'abc123def456' });
    const allKeys = Object.keys(store);
    expect(allKeys.length).toBe(1);
    expect(allKeys[0]).toContain('_babc123def456');
  });

  test('空 forbiddenHash → 不附加後綴（向下相容既有 tc_<sha1> 快取）', async () => {
    await setBatch(['hello'], ['你好'], { forbiddenHash: '' });
    const allKeys = Object.keys(store);
    expect(allKeys.length).toBe(1);
    expect(allKeys[0]).not.toContain('_b');
    // 不帶 suffix 也能命中
    const result = await getBatch(['hello']);
    expect(result[0]).toBe('你好');
  });

  test('glossaryHash + forbiddenHash 合併成 _g<gh>_b<bh>', async () => {
    await setBatch(['hello'], ['你好'], {
      glossaryHash: 'gloss1234567',
      forbiddenHash: 'abc123def456',
    });
    const allKeys = Object.keys(store);
    expect(allKeys.length).toBe(1);
    // glossary 後綴在前、forbidden 後綴在後
    const gPos = allKeys[0].indexOf('_ggloss1234567');
    const bPos = allKeys[0].indexOf('_babc123def456');
    expect(gPos).toBeGreaterThan(-1);
    expect(bPos).toBeGreaterThan(-1);
    expect(bPos).toBeGreaterThan(gPos);
  });

  test('hashForbiddenTerms：相同清單不同順序 → 相同 hash', async () => {
    const a = await hashForbiddenTerms([
      { forbidden: '視頻', replacement: '影片' },
      { forbidden: '軟件', replacement: '軟體' },
    ]);
    const b = await hashForbiddenTerms([
      { forbidden: '軟件', replacement: '軟體' },
      { forbidden: '視頻', replacement: '影片' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  test('hashForbiddenTerms：空清單 → 空字串（避免無謂的後綴）', async () => {
    expect(await hashForbiddenTerms([])).toBe('');
    expect(await hashForbiddenTerms(null)).toBe('');
    expect(await hashForbiddenTerms(undefined)).toBe('');
  });

  test('hashForbiddenTerms：替換詞不同 → hash 不同', async () => {
    const a = await hashForbiddenTerms([{ forbidden: '視頻', replacement: '影片' }]);
    const b = await hashForbiddenTerms([{ forbidden: '視頻', replacement: '視訊' }]);
    expect(a).not.toBe(b);
  });

  test('既有字串 keySuffix API 仍可用（向下相容 v1.5.5 之前的呼叫端）', async () => {
    await setBatch(['hello'], ['你好'], '_g1234');
    const result = await getBatch(['hello'], '_g1234');
    expect(result[0]).toBe('你好');
  });
});

// SANITY 紀錄（已在 Claude Code 端驗證）：
//   把 lib/cache.js resolveKeySuffix 中
//     `if (arg.forbiddenHash) s += '_b' + arg.forbiddenHash;`
//   這行註解掉 → test #1（diffHash/sameHash 都變 null）/ #2（storage key 缺 _b）
//   / #4（bPos === -1）三條都 fail。還原後全部 pass。
