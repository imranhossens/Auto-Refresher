#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export GIT_TERMINAL_PROMPT=0

cd "$(dirname "$0")" || exit 1

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   🚀 Auto Refresh Tab — GitHub Auto Updater ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  echo -e "${RED}❌ Error: Not a git repository.${NC}"
  sleep 2
  exit 1
fi

BRANCH="$(git branch --show-current)"
[ -z "$BRANCH" ] && BRANCH="main"

echo -e "${YELLOW}📦 Staging all changes...${NC}"
git add -A

VERSION=$(grep -m1 '"version"' manifest.json 2>/dev/null | sed -E 's/.*"version":[[:space:]]*"([^"]+)".*/\1/')
if git diff --cached --quiet; then
  echo -e "${YELLOW}✨ No local changes to commit.${NC}"
else
  COMMIT_MSG="Update Auto Refresh Tab${VERSION:+ v$VERSION} - $(date '+%Y-%m-%d %H:%M')"
  git commit -m "$COMMIT_MSG"
  echo -e "${GREEN}💾 Committed changes:${NC} $COMMIT_MSG"
fi

echo ""
echo -e "${YELLOW}🔄 Syncing and pushing to GitHub ($BRANCH)...${NC}"
git pull --rebase origin "$BRANCH" 2>/dev/null || true

if git push origin "$BRANCH"; then
  echo ""
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN} ✅ Done! Code updated and pushed to GitHub.  ${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
else
  echo ""
  echo -e "${RED}❌ Push failed. Please check your internet connection or Git credentials.${NC}"
fi

echo ""
sleep 2
exit 0
