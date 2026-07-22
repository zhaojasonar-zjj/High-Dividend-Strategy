#!/bin/bash
# ============================================================
#  deploy.sh — 安全部署脚本（自动预检 + 冲突处理）
#  用法: ./deploy.sh "commit 描述"
#  若有改动但未提供描述，则报错退出
# ============================================================
set -eo pipefail

cd "$(dirname "$0")"

BRANCH="main"
REMOTE="origin"
PAGES_URL="https://zhaojasonar-zjj.github.io/High-Dividend-Strategy/"

echo "══════════════════════════════════════════"
echo "  🚀 部署脚本 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

# ---- Step 0: 分支检查 ----
echo ""
echo "📋 [0/6] 检查当前分支..."
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
    echo "  ❌ 当前在分支 '$CURRENT_BRANCH'，不是 '$BRANCH'"
    echo "  请先切换: git checkout $BRANCH"
    exit 1
fi
echo "  ✅ 当前分支: $BRANCH"

# ---- Step 1: 检查工作区状态 ----
echo ""
echo "📋 [1/6] 检查工作区状态..."
git fetch $REMOTE $BRANCH || {
    echo "  ❌ 拉取远端信息失败，请检查网络连接"
    exit 1
}

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
echo "📋 [2/6] 暂存本地改动..."
git add -A

if ! git diff --cached --quiet; then
    # 显示待提交文件列表
    echo "  待提交文件:"
    git diff --cached --name-only | sed 's/^/    /'
    echo ""
    
    if [ -z "$1" ]; then
        echo "  ⚠️  有暂存改动但未提供 commit 描述"
        echo "  用法: ./deploy.sh \"commit 描述\""
        exit 1
    fi
    echo "  提交: $1"
    git commit -m "$1"
    echo "  ✅ 已提交"
else
    echo "  ℹ️  无本地改动需要提交"
fi

# commit 后重新获取本地 HEAD（B3 修复）
LOCAL=$(git rev-parse HEAD)

# ---- Step 3: Pull --rebase（核心预检）----
echo ""
echo "📋 [3/6] 拉取远端最新 (pull --rebase)..."
if [ "$REMOTE_HEAD" = "$BASE" ]; then
    echo "  ⏭️  远端无新提交，跳过"
else
    # 不用管道，避免退出码被 sed 吞掉（B2 修复）
    if ! git pull --rebase $REMOTE $BRANCH; then
        # 检查是否是冲突导致的失败
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
        else
            echo "  ❌ Pull 失败，请检查网络或认证"
        fi
        exit 1
    fi
    echo "  ✅ Rebase 成功"
fi

# ---- Step 4: Push ----
echo ""
echo "📋 [4/6] 推送到远端..."
# 不用管道，避免退出码被 sed 吞掉（B1 修复）
if ! git push $REMOTE $BRANCH; then
    echo "  ❌ Push 失败！可能原因：网络问题、认证过期、远端有新提交"
    echo "  建议：重新运行 ./deploy.sh"
    exit 1
fi
echo "  ✅ 已推送"

# ---- Step 5: 确认同步状态 ----
echo ""
echo "📋 [5/6] 确认同步状态..."
git fetch $REMOTE $BRANCH 2>/dev/null
LOCAL=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse $REMOTE/$BRANCH)
if [ "$LOCAL" = "$REMOTE_HEAD" ]; then
    echo "  ✅ 本地与远端完全同步"
else
    echo "  ⚠️  本地与远端不一致，可能有自动同步提交"
    echo "  本地:  ${LOCAL:0:8}"
    echo "  远端:  ${REMOTE_HEAD:0:8}"
fi

# ---- Step 6: 完成 ----
echo ""
echo "📋 [6/6] 部署完成!"
echo "  GitHub Pages 将在 1-2 分钟后自动更新"
echo "  $PAGES_URL"
echo "══════════════════════════════════════════"
