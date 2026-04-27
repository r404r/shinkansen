#!/bin/bash
# 用法: ./release.sh "改了什麼"
# 自動 build、commit、tag、push，GitHub Actions 會自動建 Release 並附 zip

set -e
cd "$(dirname "$0")"

VERSION=$(grep '"version"' shinkansen/manifest.json | head -1 | sed 's/[^0-9.]//g')
MSG="${1:-v${VERSION}}"

# ─── 雙平台構建 ──────────────────────────────────────────
echo "Building Chrome & Firefox..."
npm run build:all

# v1.6.5: minor/major bump 時提醒檢查 RELEASE_HIGHLIGHTS 是否要更新
# patch bump 不會觸發 welcome notice，跳過提醒
PREV_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
PREV_VER=${PREV_TAG#v}
if [ -n "$PREV_VER" ]; then
  NEW_MAJOR=$(echo "$VERSION" | cut -d. -f1)
  NEW_MINOR=$(echo "$VERSION" | cut -d. -f2)
  PREV_MAJOR=$(echo "$PREV_VER" | cut -d. -f1)
  PREV_MINOR=$(echo "$PREV_VER" | cut -d. -f2)
  if [ "$NEW_MAJOR" != "$PREV_MAJOR" ] || [ "$NEW_MINOR" != "$PREV_MINOR" ]; then
    echo ""
    echo "⚠️  Major / Minor bump 偵測到（v${PREV_VER} → v${VERSION}）"
    echo "   此版會觸發 CWS 使用者的「歡迎升級」提示——請確認"
    echo "   shinkansen/lib/release-highlights.js 的 RELEASE_HIGHLIGHTS 是否要更新。"
    echo ""
    echo "   - 有新功能 → 把最舊那條換成新功能描述"
    echo "   - 純內部升級（重構 / 效能 / 修 bug） → 可用通用條目，例如："
    echo "       '改善效能與穩定性，提升整體使用體驗'"
    echo ""
    read -p "   按 Enter 繼續發版、按 Ctrl+C 中止去更新 highlights ... " _ignore
  fi
fi

git add -A
git commit -m "v${VERSION} — ${MSG}"

# 若 tag 已存在，先刪除本地和遠端的舊 tag 再重建
if git tag -l "v${VERSION}" | grep -q .; then
  git tag -d "v${VERSION}"
  git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
fi
git tag "v${VERSION}"
git push && git push --tags

echo ""
echo "v${VERSION} 已推送，Release 會在 1 分鐘內自動建立。"
echo "https://github.com/jimmysu0309/shinkansen/releases"
