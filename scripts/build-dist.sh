#!/bin/bash
# Builds distribution packages for both agent and VS Code users.
# Run from repo root: ./scripts/build-dist.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_AGENT="$REPO_ROOT/dist/agent"
DIST_VSCODE="$REPO_ROOT/dist/vscode"

echo "=== Building ContextForge Distribution Packages ==="
echo ""

# Step 1: Build core (binary + bundle)
echo "Step 1: Building MCP server binary..."
cd "$REPO_ROOT/packages/core"
npm run build
npm run bundle -- --binary
echo ""

# Step 2: Populate agent dist
echo "Step 2: Populating dist/agent/..."
mkdir -p "$DIST_AGENT/node_modules"

cp "$REPO_ROOT/packages/core/release/contextforge" "$DIST_AGENT/contextforge"
chmod +x "$DIST_AGENT/contextforge"

# Copy only required native modules
cp -r "$REPO_ROOT/packages/core/bundle/node_modules/better-sqlite3" "$DIST_AGENT/node_modules/"
cp -r "$REPO_ROOT/packages/core/bundle/node_modules/onnxruntime-node" "$DIST_AGENT/node_modules/"

echo "  → dist/agent/ ready"
echo ""

# Step 3: Build and populate VS Code dist
echo "Step 3: Building VS Code extension..."
mkdir -p "$DIST_VSCODE"
cd "$REPO_ROOT/packages/vscode-extension"
npm run package

cp "$REPO_ROOT/packages/vscode-extension/"*.vsix "$DIST_VSCODE/"
echo "  → dist/vscode/ ready"
echo ""

# Summary
echo "=== Distribution packages ready ==="
echo ""
echo "dist/agent/    — For headless agent developers"
ls -lh "$DIST_AGENT/contextforge" 2>/dev/null | awk '{print "  contextforge: " $5}'
echo ""
echo "dist/vscode/   — For VS Code users"
ls -lh "$DIST_VSCODE/"*.vsix 2>/dev/null | awk '{print "  " $NF ": " $5}'
echo ""
echo "Distribute each folder separately to the respective teams."
