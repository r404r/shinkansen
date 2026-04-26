# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Shinkansen-Nozomi (新幹線のぞみ) is a browser extension (Chrome + Firefox, Manifest V3) that translates web pages to Traditional Chinese / Simplified Chinese / Japanese. Forked from [jimmysu0309/shinkansen](https://github.com/jimmysu0309/shinkansen). Dual translation engines: Gemini AI and Google Translate. Single codebase, dual-platform build via esbuild.

## Commands

```bash
# Build
npm run build:chrome      # Build Chrome extension → build/chrome/
npm run build:firefox     # Build Firefox extension → build/firefox/
npm run build:all         # Build both platforms

# Testing
npm test                  # All Playwright tests (unit + regression, source dir)
npm run test:unit         # Playwright unit tests only
npm run test:regression   # Playwright regression tests only
npm run test:jest         # Jest unit tests (SPA/YouTube/whitelist logic)
npm run test:all          # Playwright + Jest combined
npm run test:version      # Sanity: extension loads, manifest valid
npm run test:chrome       # Playwright tests against build/chrome/ output

# Run a single test
npx playwright test test/unit/glossary-json-parsing.spec.js
npx jest --config jest.config.cjs test/jest-unit/spa-url-polling.test.cjs

# Test with custom extension dir
EXTENSION_DIR=build/chrome npx playwright test test/unit/some.spec.js

# Release (builds both, commits, tags, pushes)
./release.sh "改了什麼"
```

**Testing notes:**
- Playwright runs headful (`workers: 1`, no parallelization — shared user data dir)
- Playwright uses `launchPersistentContext` (MV3 service workers require it)
- `retries: 0` — no auto-retries on test failures
- Jest tests use jsdom for content script logic
- `EXTENSION_DIR` env var overrides extension path (default: `shinkansen/`)

## Dual-Platform Build

### Build Architecture

esbuild bundles ES module entry points (`background.js`, `popup/popup.js`, `options/options.js`) with compile-time constant `__BROWSER__` (`'chrome'` or `'firefox'`). Content scripts (IIFE, no imports) are copied directly.

| Aspect | Chrome | Firefox |
|--------|--------|---------|
| Manifest | `manifest.json` | `manifest.firefox.json` |
| Background | ESM (`type: "module"`) | IIFE (`scripts: [...]`) |
| YouTube MAIN world | `world: "MAIN"` in manifest | `content-youtube-main-loader.js` (inline `<script>`) |
| HTML `<script>` | `type="module"` | `type` attribute removed |
| Session storage | `browser.storage.session` | `browser.storage.local` + `_sk_session_` prefix |

### `__BROWSER__` Compile-Time Constant

Use `__BROWSER__` for platform-specific code paths:
```js
if (__BROWSER__ === 'firefox') { /* Firefox-only */ }
```
esbuild eliminates dead branches at build time. For runtime detection (rare), use `lib/compat.js`.

### Key Cross-Platform Files

- `lib/compat.js`: Proxy-based `browser`/`chrome` API bridge
- `lib/session-storage.js`: `sessionStore` — Chrome uses native `storage.session`, Firefox falls back to `storage.local` with prefix isolation + startup cleanup
- `content-youtube-main-loader.js`: Firefox MAIN world injector (build script inlines `content-youtube-main.js` as `textContent` for synchronous execution)

## Architecture

### Three Extension Contexts

**Service Worker (`background.js`)** — Stateless translation orchestrator:
- Gemini/Google Translate API calls with retry + exponential backoff
- Cache layer (chrome.storage.local, SHA-1 keying, LRU eviction)
- Three-dimensional rate limiter (RPM/TPM/RPD sliding windows)
- Usage tracking (IndexedDB), badge/icon management, log aggregation

**Content Scripts (`content.js` + 6 modules)** — DOM manipulation and state:
- `content.js`: Main coordinator, `STATE` object, translation triggers, restore, edit mode, SPA support
- `content-detect.js`: DOM tree walking, paragraph segmentation, CJK threshold filtering
- `content-inject.js`: DOM node replacement, serialization/deserialization, link slot recovery
- `content-serialize.js`: Placeholder wrapping (`⟦N⟧…⟦/N⟧` paired, `⟦*N⟧` atomic), LLM normalization
- `content-spa.js`: SPA navigation (History API + URL polling + sticky state)
- `content-youtube.js`: Subtitle XHR monkey-patching, time-window batching, on-the-fly fallback
- `content-ns.js`: Shared namespace (`SK` global), constants, helpers
- `content-toast.js`: Non-blocking progress notifications

**UI (`popup/`, `options/`)** — Settings and quick actions

### Shared Libraries (`shinkansen/lib/`)

| Module | Purpose |
|--------|---------|
| `gemini.js` | Gemini API client (fetchWithRetry, 429 backoff, glossary extraction) |
| `google-translate.js` | Free Google Translate endpoint |
| `storage.js` | Settings (chrome.storage.sync), DEFAULT_SYSTEM_PROMPT, migration |
| `cache.js` | LRU eviction, SHA-1 keying, version-based auto-clear |
| `rate-limiter.js` | Three-dimensional sliding windows (RPM/TPM/RPD) |
| `session-storage.js` | Cross-platform session storage abstraction |
| `usage-db.js` | IndexedDB logging, CSV export, YouTube session merge |
| `logger.js` | Debug log buffer (1,000 entries) |

### Storage Layers

- `chrome.storage.sync`: Settings, glossary, presets (syncs across devices)
- `chrome.storage.local`: Translation cache (~5 MB quota)
- `chrome.storage.session` / `sessionStore`: Sticky translate map (cross-tab; Firefox uses local with prefix)
- `IndexedDB`: Usage logs (unlimited, historical)

### YouTube Subtitle System

MAIN world script (`content-youtube-main.js`) intercepts XHR for caption data (POT handling). CustomEvent detail is JSON-serialized for cross-boundary compatibility (page→content script). Content script (`content-youtube.js`) manages batching, playback tracking, and on-the-fly fallback.

## Release Workflow

1. Update version in `shinkansen/manifest.json` + `shinkansen/manifest.firefox.json`
2. Run `./release.sh "description"` — builds both platforms, commits, tags, pushes
3. GitHub Actions (`.github/workflows/release.yml`) produces 4 zips: chrome, firefox, versioned, latest

## Key Documentation

- `SPEC.md`: Technical specification (system prompt, function inventory, architecture details)
- `CHANGELOG.md`: Forensic changelog — every version has root cause, fix strategy, affected files, SANITY checks
- `PERFORMANCE.md`: Memory/speed/cost benchmarks
- `DEBUG-BOARD.md`: Debug bridge protocol (CustomEvent-based)
- `docs_r404r/firefox-migration-plan.md`: Firefox migration plan and TODO details

## Conventions

- Language: JavaScript ES modules in `lib/` and `background.js`; classic scripts in content scripts
- All documentation and commit messages are in Traditional Chinese (台灣繁體中文)
- Changelog entries must include: root cause, affected files, SANITY checks
- Regression tests named by feature: `test/regression/{feature}.spec.js`
- Test fixtures in `test/fixtures/` (domain-specific HTML files)
- License: Elastic License 2.0 (ELv2)

## innerHTML 禁用規則（Mozilla AMO 合規）

**絕對禁止在任何 JS 文件中使用 `el.innerHTML = ...` 賦值。** Mozilla AMO 審核會標記所有 `innerHTML` 賦值為安全警告，即使內容已轉義。

替代方案（按場景）：

| 場景 | 禁止 | 替代 |
|------|------|------|
| 構建表格行/選項 | `tbody.innerHTML = rows.join('')` | `document.createElement()` + `el.replaceChildren(...nodes)` |
| 設定元素文字 | `el.innerHTML = text` | `el.textContent = text` |
| 含 HTML 標籤的文字 | `el.innerHTML = '<strong>text</strong>'` | DOM API 構建：`createElement('strong')` + `textContent` |
| 含 `<a>` 連結的段落 | `el.innerHTML = 'text <a>link</a>'` | `applyRichTextLocale()` 模式：`setWithLink()` helper |
| 存儲/還原 DOM 快照 | `el.innerHTML = saved` | `SK.cloneChildSnapshot()` / `SK.restoreChildSnapshot()` |
| i18n 動態替換 | `data-i18n-html` + `innerHTML` | `data-i18n` + `textContent`，含 HTML 的元素用 `applyRichTextLocale()` |

**檢查命令**：`grep -rn '\.innerHTML\s*=' shinkansen/` 應返回 0 結果。
構建後檢查：`grep -c '\.innerHTML\s*=' build/firefox/**/*.js` 也應為 0。
