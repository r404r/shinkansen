# Shinkansen Firefox 双平台构建改造方案

## 目标

将现有 Chrome-only 扩展改造为**单一代码库，双平台构建**，分别产出 Chrome 和 Firefox 扩展包。

---

## TODO List（严格顺序执行）

### Phase 1: 构建基础设施

#### TODO-01: 引入 esbuild，创建构建脚本骨架

**改动文件**: `package.json`, `scripts/build.js`（新建）

**详细内容**:
1. `package.json` 新增 devDependency: `esbuild`
2. `package.json` 新增 scripts:
   ```json
   "build:chrome": "node scripts/build.js chrome",
   "build:firefox": "node scripts/build.js firefox",
   "build:all": "node scripts/build.js chrome && node scripts/build.js firefox"
   ```
3. 新建 `scripts/build.js`:
   - 接收 CLI 参数 `chrome` 或 `firefox`
   - 用 esbuild 打包 `shinkansen/background.js` → `build/{target}/background.js`
     - Chrome: `format: 'esm'`
     - Firefox: `format: 'iife'`（Firefox MV3 background 不一定支持 ES module）
   - 定义编译时常量 `__BROWSER__`（值为 `'chrome'` 或 `'firefox'`）
   - Content scripts 不打包（它们本身就是 IIFE，无 import），直接复制
   - 复制静态资源：`icons/`, `_locales/`, `*.css`, `*.html`, `lib/vendor/`
   - 根据 target 复制对应 manifest:
     - Chrome → 使用原始 `manifest.json`
     - Firefox → 使用 `manifest.firefox.json`
   - popup.js / options.js 也需要 esbuild 打包（它们 import 了 lib/）
   - 输出目录: `build/chrome/`, `build/firefox/`

**验收标准**: `npm run build:chrome` 产出完整可加载的 Chrome 扩展（功能与改造前一致）

---

#### TODO-02: 创建 Firefox manifest

**改动文件**: `shinkansen/manifest.firefox.json`（新建）

**详细内容**:
基于现有 `manifest.json`，做以下修改:

1. `background` 改为:
   ```json
   "background": {
     "scripts": ["background.js"]
   }
   ```
   （Firefox MV3 用 `scripts` 数组而非 `service_worker`，且不需要 `"type": "module"`——因为 esbuild 已打包为 IIFE）

2. YouTube MAIN world content script 改为:
   ```json
   {
     "matches": ["https://www.youtube.com/*"],
     "js": ["content-youtube-main-loader.js"],
     "run_at": "document_start"
   }
   ```
   去掉 `"world": "MAIN"`（Firefox 不支持），改用 loader 脚本动态注入。

3. 新增 `browser_specific_settings`:
   ```json
   "browser_specific_settings": {
     "gecko": {
       "id": "shinkansen@r404r.github.io",
       "strict_min_version": "109.0"
     }
   }
   ```

4. `web_accessible_resources` 新增:
   ```json
   "web_accessible_resources": [{
     "resources": ["content-youtube-main.js"],
     "matches": ["https://www.youtube.com/*"]
   }]
   ```
   （供 loader 脚本通过 `<script src>` 注入到 MAIN world）

**验收标准**: JSON 合法，字段完整，与 Chrome manifest 差异可 diff 对比

---

### Phase 2: 浏览器差异兼容

#### TODO-03: 抽象 storage.session 为跨平台 sessionStore

**改动文件**: `shinkansen/lib/session-storage.js`（新建）, `shinkansen/background.js`

**详细内容**:

1. 新建 `shinkansen/lib/session-storage.js`:
   ```js
   import { browser } from './compat.js';

   const PREFIX = '_sk_session_';
   const hasSessionAPI = typeof __BROWSER__ !== 'undefined'
     ? __BROWSER__ === 'chrome'
     : !!browser.storage?.session;

   export const sessionStore = {
     async get(key) {
       if (hasSessionAPI) {
         const result = await browser.storage.session.get(key);
         return result[key];
       }
       // Firefox fallback: storage.local + prefix
       const result = await browser.storage.local.get(PREFIX + key);
       return result[PREFIX + key];
     },
     async set(key, value) {
       if (hasSessionAPI) {
         await browser.storage.session.set({ [key]: value });
         return;
       }
       await browser.storage.local.set({ [PREFIX + key]: value });
     },
   };
   ```

2. 修改 `background.js`:
   - 新增 `import { sessionStore } from './lib/session-storage.js';`
   - Line 186: `browser.storage.session.get('stickyTabs')` → `sessionStore.get('stickyTabs')`
   - Line 202: `browser.storage.session.set({ stickyTabs: obj })` → `sessionStore.set('stickyTabs', obj)`

**验收标准**: Chrome 构建行为不变（仍用 storage.session），Firefox 构建走 storage.local fallback

---

#### TODO-04: Firefox YouTube MAIN world 注入方案

**改动文件**: `shinkansen/content-youtube-main-loader.js`（新建）

**详细内容**:

Firefox 不支持 manifest 的 `"world": "MAIN"`，需要一个 loader 脚本在 content script（isolated world）中动态注入 `<script>` 到页面上下文。

新建 `shinkansen/content-youtube-main-loader.js`:
```js
// Firefox: 将 content-youtube-main.js 注入到 MAIN world
// Chrome 不需要此文件（manifest 直接声明 world: "MAIN"）
(function () {
  const s = document.createElement('script');
  s.src = browser.runtime.getURL('content-youtube-main.js');
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
})();
```

构建脚本处理:
- Chrome 构建: 不复制此文件（Chrome 用 manifest 声明 MAIN world）
- Firefox 构建: 复制此文件 + `content-youtube-main.js`

**验收标准**: Firefox 构建包含 loader + main 文件，Chrome 构建不含 loader

---

#### TODO-05: 快捷键设置链接兼容 Firefox

**改动文件**: `shinkansen/options/options.js`, `shinkansen/options/options.html`

**详细内容**:

1. `options/options.html` Line 46:
   - 当前: `鍵位可至 <a href="#" id="open-shortcuts">chrome://extensions/shortcuts</a> 變更。`
   - 改为: `鍵位可至 <a href="#" id="open-shortcuts">擴充功能快捷鍵設定</a> 變更。`
   （去掉硬编码 URL，改用通用文案）

2. `options/options.js` Lines 612-622:
   当前逻辑: Chrome 显示 / Safari 隐藏
   改为三分支:
   ```js
   // 快捷鍵設定連結：Chrome → chrome://extensions/shortcuts
   //                  Firefox → about:addons（附帶齒輪 icon → 管理快捷鍵）
   //                  Safari → 隱藏
   const isFirefox = typeof globalThis.browser !== 'undefined'
     && typeof globalThis.browser.runtime?.getBrowserInfo === 'function';
   const isChrome = typeof globalThis.chrome !== 'undefined' && !isFirefox;

   if (isChrome) {
     $('open-shortcuts').addEventListener('click', (e) => {
       e.preventDefault();
       browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
     });
   } else if (isFirefox) {
     $('open-shortcuts').addEventListener('click', (e) => {
       e.preventDefault();
       browser.tabs.create({ url: 'about:addons' });
     });
   } else {
     const shortcutsLink = $('open-shortcuts');
     if (shortcutsLink) shortcutsLink.style.display = 'none';
   }
   ```

**验收标准**: Chrome 跳转 chrome://extensions/shortcuts，Firefox 跳转 about:addons，Safari 隐藏

---

### Phase 3: 构建验证与测试

#### TODO-06: 构建脚本完善与双平台产物验证

**改动文件**: `scripts/build.js`

**详细内容**:
1. 确保 `npm run build:chrome` 产出的 `build/chrome/` 可在 Chrome 加载为扩展
2. 确保 `npm run build:firefox` 产出的 `build/firefox/` 文件完整:
   - manifest.json (Firefox 版)
   - background.js (IIFE 格式)
   - 所有 content scripts
   - content-youtube-main-loader.js (Firefox 专有)
   - popup/, options/ (含 HTML/CSS/JS)
   - icons/, _locales/, content.css
   - lib/vendor/chart.min.js
3. 验证 Chrome 产物无 Firefox-only 文件（如 loader）
4. 验证 Firefox 产物无 Chrome-only 字段

**验收标准**: 两个目录结构完整，文件无遗漏

---

#### TODO-07: 测试脚本适配，支持指定构建产物目录

**改动文件**: `package.json`, `playwright.config.js`

**详细内容**:
1. `package.json` 新增:
   ```json
   "test:chrome": "EXTENSION_DIR=build/chrome playwright test",
   "test:firefox": "EXTENSION_DIR=build/firefox playwright test"
   ```
2. `playwright.config.js` 读取 `process.env.EXTENSION_DIR`，默认 `shinkansen/`（向后兼容）
3. 现有 `npm test` 行为不变（仍指向原始 `shinkansen/` 目录，开发时使用）

**验收标准**: `npm run test:chrome` 用 build/chrome 产物跑测试通过

---

#### TODO-08: 更新 release.sh 支持双平台打包

**改动文件**: `release.sh`

**详细内容**:
1. release 前自动执行 `npm run build:all`
2. 打包两个 zip:
   - `shinkansen-chrome-v{version}.zip` (从 `build/chrome/`)
   - `shinkansen-firefox-v{version}.zip` (从 `build/firefox/`)
3. 保留向后兼容: `shinkansen-v{version}.zip` 仍产出（Chrome 版，等同 chrome zip）

**验收标准**: `./release.sh "test"` 产出三个 zip

---

#### TODO-09: 更新 CLAUDE.md 和项目文档

**改动文件**: `CLAUDE.md`

**详细内容**:
1. 新增构建命令说明（build:chrome, build:firefox, build:all）
2. 说明双 manifest 架构
3. 说明 `__BROWSER__` 编译时常量用法
4. 更新测试命令（新增 test:chrome, test:firefox）

**验收标准**: CLAUDE.md 反映改造后的新架构

---

## 改动影响总结

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `package.json` | 修改 | 新增 esbuild 依赖 + 构建/测试 scripts |
| `scripts/build.js` | **新建** | 双平台构建脚本 |
| `shinkansen/manifest.firefox.json` | **新建** | Firefox 专用 manifest |
| `shinkansen/lib/session-storage.js` | **新建** | storage.session 跨平台抽象 |
| `shinkansen/content-youtube-main-loader.js` | **新建** | Firefox MAIN world 注入 loader |
| `shinkansen/background.js` | 修改 | 2 处 storage.session → sessionStore |
| `shinkansen/options/options.js` | 修改 | 快捷键链接三分支 |
| `shinkansen/options/options.html` | 修改 | 去掉硬编码 chrome:// URL |
| `release.sh` | 修改 | 双平台打包 |
| `playwright.config.js` | 修改 | 支持 EXTENSION_DIR 环境变量 |
| `CLAUDE.md` | 修改 | 更新文档 |

## 不改动的文件（已兼容）

- `lib/compat.js` — Proxy 桥接已覆盖 Chrome/Firefox
- `content-ns.js` — 已有 `globalThis.browser ?? globalThis.chrome`
- `content-*.js`（除 youtube-main）— 纯 DOM 操作，无浏览器特定 API
- `lib/cache.js`, `lib/gemini.js`, `lib/storage.js` 等 — 通过 compat.js 使用 browser.*
- `background.js` 的 setBadgeTextColor — 已有 feature detection guard
