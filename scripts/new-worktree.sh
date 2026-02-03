#!/usr/bin/env bash
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ -z "$1" ]; then
  echo -e "${RED}Error: Feature name required${NC}"
  echo "Usage: scripts/new-worktree.sh <feature-name>"
  echo "Example: scripts/new-worktree.sh add-blood-glucose"
  exit 1
fi

FEATURE_NAME="$1"
BRANCH_NAME="$FEATURE_NAME"
MAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE_DIR="$(dirname "$MAIN_DIR")/roadmap-$FEATURE_NAME"

# Validate we're in a git repo
if ! git -C "$MAIN_DIR" rev-parse --git-dir > /dev/null 2>&1; then
  echo -e "${RED}Error: Not in a git repository${NC}"
  exit 1
fi

if git -C "$MAIN_DIR" show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo -e "${RED}Error: Branch '$BRANCH_NAME' already exists${NC}"
  echo "Use a different name or delete: git branch -d $BRANCH_NAME"
  exit 1
fi

if [ -d "$WORKTREE_DIR" ]; then
  echo -e "${RED}Error: Directory '$WORKTREE_DIR' already exists${NC}"
  exit 1
fi

echo -e "${YELLOW}Creating worktree for feature: $FEATURE_NAME${NC}"

echo "→ Creating branch + worktree..."
git -C "$MAIN_DIR" worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR"

# Copy .env files (skip .env.example)
for env_file in "$MAIN_DIR"/.env "$MAIN_DIR"/.env.*; do
  if [ -f "$env_file" ] && [ "$(basename "$env_file")" != ".env.example" ]; then
    echo "→ Copying $(basename "$env_file")..."
    cp "$env_file" "$WORKTREE_DIR/$(basename "$env_file")"
  fi
done

echo ""
echo -e "${GREEN}Worktree created successfully!${NC}"
echo ""
echo "  Directory:  $WORKTREE_DIR"
echo "  Branch:     $BRANCH_NAME"
echo ""
echo "Point Claude Code at the new directory to start working."
echo ""
echo "Clean up after merge:"
echo "  git worktree remove $WORKTREE_DIR"
echo "  git branch -d $BRANCH_NAME"
echo ""
echo "Active worktrees:"
git -C "$MAIN_DIR" worktree list
