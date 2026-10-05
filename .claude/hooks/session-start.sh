#!/bin/bash
# Gets a fresh Claude Code on the web session ready to run the tests:
# installs the test tools and the Cloud Functions packages, downloads the
# Firebase emulators, and points Playwright at the browser that's already
# in the container. Safe to run more than once.
set -euo pipefail

# Only in the cloud sessions - a laptop/desktop is set up by hand.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Test tools (Playwright, Firebase emulator CLI, rules testing).
# npm install (not ci) so the container cache is reused between sessions.
(cd tests && npm install --no-audit --no-fund)

# functions.test.js loads functions/index.js with its own packages.
(cd functions && npm install --no-audit --no-fund --no-package-lock)

# The emulators the tests use. Downloaded once and cached; a failed download
# isn't fatal - `npm test` fetches them itself if needed.
(cd tests && npx --no-install firebase setup:emulators:firestore >/dev/null 2>&1) || echo "Couldn't pre-download the Firestore emulator; npm test will fetch it."
(cd tests && npx --no-install firebase setup:emulators:storage >/dev/null 2>&1) || echo "Couldn't pre-download the Storage emulator; npm test will fetch it."

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  # Use the Chromium the container already has (never `playwright install`).
  if [ -x /opt/pw-browsers/chromium ]; then
    echo 'export CHROMIUM_PATH=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
  fi
  # So `firebase` works from anywhere in the repo.
  echo "export PATH=\"$CLAUDE_PROJECT_DIR/tests/node_modules/.bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

echo "Session ready: run the tests with  cd tests && npm test"
