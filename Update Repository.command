#!/bin/zsh
# ─────────────────────────────────────────────
#  Auto Refresh Tab — Push to GitHub
#  Double-click this file to upload your latest
#  code changes to GitHub automatically.
# ─────────────────────────────────────────────

# Change to the folder where this script lives
cd "$(dirname "$0")"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Auto Refresh Tab — GitHub Updater"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if there is anything new to commit
if git diff --quiet && git diff --cached --quiet; then
  echo "✅  Nothing new to commit. Your repository is already up to date."
else
  echo "📦  Staging all changes..."
  git add -A

  # Ask for a commit message
  echo ""
  echo "✏️   Enter a short description of your changes:"
  read -r COMMIT_MSG

  # Fall back to a timestamped message if user left it blank
  if [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG="Update $(date '+%Y-%m-%d %H:%M')"
  fi

  git commit -m "$COMMIT_MSG"
  echo ""
fi

echo "🚀  Pushing to GitHub..."
git push origin main

echo ""
if [ $? -eq 0 ]; then
  echo "✅  Done! Your code has been uploaded to GitHub successfully."
else
  echo "❌  Push failed. Make sure you are connected to the internet"
  echo "    and that you are authenticated with GitHub."
fi

echo ""
echo "Press any key to close this window..."
read -rk 1
