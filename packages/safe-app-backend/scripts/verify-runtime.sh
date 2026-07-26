#!/bin/sh

set -eu

test "$(id -u)" -ne 0
test -n "${EXPECTED_BUILD_REVISION:-}"
test "${BUILD_REVISION:-}" = "${EXPECTED_BUILD_REVISION}"

for command_name in npm npx corepack yarn pnpm; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    echo "unexpected package manager in runtime image: ${command_name}" >&2
    exit 1
  fi
done

if find /opt -maxdepth 1 -type d -name 'yarn-v*' -print -quit 2>/dev/null | grep -q .; then
  echo "unexpected Yarn installation in runtime image" >&2
  exit 1
fi

node --check dist/server.js
node -e 'require("./dist/server.js")'
