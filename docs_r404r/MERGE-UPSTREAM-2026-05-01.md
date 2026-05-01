# Merge Upstream v1.8.18 → v1.8.38 — 执行计划

**日期**：2026-05-01
**分支**：`merge-upstream-v1.8.18-38`
**起点**：`main` @ `d2d0a73`
**目标**：合并 26 个 upstream commit（jimmysu0309/shinkansen v1.8.18 → v1.8.38），保留所有 Nozomi 独有功能

---

## 范围与策略

**策略**：两阶段一次性 merge + 后处理修补。
理由：26 个 commit 的冲突集中在约 10 个文件，逐文件解决比 cherry-pick 26 次成本更低，且能完整拿到 v1.8.20 的 22 条 bug 修复 + v1.8.21 YouTube 稳健性 + v1.8.26 Firefox 内存泄漏修复。

**例外处理**：
- v1.8.37 (`501bbc3`) 的 "中國用語黑名單→禁用詞清單" 命名变更，与 Nozomi 已有的 "地区用语黑名单" 三向冲突 — merge 后由独立 commit 反向修补
- v1.8.37 的 landing page 多语化与 Nozomi 已重做的主页重复 — merge 后保留 Nozomi 版本
- Firefox 集群（v1.8.25-29）— 优先保留 Nozomi 现有 Firefox 实现，仅吸收上游的 bugfix（如 v1.8.26 内存泄漏修复）

---

## 26 commit 概览

| # | Hash | 版本 | 类型 | 摘要 | 难度 | 处理 |
|---|---|---|---|---|---|---|
| 1 | `d75a882` | v1.8.18 | chore | 移除 chrome.management 依赖 | 🟢 | 接受 |
| 2 | `4f287a3` | v1.8.19 | feature | options 大型 UI 简化 + safeSendMessage | 🔴 | 接受，i18n 补齐 |
| 3 | `006f826` | v1.8.20 | bugfix | 22 条 bug 一次清完 | 🔴 | 接受 |
| 4 | `cc47022` | docs | docs | landing screenshots | 🟢 | 接受 |
| 5 | `3ce1c99` | v1.8.21 | feature | YouTube 稳健性 + §15 | 🔴 | 接受 |
| 6 | `15c7dc7` | v1.8.22 | feature | YouTube 无边模式 | 🟡 | 接受 |
| 7 | `0ead5b5` | v1.8.23 | refactor | options UI 文案 | 🟡 | 接受 |
| 8 | `cd8dcae` | v1.8.24 | chore | 空版本 | 🟡 | 接受 |
| 9 | `830d71e` | v1.8.25 | feature | Firefox 128+ sideload | 🔴 | 比较保留 Nozomi 方案 |
| 10 | `e058d05` | v1.8.26 | bugfix | Firefox 内存泄漏 | 🔴 | 仔细合（跨平台 bugfix） |
| 11 | `2ef02d2` | v1.8.27 | bugfix | 修 v1.8.25 manifest | 🔴 | 比较保留 |
| 12 | `2fab3e0` | v1.8.28 | chore | AMO 送审准备 | 🟢 | 比较保留（Nozomi 已有） |
| 13 | `2445218` | v1.8.29 | chore | AMO innerHTML 注释 | 🔴 | 跳过注释，保 Nozomi 零 innerHTML |
| 14 | `d77c58f` | docs | docs | privacy permissions | 🟡 | 接受 |
| 15 | `eafa48b` | v1.8.30 | refactor | privacy 中性化 | 🟡 | 接受 |
| 16 | `0f9649e` | v1.8.31 | feature | 双语对照视觉 | 🟡 | 接受 |
| 17 | `46844b6` | docs | docs | PENDING_REGRESSION 清理 | 🟢 | 接受 |
| 18 | `e16928d` | v1.8.32 | feature | YouTube CC 关闭隐藏 | 🟡 | 接受 |
| 19 | `0cdcf5b` | v1.8.33 | bugfix | vBulletin thread | 🟢 | 接受 |
| 20 | `feb99a0` | v1.8.34 | feature | 自定 Provider CORS | 🟡 | 接受 |
| 21 | `a50284d` | PR#20 | bugfix | Arc tabs.create | 🟡 | 接受 |
| 22 | `c961867` | v1.8.35 | chore | 整 #20 PR | 🟡 | 接受 |
| 23 | `c7d7708` | docs | docs | API-KEY-SETUP 精简 | 🟢 | 接受 |
| 24 | `96b2c85` | v1.8.36 | bugfix | Content Guard 祖层 | 🟡 | 接受 |
| 25 | `501bbc3` | v1.8.37 | refactor | UI 中性化 + landing 多语 | 🔴 | **后处理反向修补** |
| 26 | `65d07f9` | v1.8.38 | docs | README + logo-full.svg | 🟡 | 接受 |

---

## 执行步骤

### Step 0 ✅ 创建分支
- `git checkout -b merge-upstream-v1.8.18-38`

### Step 1 ✅ 落盘计划
- 当前文件 (`docs_r404r/MERGE-UPSTREAM-2026-05-01.md`)
- Commit message: `docs: merge-upstream v1.8.18-38 计划落盘`

### Step 2 — git merge + 解决冲突
- `git fetch upstream`
- `git merge --no-commit upstream/main`
- 逐文件处理 24 个冲突文件，按以下优先级：
  1. **版本号文件** (`manifest.json`, `manifest.firefox.json`, `README.md`, `SPEC.md`, `docs/index.html`, `CHANGELOG.md`, `test/version-check.spec.js`)：保留 Nozomi 当前版本号 `1.9.0`
  2. **Nozomi i18n 代码** (`content-ns.js`, `lib/i18n.js`)：保留 `t()` / `SK.t()` 调用，不接受上游硬编码繁中字串
  3. **Nozomi 独有功能**：保留 Bing dispatch (`background.js`)、selection translate (`content.js`)、sticky translate、Firefox 适配 (`compat.js`, `session-storage.js`)
  4. **上游新功能**：接受上游 bugfix 与 feature 代码，确保 Bing 路径与 selection translate 仍 compatible
  5. **innerHTML**：上游若引入 `innerHTML` 赋值必须改为 DOM API
- 验证 `grep -rn "<<<<<<" shinkansen/` = 0
- Commit message: `merge: upstream v1.8.18-38（26 commits, 24 文件冲突解决）`

### Step 3 — 反向修补 v1.8.37 命名
- 上游 v1.8.37 把"中國用語黑名單"改成"禁用詞清單"
- Nozomi 已经独立改成"地區用語黑名單"（更中性，明示是地区用语而非政治用语）
- 在所有上游 v1.8.37 修改的位置，恢复成 Nozomi 的"地区用语黑名单"
- 文件预期：`options/options.html`, `options/options.js`, `lib/i18n.js`, `content-ns.js`, `popup/popup.html`, `docs/index.html`
- Commit message: `fix: 恢复 Nozomi "地區用語黑名單" 命名（v1.8.37 上游改"禁用詞清單"反向修补）`

### Step 4 — i18n 三语补齐
- 上游 v1.8.19 / v1.8.20 / v1.8.21 / v1.8.22 / v1.8.32 / v1.8.34 等新增的 UI 字串只有繁中
- 检查 `lib/i18n.js` + `content-ns.js` 三语 string table（zh-TW / zh-CN / ja）哪些 key 缺失
- 补齐缺失的 zh-CN 与 ja 翻译
- Commit message: `i18n: 上游新 UI 字串补齐 zh-CN / ja 三语翻译`

### Step 5 — build + test 验证
- `npm run build:all` 双平台构建必过
- `npx playwright test` 全量 pass（已知 flaky `cache-glossary-keysuffix.spec.js` 单独 re-run 接受）
- `grep -rn '\.innerHTML\s*=' shinkansen/` = 0
- 修复任何 regression
- Commit message: `test: merge-upstream regression 修复`（如有 fix）

### Step 6 — codex 终审
- `codex review --base main` 审整个 merge branch vs main
- 修复 P1 / P2 finding
- Commit message: `fix: codex review 后修补`（如有 fix）

### Final — 准备 PR / merge to main
- `git push origin merge-upstream-v1.8.18-38`
- 创建 PR 或 fast-forward merge 到 main
- Beta tag：`v1.9.0.5` (假设 v1.9.0.4 已用)

---

## 回滚策略

每一步独立 commit，rollback 粒度 = 单个 commit。

```bash
# 回滚到合并前
git reset --hard d2d0a73

# 回滚到某个特定步骤
git reset --hard <step-N-commit-hash>

# 撤销分支重来
git checkout main && git branch -D merge-upstream-v1.8.18-38
```

---

## 已知风险

1. **v1.8.19 options UI 大改**：可能需要大量手动 i18n key 补齐
2. **v1.8.20 22 bug fix**：单 commit 改动多文件，难以单独验证每条 bug
3. **Firefox 集群结构差异**：Nozomi Firefox 实现走 `lib/compat.js` + `lib/session-storage.js` + 独立 `manifest.firefox.json`；上游走 `firefox-build.sh` + jq 改写。需手动整合
4. **innerHTML 退化**：上游 v1.8.29 加了 21 处 AMO 注释（保留 innerHTML），合并时如果接受会破坏 Nozomi 零 innerHTML 合规

---

## 完成标准

- ✅ 26 commit 全部纳入 merge（v1.8.37 通过反向修补抵消）
- ✅ Nozomi 所有独有功能保留：Bing 引擎、三语 i18n、选区翻译、Firefox 双平台、sticky translate、地区用语黑名单
- ✅ `npm run build:all` 双平台通过
- ✅ `npx playwright test` 全量 pass
- ✅ `grep -rn '\.innerHTML\s*=' shinkansen/` = 0
- ✅ codex review GATE: PASS
