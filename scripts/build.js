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
const contentScripts = [
  'content-ns.js',
  'content-toast.js',
  'content-detect.js',
  'content-serialize.js',
  'content-inject.js',
  'content-spa.js',
  'content-youtube.js',
  'content.js',
  'content-youtube-main.js',
];

for (const file of contentScripts) {
  cpSync(resolve(SRC, file), resolve(OUT, file));
}

// Firefox 專用: content-youtube-main-loader.js
if (target === 'firefox') {
  const loaderPath = resolve(SRC, 'content-youtube-main-loader.js');
  if (existsSync(loaderPath)) {
    cpSync(loaderPath, resolve(OUT, 'content-youtube-main-loader.js'));
  }
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

console.log(`✓ Build complete → build/${target}/`);
