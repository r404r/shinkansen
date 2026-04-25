// content-toast.js — Shinkansen Toast 提示系統
// Shadow DOM 隔離的 Toast UI，提供翻譯進度、成功/失敗/還原提示。

(function(SK) {
  if (!SK || SK.disabled) return;  // v1.5.2: iframe gate（見 content-ns.js）
  // ─── Toast 提示 （Shadow DOM 隔離） ─────────────────────
  const toastHost = document.createElement('div');
  toastHost.id = 'shinkansen-toast-host';
  toastHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  const shadow = toastHost.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .toast {
      position: fixed;
      width: 280px;
      padding: 14px 16px 12px 16px;
      background: #ffffff;
      color: #1d1d1f;
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18);
      font: 13px -apple-system, 'PingFang TC', 'Microsoft JhengHei', sans-serif;
      display: none;
      flex-direction: column;
      gap: 8px;
    }
    .toast.show { display: flex; }
    .toast.pos-bottom-right { bottom: 24px; right: 24px; }
    .toast.pos-bottom-left  { bottom: 24px; left: 24px; }
    .toast.pos-top-right    { top: 24px; right: 24px; }
    .toast.pos-top-left     { top: 24px; left: 24px; }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .msg {
      flex: 1;
      font-weight: 500;
      color: #1d1d1f;
    }
    .detail {
      font-size: 12px;
      color: #6e6e73;
      font-variant-numeric: tabular-nums;
      margin-top: -2px;
      white-space: pre-line;
      line-height: 1.4;
    }
    .detail[hidden] { display: none; }
    .timer {
      font-variant-numeric: tabular-nums;
      color: #86868b;
      font-size: 12px;
    }
    .close {
      cursor: pointer;
      background: none; border: 0;
      font-size: 18px; line-height: 1;
      color: #86868b;
      padding: 0 2px;
    }
    .close:hover { color: #1d1d1f; }
    .bar {
      position: relative;
      height: 4px;
      width: 100%;
      background: #e8e8ed;
      border-radius: 2px;
      overflow: hidden;
    }
    .bar-fill {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 0%;
      background: #0071e3;
      border-radius: 2px;
      transition: width .3s ease;
    }
    .toast.indeterminate .bar-fill {
      width: 30%;
      animation: slide 1.4s ease-in-out infinite;
    }
    @keyframes slide {
      0%   { left: -30%; }
      100% { left: 100%; }
    }
    .toast.success .bar-fill { background: #34c759; width: 100%; }
    .toast.error   .bar-fill { background: #ff3b30; width: 100%; }
    .toast.mismatch .bar-fill {
      background: #ff9500;
      animation: blink-yellow .6s ease-in-out infinite;
    }
    @keyframes blink-yellow {
      0%, 100% { opacity: 1; }
      50%      { opacity: .4; }
    }
  `;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.id = 'toast';
  const row = document.createElement('div');
  row.className = 'row';
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.id = 'msg';
  msg.textContent = SK.t('cs_translating');
  const timer = document.createElement('span');
  timer.className = 'timer';
  timer.id = 'timer';
  const close = document.createElement('button');
  close.className = 'close';
  close.id = 'close';
  close.title = SK.t('cs_close');
  close.textContent = '×';
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.id = 'detail';
  detail.hidden = true;
  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'bar-fill';
  fill.id = 'fill';
  row.append(msg, timer, close);
  bar.appendChild(fill);
  toast.append(row, detail, bar);
  shadow.append(style, toast);
  document.documentElement.appendChild(toastHost);

  // Toast 透明度
  function applyToastOpacity(opacity) {
    toastHost.style.opacity = Math.max(0.1, Math.min(1, opacity ?? 0.7));
  }

  // Toast 位置
  const VALID_POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
  let currentToastPosition = 'bottom-right';
  function applyToastPosition(pos) {
    const toastInner = shadow.getElementById('toast');
    if (!toastInner) return;
    const p = VALID_POSITIONS.includes(pos) ? pos : 'bottom-right';
    currentToastPosition = p;
    toastInner.className = toastInner.className.replace(/\bpos-\S+/g, '').trim() + ' pos-' + p;
  }

  // Toast 自動關閉開關
  let toastAutoHide = true;

  browser.storage.sync.get(['toastOpacity', 'toastPosition', 'toastAutoHide']).then((s) => {
    applyToastOpacity(s.toastOpacity);
    applyToastPosition(s.toastPosition);
    if (typeof s.toastAutoHide === 'boolean') toastAutoHide = s.toastAutoHide;
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.toastOpacity) {
      applyToastOpacity(changes.toastOpacity.newValue);
    }
    if (area === 'sync' && changes.toastPosition) {
      applyToastPosition(changes.toastPosition.newValue);
    }
    if (area === 'sync' && changes.toastAutoHide) {
      toastAutoHide = changes.toastAutoHide.newValue ?? true;
    }
  });

  const toastEl = shadow.getElementById('toast');
  const toastMsgEl = shadow.getElementById('msg');
  const toastDetailEl = shadow.getElementById('detail');
  const toastTimerEl = shadow.getElementById('timer');
  const toastFillEl = shadow.getElementById('fill');
  shadow.getElementById('close').addEventListener('click', () => SK.hideToast());
  let toastTickHandle = null;
  let toastStartTime = 0;
  let toastHideHandle = null;
  let toastOutsideHandler = null;

  function removeOutsideClickHandler() {
    if (toastOutsideHandler) {
      document.removeEventListener('mousedown', toastOutsideHandler, true);
      toastOutsideHandler = null;
    }
  }

  SK.formatElapsed = function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + SK.t('cs_seconds');
    const m = Math.floor(s / 60);
    return m + SK.t('cs_minutes') + (s % 60) + SK.t('cs_seconds');
  };

  SK.formatTokens = function formatTokens(n) {
    return n.toLocaleString('en-US');
  };

  SK.formatUSD = function formatUSD(n) {
    if (!n) return '$0';
    if (n < 0.01)  return '$' + n.toFixed(4);
    if (n < 1)     return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  };

  /**
   * kind: 'loading' | 'success' | 'error'
   * opts: { progress?, startTimer?, stopTimer?, autoHideMs?, detail?, mismatch? }
   */
  SK.showToast = function showToast(kind, msg, opts = {}) {
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
    removeOutsideClickHandler();

    const classes = ['toast', 'show', kind, 'pos-' + currentToastPosition];
    if (kind === 'loading' && opts.progress == null) classes.push('indeterminate');
    if (opts.mismatch) classes.push('mismatch');
    toastEl.className = classes.join(' ');
    toastMsgEl.textContent = msg;

    if (opts.detail) {
      toastDetailEl.textContent = opts.detail;
      toastDetailEl.hidden = false;
    } else {
      toastDetailEl.textContent = '';
      toastDetailEl.hidden = true;
    }

    if (opts.progress != null) {
      toastFillEl.style.width = Math.round(opts.progress * 100) + '%';
    } else if (kind === 'success' || kind === 'error') {
      toastFillEl.style.width = '100%';
    } else {
      toastFillEl.style.width = '0%';
    }

    if (opts.startTimer) {
      toastStartTime = Date.now();
      clearInterval(toastTickHandle);
      toastTimerEl.textContent = SK.t('cs_zero_seconds');
      toastTickHandle = setInterval(() => {
        toastTimerEl.textContent = SK.formatElapsed(Date.now() - toastStartTime);
      }, 500);
    }
    if (opts.stopTimer) {
      clearInterval(toastTickHandle);
      toastTickHandle = null;
      if (toastStartTime) {
        toastTimerEl.textContent = SK.formatElapsed(Date.now() - toastStartTime);
      }
    }

    if (opts.autoHideMs) {
      toastHideHandle = setTimeout(() => {
        toastHideHandle = null;
        SK.hideToast();
      }, opts.autoHideMs);
    }

    if (kind === 'success' && !opts.autoHideMs) {
      if (toastAutoHide) {
        toastHideHandle = setTimeout(() => {
          toastHideHandle = null;
          SK.hideToast();
        }, 5000);
      }
      setTimeout(() => {
        if (!toastEl.className.includes('show')) return;
        toastOutsideHandler = (ev) => {
          const path = ev.composedPath ? ev.composedPath() : [];
          if (path.includes(toastHost)) return;
          SK.hideToast();
        };
        document.addEventListener('mousedown', toastOutsideHandler, true);
      }, 0);
    }
  };

  SK.hideToast = function hideToast() {
    toastEl.className = 'toast pos-' + currentToastPosition;
    toastDetailEl.hidden = true;
    clearInterval(toastTickHandle);
    toastTickHandle = null;
    if (toastHideHandle) {
      clearTimeout(toastHideHandle);
      toastHideHandle = null;
    }
    removeOutsideClickHandler();
  };

})(window.__SK);
