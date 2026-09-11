#!/usr/bin/env bash
# Tests for scripts/build-dist.sh
#
# Run from the repo root:
#   bash scripts/build-dist.test.sh
#
# Exit 0 if all tests pass, 1 if any fail.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/build-dist.sh"

PASS=0
FAIL=0
TMPDIR_WORK=""

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  [[ -n "$TMPDIR_WORK" ]] && rm -rf "$TMPDIR_WORK"
}
trap cleanup EXIT

# ── Assertion helpers ─────────────────────────────────────────────────────────

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc (expected='$expected' actual='$actual')"
  fi
}

assert_ne() {
  local desc="$1" unexpected="$2" actual="$3"
  if [[ "$actual" != "$unexpected" ]]; then
    pass "$desc"
  else
    fail "$desc (value should not be '$unexpected')"
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$desc"
  else
    fail "$desc (expected to contain: '$needle')"
  fi
}

# ── Setup ─────────────────────────────────────────────────────────────────────

TMPDIR_WORK="$(mktemp -d)"
MOCK_BIN="$TMPDIR_WORK/bin"
mkdir -p "$MOCK_BIN"

make_mock_npm() {
  local exit_code="${1:-0}"
  cat > "$MOCK_BIN/npm" << EOF
#!/usr/bin/env bash
echo "mock-npm: \$*"
exit $exit_code
EOF
  chmod +x "$MOCK_BIN/npm"
}

make_mock_npm_with_binary() {
  # Creates a mock npm that also creates the expected binary and .vsix artifacts.
  cat > "$MOCK_BIN/npm" << 'EOF'
#!/usr/bin/env bash
echo "mock-npm: $*"
# Simulate 'npm run build' / 'npm run bundle -- --binary' by creating the binary
if [[ "$*" == *"bundle"* ]] || [[ "$*" == *"build"* ]]; then
  mkdir -p "$(pwd)/release"
  echo "#!/usr/bin/env node" > "$(pwd)/release/contextforge"
  chmod +x "$(pwd)/release/contextforge"
fi
# Simulate 'npm run package' by creating a .vsix file
if [[ "$*" == *"package"* ]]; then
  mkdir -p "$(pwd)"
  touch "$(pwd)/contextforge-0.1.0.vsix"
fi
exit 0
EOF
  chmod +x "$MOCK_BIN/npm"
}

# ── Tests: File properties ────────────────────────────────────────────────────

echo "=== build-dist.sh Tests ==="
echo ""
echo "--- File properties ---"

if [[ -f "$SCRIPT" ]]; then
  pass "script file exists"
else
  fail "script file exists"
fi

if [[ -x "$SCRIPT" ]]; then
  pass "script is executable"
else
  fail "script is executable"
fi

syntax_output=$(bash -n "$SCRIPT" 2>&1) && syntax_ok=$? || syntax_ok=$?
assert_eq "script has valid bash syntax" "0" "$syntax_ok"

# ── Tests: Output messages (mock npm that fails after the first message) ───────

echo ""
echo "--- Output messages ---"

make_mock_npm 1

# The header and step-1 message are printed before npm is called.
output=$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT" 2>&1 || true)

assert_contains "prints main header" "Building ContextForge Distribution Packages" "$output"
assert_contains "prints step 1 label" "Building MCP server binary" "$output"

# Step 2+ messages only appear after npm succeeds — ensure they're absent on npm failure.
if echo "$output" | grep -qF "Populating dist/agent"; then
  fail "step 2 message should not appear when npm fails"
else
  pass "step 2 message absent when npm fails"
fi

# ── Tests: Failure modes ──────────────────────────────────────────────────────

echo ""
echo "--- Failure modes ---"

# npm itself fails
make_mock_npm 1
output=$(PATH="$MOCK_BIN:$PATH" bash "$SCRIPT" 2>&1) && exit_code=$? || exit_code=$?
assert_ne "exits non-zero when npm fails" "0" "$exit_code"

# npm succeeds but no binary is produced — must use a clean fake repo
FAKE_REPO_NOBINARY="$TMPDIR_WORK/repo-nobinary"
mkdir -p "$FAKE_REPO_NOBINARY/scripts"
mkdir -p "$FAKE_REPO_NOBINARY/packages/core"
mkdir -p "$FAKE_REPO_NOBINARY/packages/vscode-extension"
cp "$SCRIPT" "$FAKE_REPO_NOBINARY/scripts/build-dist.sh"
chmod +x "$FAKE_REPO_NOBINARY/scripts/build-dist.sh"
make_mock_npm 0
output=$(PATH="$MOCK_BIN:$PATH" bash "$FAKE_REPO_NOBINARY/scripts/build-dist.sh" 2>&1) && exit_code=$? || exit_code=$?
assert_ne "exits non-zero when release binary is missing after build" "0" "$exit_code"

# ── Tests: Successful run (fully mocked) ──────────────────────────────────────

echo ""
echo "--- Successful run (mock npm) ---"

make_mock_npm_with_binary

# Redirect DIST_* to temp dirs so we don't pollute the real dist/
# The script hardcodes DIST paths relative to REPO_ROOT, so we use a temp REPO_ROOT overlay.
# We symlink or copy what the mock npm needs to find.

FAKE_REPO="$TMPDIR_WORK/repo"
mkdir -p "$FAKE_REPO/scripts"
mkdir -p "$FAKE_REPO/packages/core"
mkdir -p "$FAKE_REPO/packages/vscode-extension"
mkdir -p "$FAKE_REPO/packages/core/bundle/node_modules/better-sqlite3"
mkdir -p "$FAKE_REPO/packages/core/bundle/node_modules/@huggingface"

# Copy the real build-dist.sh into the fake repo so REPO_ROOT resolves correctly.
cp "$SCRIPT" "$FAKE_REPO/scripts/build-dist.sh"
chmod +x "$FAKE_REPO/scripts/build-dist.sh"

# The mock npm creates release/contextforge relative to cwd (packages/core or vscode-extension).
# build-dist.sh cds into $REPO_ROOT/packages/core before running npm.
output=$(PATH="$MOCK_BIN:$PATH" bash "$FAKE_REPO/scripts/build-dist.sh" 2>&1) && exit_code=$? || exit_code=$?

assert_eq "exits 0 when all steps succeed" "0" "$exit_code"
assert_contains "reports dist/agent/ ready" "dist/agent/ ready" "$output"
assert_contains "reports dist/vscode/ ready" "dist/vscode/ ready" "$output"
assert_contains "prints summary section" "Distribution packages ready" "$output"

# Verify dist structure was created
[[ -d "$FAKE_REPO/dist/agent" ]]  && pass "dist/agent/ directory created"  || fail "dist/agent/ directory created"
[[ -d "$FAKE_REPO/dist/vscode" ]] && pass "dist/vscode/ directory created" || fail "dist/vscode/ directory created"
[[ -x "$FAKE_REPO/dist/agent/contextforge" ]] && pass "dist/agent/contextforge is executable" || fail "dist/agent/contextforge is executable"

# ── Results ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
