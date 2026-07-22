#!/bin/bash
# ============================================================
#  deploy.sh — 安全部署脚本（自动预检 + 冲突处理）
#  用法: ./deploy.sh "commit 描述"
#  若无 commit 描述，则跳过 commit 只做 pull+push
# ============================================================
set -e

cd "$(dirname "$0")"

BRANCH="main"
REMOTE="origin"

echo "══════════════════════════════════════════"
echo "  🚀 部署脚本 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

# ---- Step 1: 检查工作区状态 ----
echo ""
echo "📋 [1/5] 检查工作区状态..."
git fetch $REMOTE $BRANCH

LOCAL=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse $REMOTE/$BRANCH)
BASE=$(git merge-base HEAD $REMOTE/$BRANCH)

echo "  本地:  ${LOCAL:0:8}"
echo "  远端:  ${REMOTE_HEAD:0:8}"
echo "  共同祖先: ${BASE:0:8}"

if [ "$LOCAL" = "$REMOTE_HEAD" ]; then
    echo "  ✅ 本地与远端同步"
elif [ "$REMOTE_HEAD" = "$BASE" ]; then
    echo "  ✅ 本地领先远端（远端无新提交）"
elif [ "$LOCAL" = "$BASE" ]; then
    echo "  ⚠️  远端有新提交，本地落后 — 需要 pull"
else
    echo "  ⚠️  本地和远端都有新提交 — 需要 rebase"
fi

# ---- Step 2: 暂存并提交本地改动 ----
echo ""
echo "📋 [2/5] 暂存本地改动..."
git add -A

if ! git diff --cached --quiet; then
    if [ -z "$1" ]; then
        echo "  ⚠️  有暂存改动但未提供 commit 描述"
        echo "  用法: ./deploy.sh \"commit 描述\""
        echo "  当前改动文件:"
        git diff --cached --name-only | sed 's/^/    /'
        exit 1
    fi
    echo "  提交: $1"
    git commit -m "$1"
    echo "  ✅ 已提交"
else
    echo "  ℹ️  无本地改动需要提交"
fi

# ---- Step 3: Pull --rebase（核心预检）----
echo ""
echo "📋 [3/5] 拉取远端最新 (pull --rebase)..."
if [ "$LOCAL" = "$REMOTE_HEAD" ] || [ "$REMOTE_HEAD" = "$BASE" ]; then
    echo "  ⏭️  远端无新提交，跳过"
else
    git pull --rebase $REMOTE $BRANCH 2>&1 | sed 's/^/  /'
    
    # 检查 rebase 是否有冲突
    if [ -d ".git/rebase-merge" ] || [ -d ".git/rebase-apply" ]; then
        echo ""
        echo "  ❌ Rebase 冲突！以下文件需要手动解决:"
        git diff --name-only --diff-filter=U | sed 's/^/    /'
        echo ""
        echo "  解决步骤:"
        echo "    1. 编辑上述文件，选择保留哪边的内容"
        echo "    2. git add <文件>"
        echo "    3. git rebase --continue"
        echo "    4. 重新运行 ./deploy.sh"
        echo ""
        echo "  如果想放弃 rebase 回到之前状态:"
        echo "    git rebase --abort"
        exit 1
    fi
    echo "  ✅ Rebase 成功"
fi

# ---- Step 4: Push ----
echo ""
echo "📋 [4/5] 推送到远端..."
git push $REMOTE $BRANCH 2>&1 | sed 's/^/  /'
echo "  ✅ 已推送"

# ---- Step 5: 完成 ----
echo ""
echo "📋 [5/5] 部署完成!"
echo "  GitHub Pages 将在 1-2 分钟后自动更新"
echo "  https://zhaojasonar-zjj.github.io/High-Dividend-Strategy/"
echo "══════════════════════════════════════════"
