#!/usr/bin/env node
// scripts/build.js — Shinkansen 雙平台構建腳本
// 用法: node scripts/build.js chrome | firefox

import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'shinkansen');

const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) {
  console.error('Usage: node scripts/build.js <chrome|firefox>');
  process.exit(1);
}

const OUT = resolve(ROOT, 'build', target);

// ─── 清理輸出目錄 ──────────────────────────────────────
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(resolve(OUT, 'popup'), { recursive: true });
mkdirSync(resolve(OUT, 'options'), { recursive: true });

console.log(`Building for ${target}...`);

// ─── 共用 esbuild 選項 ─────────────────────────────────
const commonOptions = {
  bundle: true,
  define: { '__BROWSER__': JSON.stringify(target) },
  target: 'es2020',
  // lib/ 下的模組會被 bundle 進去，不需要外部 resolve
};

// ─── 1. 打包 ES module 入口檔案 ────────────────────────
// background.js, popup/popup.js, options/options.js 都有 import

// background.js
await build({
  ...commonOptions,
  entryPoints: [resolve(SRC, 'background.js')],
  outfile: resolve(OUT, 'background.js'),
  // Chrome: ESM（manifest 宣告 type: module）
  // Firefox: IIFE（manifest 用 scripts 陣列，無 module 支援保證）
  format: target === 'chrome' ? 'esm' : 'iife',
});

// popup/popup.js
await build({
  ...commonOptions,
  entryPoints: [resolve(SRC, 'popup', 'popup.js')],
  outfile: resolve(OUT, 'popup', 'popup.js'),
  format: target === 'chrome' ? 'esm' : 'iife',
});

// options/options.js
await build({
  ...commonOptions,
  entryPoints: [resolve(SRC, 'options', 'options.js')],
  outfile: resolve(OUT, 'options', 'options.js'),
  format: target === 'chrome' ? 'esm' : 'iife',
});

// ─── 2. 複製 content scripts（IIFE，無需打包） ─────────
// 順序與 manifest.json content_scripts[].js 對齊（雖然複製順序不影響執行）。
// 缺漏會導致 Firefox 整條 content_scripts 入口校驗失敗、所有 content script 全部
// 不注入 → 快捷鍵 onCommand 仍 fire 但 tabs.sendMessage 找不到 listener,
// 被 background.js 既有 .catch(()=>{}) 靜默吞掉,使用者看到「按了沒反應」。
// 步驟 5 的 SANITY 校驗會掃 manifest 確認無漏。
const contentScripts = [
  'content-ns.js',
  'content-toast.js',
  'content-detect.js',
  'content-serialize.js',
  'content-inject.js',
  'content-spa.js',
  'content-youtube.js',
  'content-drive.js',
  'content.js',
  'content-youtube-main.js',
  'content-drive-iframe.js',
];

for (const file of contentScripts) {
  cpSync(resolve(SRC, file), resolve(OUT, file));
}

// Firefox ���用: 生成 content-youtube-main-loader.js（內嵌 MAIN world 腳本）
// 使用 textContent 而非 src 注入，確保 monkey-patch 在 YouTube 發 XHR 前同步執行。
if (target === 'firefox') {
  const mainScript = readFileSync(resolve(SRC, 'content-youtube-main.js'), 'utf8');
  const loaderCode = `// [AUTO-GENERATED] Firefox MAIN world 內嵌注入器
(function () {
  var s = document.createElement('script');
  s.textContent = ${JSON.stringify(mainScript)};
  (document.head || document.documentElement).appendChild(s);
  s.remove();
})();
`;
  writeFileSync(resolve(OUT, 'content-youtube-main-loader.js'), loaderCode, 'utf8');
}

// ─── 3. 複製靜態資源 ───────────────────────────────────
// icons/
cpSync(resolve(SRC, 'icons'), resolve(OUT, 'icons'), { recursive: true });

// _locales/
cpSync(resolve(SRC, '_locales'), resolve(OUT, '_locales'), { recursive: true });

// CSS
cpSync(resolve(SRC, 'content.css'), resolve(OUT, 'content.css'));
cpSync(resolve(SRC, 'popup', 'popup.css'), resolve(OUT, 'popup', 'popup.css'));
cpSync(resolve(SRC, 'options', 'options.css'), resolve(OUT, 'options', 'options.css'));

// HTML — Firefox 需要把 type="module" 改掉（打包後是 IIFE）
for (const htmlRel of ['popup/popup.html', 'options/options.html']) {
  const srcPath = resolve(SRC, htmlRel);
  const destPath = resolve(OUT, htmlRel);
  if (target === 'firefox') {
    let html = readFileSync(srcPath, 'utf8');
    html = html.replace(/type="module"\s*/g, '');
    writeFileSync(destPath, html, 'utf8');
  } else {
    cpSync(srcPath, destPath);
  }
}

// privacy-policy.html（如果存在）
const privacyPath = resolve(SRC, 'privacy-policy.html');
if (existsSync(privacyPath)) {
  cpSync(privacyPath, resolve(OUT, 'privacy-policy.html'));
}

// vendor/ (Chart.js)
const vendorSrc = resolve(SRC, 'lib', 'vendor');
if (existsSync(vendorSrc)) {
  mkdirSync(resolve(OUT, 'lib', 'vendor'), { recursive: true });
  cpSync(vendorSrc, resolve(OUT, 'lib', 'vendor'), { recursive: true });
}

// ─── 4. 複製 manifest ──────────────────────────────────
if (target === 'firefox') {
  const firefoxManifest = resolve(SRC, 'manifest.firefox.json');
  if (existsSync(firefoxManifest)) {
    cpSync(firefoxManifest, resolve(OUT, 'manifest.json'));
  } else {
    console.error('✗ manifest.firefox.json not found — Firefox build requires it.');
    process.exit(1);
  }
} else {
  cpSync(resolve(SRC, 'manifest.json'), resolve(OUT, 'manifest.json'));
}

// ─── 5. SANITY: manifest 引用的所有 content script / background 檔案都要存在 ───
// 為什麼:合併 upstream 帶入 content-drive.js / content-drive-iframe.js 時
// 漏更新本檔 contentScripts 陣列,build 出去的 manifest 引用了 build 目錄裡
// 不存在的檔案。Firefox 整條 content_scripts 入口校驗失敗 → 全部 content
// script 不注入 → 快捷鍵 onCommand fire 但無 listener 可收 → 靜默失敗。
// 早期偵測:build 結束前掃 manifest 確認所有引用的 .js 都複製到了。
{
  const manifestPath = resolve(OUT, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const referenced = new Set();
  for (const entry of manifest.content_scripts || []) {
    for (const js of entry.js || []) referenced.add(js);
  }
  // background 入口(Chrome: service_worker / Firefox: scripts[])
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  for (const s of manifest.background?.scripts || []) referenced.add(s);

  const missing = [];
  for (const file of referenced) {
    if (!existsSync(resolve(OUT, file))) missing.push(file);
  }
  if (missing.length > 0) {
    console.error(`✗ manifest 引用的檔案在 build 輸出中缺失:`);
    for (const f of missing) console.error(`    - ${f}`);
    console.error(`  修法:把缺失檔案加進 scripts/build.js 的 contentScripts 陣列。`);
    process.exit(1);
  }
}

console.log(`✓ Build complete → build/${target}/`);
