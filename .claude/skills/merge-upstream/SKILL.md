---
name: merge-upstream
description: "合并上游 (upstream) commit 到 Nozomi fork。分析差异、评估难度、解决冲突、codex review、测试、beta tag push 一条龙。"
disable-model-invocation: true
---

# Merge Upstream — Shinkansen-Nozomi

将上游 jimmysu0309/shinkansen 的新 commit 合并到 Nozomi fork，保留所有 Nozomi 独有功能。

## 前置知识

Nozomi fork 相比上游的核心差异（合并时必须保留）：
- **Bing Translate 引擎**：`lib/bing-token.js`, `lib/bing-translate.js`, background.js `TRANSLATE_BATCH_BING` handler, content.js `_bingMode` 路径
- **多语言 UI (i18n)**：`lib/i18n.js`, `lib/i18n-prompts.js`, `content-ns.js` 三语言 string table, `t()` / `SK.t()` 调用, `data-i18n` HTML 属性, `applyLocale()` / `applyRichTextLocale()`
- **选区翻译**：`filterUnitsBySelection()`, `STATE.translationScope`
- **Firefox 双平台**：`manifest.firefox.json`, `scripts/build.js`, `content-youtube-main-loader.js`, `lib/session-storage.js`, `lib/compat.js`
- **Sticky 翻译开关**：`stickyTranslateEnabled`
- **innerHTML 零容忍**：Mozilla AMO 合规，所有 DOM 操作用 `createElement` + `textContent` + `replaceChildren`
- **版本号**：Nozomi 使用独立版本号（如 1.9.0），不跟随上游版本

## 执行流程

严格按以下 6 个阶段执行，每阶段完成后向用户报告，等待确认再进入下一阶段。

---

### 阶段 1：差异分析

```bash
git fetch upstream
git log --oneline upstream/main --not HEAD
```

对每个未合并的 commit，分析并输出表格：

| 字段 | 说明 |
|------|------|
| Commit hash + 版本号 | 如 `710abe7 v1.8.12` |
| 类型 | Bug Fix / Feature / Docs / Refactor |
| 内容摘要 | 一句话说明做了什么 |
| 修改文件 | 核心文件 + 文档/版本文件分开列 |
| 与 Nozomi 冲突 | 逐文件标注 ✅无冲突 / ⚠有冲突（说明原因） |
| Merge 难度 | 🟢低 / 🟡中 / 🔴高 |
| 合并建议 | ⭐1-5 + 建议/不建议/可选 + 理由 |

用 `git show <hash> --stat` 和 `git show <hash>` 查看每个 commit 的详细改动。
用 `git merge-tree $(git merge-base HEAD upstream/main) HEAD upstream/main` 预测冲突。

**等待用户确认哪些 commit 要合并后，进入阶段 2。**

---

### 阶段 2：执行合并 + 解决冲突

```bash
git merge upstream/main
```

冲突解决原则（按优先级）：
1. **版本号文件**（manifest.json, README.md, SPEC.md, docs/index.html, CHANGELOG.md, version-check.spec.js）：保留 Nozomi 版本号
2. **Nozomi i18n 代码**：保留 `t()` / `SK.t()` 调用，不接受上游的硬编码中文字串
3. **Nozomi 独有功能代码**：保留 Bing dispatch / selection translate / sticky translate / Firefox 适配
4. **上游新功能代码**：接受上游改动，确保与 Nozomi 功能兼容
5. **innerHTML**：如果上游引入了 `innerHTML` 赋值，必须改为 DOM API

冲突解决后：
- `grep -rn "<<<<<<" shinkansen/` 确认零残留
- `npm run build:all` 确认双平台构建通过

---

### 阶段 3：Nozomi 适配

检查清单：
- [ ] 上游新增的 UI 字串是否需要加入 `lib/i18n.js` 和 `content-ns.js`（三语言：zh-TW / zh-CN / ja）
- [ ] 上游新增的 `SK.t()` key 是否在 content-ns.js 的三个 string table 中都有定义
- [ ] 上游新增的功能是否与 Bing 引擎路径兼容（Bing 复用 `translatePageGoogle` + `translateUnitsGoogle`）
- [ ] 上游新增的功能是否与选区翻译兼容
- [ ] `manifest.firefox.json` 版本号是否同步
- [ ] `grep -rn '\.innerHTML\s*=' shinkansen/` 是否为 0

---

### 阶段 4：Codex 交叉 Review

启动 2-3 个并行 Agent 做 codex review，分工：
- **Agent A**：Review 冲突文件的解决是否正确，Nozomi 功能是否保留
- **Agent B**：Review 上游新功能代码是否与 Nozomi 功能兼容（Bing / i18n / selection / Firefox）
- **Agent C**（如有新测试）：Review 新增测试的正确性

Review 重点：
- innerHTML 零容忍
- `SK.t()` / `t()` i18n 一致性
- Bing 路径兼容性（`_bingMode`, `TRANSLATE_BATCH_BING`）
- `sanitizeMarkers` 在所有注入点覆盖
- zh-CN forbidden terms skip 在所有翻译路径一致

**修复 review 发现的问题后，进入阶段 5。**

---

### 阶段 5：测试

```bash
# 构建
npm run build:all

# 全量测试
npx playwright test

# innerHTML 合规
grep -rn '\.innerHTML\s*=' shinkansen/

# 如果上游新增了功能，追加 Nozomi 测试 case：
# - 新功能 × Bing 引擎兼容性
# - 新功能 × 选区翻译交互
# - 新 i18n key 存在性
```

测试通过标准：
- 全量 pass（已知 flaky test `cache-glossary-keysuffix.spec.js` 可接受单独 re-run pass）
- innerHTML 计数 = 0
- 双平台构建成功

---

### 阶段 6：Commit + Beta Tag + Push

```bash
# 提交 merge（使用 git 自动生成的 merge message）
git add -A && git commit --no-edit

# Beta tag（格式：v{major}.{minor}.{patch}.{beta}，beta 1-9）
git tag v{VERSION}.{NEXT_BETA}

# Push
git push origin main --tags
```

Beta 版本号规则：
- 查看 `git tag -l 'v{VERSION}*'` 确定下一个 beta 号
- Firefox AMO 不允许前导零（用 `.1` 不用 `.01`）
- Beta 最大为 9，超过则小版本 +1

---

## 常见问题

### Q: 上游改了我也改了的文件怎么办？
优先保留 Nozomi 改动，把上游新功能手动合并进来。用 `git show upstream/main -- <file>` 查看上游改了什么。

### Q: 上游用了 innerHTML 怎么办？
必须改为 DOM API。参考 CLAUDE.md 的「innerHTML 禁用規則」表格。

### Q: 上游新增了 toast message 但没有 i18n？
上游只有繁体中文，需要在 `lib/i18n.js` 和 `content-ns.js` 同时添加三语言版本（zh-TW / zh-CN / ja）。

### Q: 版本号怎么处理？
所有版本号保留 Nozomi 当前版本（如 1.9.0），不跟随上游。CHANGELOG 中上游条目放在 `## v1.8.x` section。
