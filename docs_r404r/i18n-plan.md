# Shinkansen 多语言支持方案（简体中文 + 日文）

## 现状分析

### 文字分布（~290+ 硬编码中文字符串）

| 类别 | 文件 | 数量 | 说明 |
|------|------|------|------|
| 系统提示词 | `lib/storage.js` | 3 个 | DEFAULT_SYSTEM_PROMPT / GLOSSARY_PROMPT / SUBTITLE_PROMPT |
| 选项页面 HTML | `options/options.html` | 200+ | 标签、标题、说明、占位符 |
| 弹出窗口 | `popup/popup.html` + `popup.js` | ~25 | 按钮、状态文字 |
| Toast 通知 | `content.js` | ~30 | 翻译进度、错误、完成通知 |
| 对话框 | `options/options.js` | ~15 | alert/confirm 文案 |
| SPA 消息 | `content-spa.js` | ~5 | 新内容翻译进度 |
| YouTube 消息 | `content-youtube.js` | ~15 | 字幕翻译状态 |
| Toast 格式 | `content-toast.js` | ~3 | 时间单位（秒/分） |

### 现有 i18n 基础设施

- `_locales/zh_TW/messages.json` 仅 2 条（扩展名称和描述）
- **零** `chrome.i18n` / `browser.i18n` API 使用
- 所有 UI 文字均硬编码在 HTML 和 JS 中

---

## 方案设计

### 核心思路

**不采用 Chrome i18n API**（`chrome.i18n.getMessage`），原因：
1. Chrome i18n 绑定浏览器语言，无法让用户在扩展内自由切换
2. HTML 中的 `__MSG_xxx__` 替换仅在加载时执行一次，无法动态切换
3. Content script 不能直接用 `chrome.i18n`（需要额外 workaround）

**采用自建 i18n 模块**：
- 新建 `lib/i18n.js`，维护三语字符串表
- 所有 UI 文字通过 `t('key')` 函数获取
- 用户设置存储在 `chrome.storage.sync` 的 `uiLocale` 字段
- 翻译提示词根据 `uiLocale` 自动切换

### 语言代号

| 语言 | 代号 | 说明 |
|------|------|------|
| 繁體中文 | `zh-TW` | 现有默认 |
| 简体中文 | `zh-CN` | 新增 |
| 日本語 | `ja` | 新增 |

### 三层需要翻译的内容

#### 第 1 层：翻译提示词（最关键，影响翻译质量）

三个系统提示词必须为每种目标语言重写，不能简单翻译：
- `DEFAULT_SYSTEM_PROMPT`：翻译风格和规范完全不同（台湾繁体 vs 大陆简体 vs 日本語）
- `DEFAULT_GLOSSARY_PROMPT`：术语提取规则因目标语言而异
- `DEFAULT_SUBTITLE_SYSTEM_PROMPT`：字幕翻译规范

**重要**：提示词中的「翻译成台灣繁體中文」需要改为「翻译成简体中文」或「日本語に翻訳する」，语言规范（如禁用大陆用语 vs 使用大陆标准用语）完全相反。

#### 第 2 层：UI 字符串（选项页、弹窗、对话框）

所有 HTML 和 JS 中的硬编码文字需要通过 `t('key')` 调用。

#### 第 3 层：运行时消息（Toast、状态栏）

Content script 中的翻译进度、错误消息等。

---

## 实施计划

### Phase 1: i18n 基础模块 + 设置项

**文件**: `lib/i18n.js`（新建）, `lib/storage.js`（修改）, `options/options.html`（修改）

1. 新建 `lib/i18n.js`:
   - 导出 `t(key, ...args)` 函数（支持占位符 `{0}`, `{1}`）
   - 导出 `setLocale(locale)` / `getLocale()` 函数
   - 内建三语字符串表（按模块分组）
   - 提供 `applyLocale(root)` 函数，遍历 DOM 中 `data-i18n` 属性的元素并替换文字

2. `lib/storage.js` 修改:
   - `DEFAULT_SETTINGS` 新增 `uiLocale: 'zh-TW'`
   - 三个 DEFAULT_*_PROMPT 改为按语言索引的对象

3. `options/options.html` 在「一般设定」最上方加语言切换下拉框

### Phase 2: 提示词三语版本

**文件**: `lib/i18n-prompts.js`（新建）

为三个系统提示词创建三语版本：
- `zh-TW`: 现有内容（不变）
- `zh-CN`: 改写为简体中文规范（使用大陆标准用语、简体字、大陆通行译名）
- `ja`: 重写为日文翻译规范（日本語の翻訳ルール）

### Phase 3: UI 字符串迁移

**文件**: `options/options.html`, `options/options.js`, `popup/popup.html`, `popup/popup.js`

1. HTML 中所有中文文字加上 `data-i18n="key"` 属性
2. JS 中所有中文字符串替换为 `t('key')` 调用
3. `applyLocale()` 在页面加载时执行

### Phase 4: Content Script 消息

**文件**: `content.js`, `content-toast.js`, `content-spa.js`, `content-youtube.js`, `content-ns.js`

Content script 不能 `import`，需要：
1. 在 `content-ns.js` 中初始化全局 `SK.t()` 函数
2. 从 `chrome.storage.sync` 读取 `uiLocale` 设置
3. 内嵌精简版字符串表（仅包含 content script 用到的 ~50 个 key）

### Phase 5: 构建适配 + 测试

- `scripts/build.js` 确保 i18n 模块被正确打包
- `_locales/` 新增 `zh_CN/messages.json` 和 `ja/messages.json`（扩展元数据用）

---

## 工作量评估

| Phase | 内容 | 估算 |
|-------|------|------|
| Phase 1 | i18n 模块 + 设置项 | 中 |
| Phase 2 | 三语提示词 | 大（需要专业翻译水平） |
| Phase 3 | UI 字符串迁移（290+ strings） | 大（量多但重复性高） |
| Phase 4 | Content Script 消息 | 中 |
| Phase 5 | 构建 + 测试 | 小 |

**总体**: 这是一个大型改造，字符串提取和翻译是主要工作量。
