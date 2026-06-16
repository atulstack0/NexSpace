#!/usr/bin/env bash
#
# Push NexSpace to GitHub as a sequence of per-step commits.
# Run from the repo root (this folder) in Git Bash:  bash push_to_github.sh
#
# Prereqs: git installed, and you're authenticated to GitHub
# (Git Credential Manager will prompt on first push, or use a Personal Access Token).
set -e

REPO="https://github.com/atulstack0/NexSpace.git"

# 1. Init repo + remote (safe to re-run)
[ -d .git ] || git init
git branch -M main
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"

# Helper: commit only if there's something staged
commit() { git diff --cached --quiet || git commit -m "$1"; }

# --- Step 1: planning & research ---
git add .gitignore push_to_github.sh NexSpace_Build_Plan.md NexSpace_Task_Backlog.csv NexSpace_Roadmap_Timeline.csv 2>/dev/null || true
commit "docs: planning — build plan, phased roadmap, task backlog"

# --- Step 2: single-file interactive prototype ---
git add NexSpace_Prototype.html 2>/dev/null || true
commit "feat(prototype): spatial office — movement, proximity/room audio, doors, broadcast, media wall, 2D/3D toggle"

# --- Step 3: monorepo scaffold + shared types ---
git add nexspace-scaffold/package.json nexspace-scaffold/README.md nexspace-scaffold/packages 2>/dev/null || true
commit "chore(scaffold): monorepo + shared (x,y,z) world & wire-protocol types"

# --- Step 4: realtime/state server ---
git add nexspace-scaffold/apps/realtime 2>/dev/null || true
commit "feat(realtime): authoritative WS server — position sync, presence, rooms/doors, media, broadcast; optional world load from API"

# --- Step 5: multiplayer web client + editor ---
git add nexspace-scaffold/apps/web 2>/dev/null || true
commit "feat(web): multiplayer office — shared rooms/doors/media wall, spatial audio, LiveKit voice/video, drag-and-drop editor"

# --- Step 6: persistence API ---
git add nexspace-scaffold/apps/api 2>/dev/null || true
commit "feat(api): NestJS + Prisma + Postgres — world endpoint, layout writes, LiveKit token minting"

# --- catch anything else ---
git add -A
commit "chore: remaining project files"

# 2. Push
echo "Pushing to $REPO ..."
git push -u origin main
echo "Done. If push was rejected because the repo already has commits, run:"
echo "    git pull --rebase origin main && git push -u origin main"
