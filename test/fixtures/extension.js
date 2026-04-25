// Shinkansen Playwright extension fixture
//
// 重要地雷（MV3 + Playwright）：
//   1. 必須用 chromium.launchPersistentContext(...)，普通 launch() 載不了 extension。
//   2. 不能用 Playwright 的 headless: true（舊 headless），會 disable service worker。
//      改用 Chrome 原生 --headless=new（v1.5.2 起，2026-04-25），background 路由
//      正常運作。預設啟用，可用 SHINKANSEN_HEADED=1 切回 headed 模式做視覺除錯。
//   3. --disable-extensions-except 與 --load-extension 兩個都要給，
//      只給後者 Chrome 仍會嘗試載入其他 extension（雖然 user data dir 是空的，
//      還是依規矩走）。
//   4. 每次跑用獨立 temp user data dir，避免狀態殘留與平行衝突。
//      Playwright config 已經把 workers 鎖成 1，再加 temp dir 雙保險。
//
// 用法：
//   import { test, expect } from '../fixtures/extension.js';
//   test('xxx', async ({ context, extensionId }) => { ... });
import { test as base, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// EXTENSION_DIR 環境變數可指向 build/chrome 等構建產物目錄；預設為原始 shinkansen/
const EXTENSION_PATH = process.env.EXTENSION_DIR
  ? path.resolve(process.env.EXTENSION_DIR)
  : path.resolve(__dirname, '../../shinkansen');
// 回歸測試的靜態 fixture 目錄（HTML / canned LLM response 等）
const REGRESSION_FIXTURES_DIR = path.resolve(__dirname, '../regression/fixtures');

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(`找不到 extension manifest：${EXTENSION_PATH}/manifest.json`);
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shinkansen-pw-'));
    const headed = process.env.SHINKANSEN_HEADED === '1';
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        ...(headed ? [] : ['--headless=new']),
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    await use(context);

    await context.close();
    // 清掉 temp user data dir
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  // 本地 HTTP server (v0.59 新增,給回歸測試載靜態 fixture 用)。
  //
  // 為什麼不用 data:URL / file://：
  //   - data:URL 對長 HTML 不實用,而且 content script 在 data: scheme 上可能
  //     不被注入(視 manifest 設定而定)。
  //   - file:// 在現代 Chrome 上需要額外旗標,容易踩權限地雷。
  //   - 起一個 temp port 的 http server,行為跟正式網頁最接近,content script
  //     會正常跑,跟 v0.58 之前 inject 路徑的真實環境一致。
  //
  // 綁 127.0.0.1 與隨機 port (0),由 OS 配發空閒 port,避免並行衝突。
  // 只 serve REGRESSION_FIXTURES_DIR 底下的檔案,並做 path traversal 防護。
  // eslint-disable-next-line no-empty-pattern
  localServer: async ({}, use) => {
    const server = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        // 移除前導 /,join 之後再用 path.relative 做 traversal 檢查
        const rel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        const filePath = path.join(REGRESSION_FIXTURES_DIR, rel);
        const relCheck = path.relative(REGRESSION_FIXTURES_DIR, filePath);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.writeHead(404); res.end('not found: ' + rel); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const ct = ext === '.html'
          ? 'text/html; charset=utf-8'
          : ext === '.json'
            ? 'application/json; charset=utf-8'
            : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(filePath));
      } catch (err) {
        res.writeHead(500); res.end(String(err && err.message || err));
      }
    });
    // 追蹤所有 socket,teardown 時強制 destroy。否則 Chrome 的 keep-alive
    // 連線會卡住 server.close() 不返回,造成 fixture teardown timeout。
    const sockets = new Set();
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    await use({ baseUrl, port });
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise((resolve) => server.close(() => resolve()));
  },

  // 取得 extension ID（從 service worker URL 解析）
  // 對 Edo 偵測測試而言不是必要的，但留著供後續測試使用
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    const id = worker.url().split('/')[2];
    await use(id);
  },
});

export const expect = test.expect;
