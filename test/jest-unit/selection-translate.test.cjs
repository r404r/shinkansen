'use strict';

/**
 * 選區翻譯 filterUnitsBySelection 單元測試（v1.6 Nozomi 新增）
 *
 * 驗證：
 *   1. 無選區時回傳 null（全頁翻譯）
 *   2. 有選區時只保留與選區交集的 unit
 *   3. element unit 與 fragment unit 均正確過濾
 *   4. 選區不含任何 unit 時回傳 null
 */

const { createEnv } = require('./helpers/create-env.cjs');

describe('v1.6: filterUnitsBySelection (選區翻譯)', () => {
  let env;

  afterEach(() => {
    if (env) { env.cleanup(); env = null; }
  });

  test('無選區（isCollapsed=true）→ filterUnitsBySelection 回傳 null', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html><head></head><body>
        <p id="p1">Hello world</p>
        <p id="p2">Another paragraph</p>
      </body></html>`,
    });

    const SK = env.window.__SK;
    const units = [
      { kind: 'element', el: env.document.getElementById('p1') },
      { kind: 'element', el: env.document.getElementById('p2') },
    ];

    // jsdom 的 getSelection() 預設為空（isCollapsed=true）
    const sel = env.window.getSelection();
    expect(sel.isCollapsed).toBe(true);

    // 直接測試 Range.intersectsNode 邏輯
    // 無選區時 filterUnitsBySelection 應回傳 null
    // 模擬 content.js 的 filterUnitsBySelection 邏輯
    const result = _filterUnits(env.window, units);
    expect(result).toBeNull();
  });

  test('選取 p1 → 只保留 p1 unit', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html><head></head><body>
        <p id="p1">Hello world</p>
        <p id="p2">Another paragraph</p>
      </body></html>`,
    });

    const p1 = env.document.getElementById('p1');
    const p2 = env.document.getElementById('p2');
    const units = [
      { kind: 'element', el: p1 },
      { kind: 'element', el: p2 },
    ];

    // 模擬選取 p1
    const range = env.document.createRange();
    range.selectNodeContents(p1);
    const sel = env.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const result = _filterUnits(env.window, units);
    expect(result).not.toBeNull();
    expect(result.length).toBe(1);
    expect(result[0].el).toBe(p1);
  });

  test('選取跨越 p1 和 p2 → 保留兩個 unit', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html><head></head><body>
        <p id="p1">Hello world</p>
        <p id="p2">Another paragraph</p>
        <p id="p3">Not selected</p>
      </body></html>`,
    });

    const p1 = env.document.getElementById('p1');
    const p2 = env.document.getElementById('p2');
    const p3 = env.document.getElementById('p3');
    const units = [
      { kind: 'element', el: p1 },
      { kind: 'element', el: p2 },
      { kind: 'element', el: p3 },
    ];

    // 選取從 p1 開頭到 p2 結尾
    const range = env.document.createRange();
    range.setStart(p1.firstChild, 0);
    range.setEnd(p2.firstChild, p2.firstChild.length);
    const sel = env.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const result = _filterUnits(env.window, units);
    expect(result).not.toBeNull();
    expect(result.length).toBe(2);
    expect(result[0].el).toBe(p1);
    expect(result[1].el).toBe(p2);
  });

  test('選區不包含任何 unit → 回傳 null', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html><head></head><body>
        <div id="header">Header text</div>
        <p id="p1">Paragraph</p>
      </body></html>`,
    });

    const header = env.document.getElementById('header');
    const p1 = env.document.getElementById('p1');
    const units = [
      { kind: 'element', el: p1 },
    ];

    // 只選取 header（不包含 p1）
    const range = env.document.createRange();
    range.selectNodeContents(header);
    const sel = env.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const result = _filterUnits(env.window, units);
    expect(result).toBeNull();
  });

  test('fragment unit 與選區交集檢測', () => {
    env = createEnv({
      html: `<!DOCTYPE html><html><head></head><body>
        <div id="container">
          <span id="s1">Fragment text 1</span>
          <span id="s2">Fragment text 2</span>
          <span id="s3">Fragment text 3</span>
        </div>
      </body></html>`,
    });

    const s1 = env.document.getElementById('s1');
    const s2 = env.document.getElementById('s2');
    const s3 = env.document.getElementById('s3');
    const container = env.document.getElementById('container');

    const units = [
      { kind: 'fragment', el: container, startNode: s1, endNode: s1 },
      { kind: 'fragment', el: container, startNode: s2, endNode: s2 },
      { kind: 'fragment', el: container, startNode: s3, endNode: s3 },
    ];

    // 選取 s2
    const range = env.document.createRange();
    range.selectNodeContents(s2);
    const sel = env.window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const result = _filterUnits(env.window, units);
    expect(result).not.toBeNull();
    expect(result.length).toBe(1);
    expect(result[0].startNode).toBe(s2);
  });
});

/**
 * 模擬 content.js 中 filterUnitsBySelection 的邏輯。
 * 因為 content.js 以 IIFE 封裝無法直接 import，這裡複製核心邏輯。
 */
function _filterUnits(win, units) {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const filtered = units.filter(unit => {
    if (unit.kind === 'fragment') {
      return range.intersectsNode(unit.startNode) || range.intersectsNode(unit.endNode);
    }
    return range.intersectsNode(unit.el);
  });
  return filtered.length > 0 ? filtered : null;
}
