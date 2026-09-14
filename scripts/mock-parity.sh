#!/usr/bin/env bash
# Degraded-run parity check for #2: one full pass driven by mock agents in a
# throwaway clone. Never spawns a real agent; never pushes anywhere.
set -uo pipefail
REPO_DIR=$(git rev-parse --show-toplevel)
WORK=${MOCK_WORK:-/tmp/opencode/iteration-parity}
rm -rf "$WORK"
mkdir -p "$WORK"
git clone -q "$REPO_DIR" "$WORK/repo" || exit 2
git -C "$WORK/repo" remote set-url origin "$(git -C "$REPO_DIR" remote get-url origin)"
cd "$WORK/repo" || exit 2
BIN="$REPO_DIR/bin/iteration.js"
export MOCK_STATE_FILE="$WORK/mock-state.json"
export ITERATION_AGENT_CMD="$REPO_DIR/scripts/mock-agent.js"
export MOCK_COUNTS="$WORK/gh-counts.log"

mkdir -p "$WORK/shim"
REAL_GH=$(command -v gh)
cat > "$WORK/shim/gh" <<SHIM
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >> "${MOCK_COUNTS:?}"
exec "$REAL_GH" "\$@"
SHIM
chmod +x "$WORK/shim/gh"
export PATH="$WORK/shim:$PATH"

node "$BIN" --once 2>&1 | tee "$WORK/run.log" | tail -20
rc=${PIPESTATUS[0]}
echo "exit=$rc"
echo "--- gh shim calls (must be ~1: the gh auth token read) ---"
cat "$MOCK_COUNTS"
echo "--- retry + submit evidence ---"
grep -E "retry|submitted via" "$WORK/run.log" || true
