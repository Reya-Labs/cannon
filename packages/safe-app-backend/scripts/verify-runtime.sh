#!/bin/sh

set -eu

test "$(id -u)" -ne 0
test -n "${EXPECTED_BUILD_REVISION:-}"
test "${BUILD_REVISION:-}" = "${EXPECTED_BUILD_REVISION}"
test -n "${EXPECTED_SOURCE_DATE_EPOCH:-}"
test "${SOURCE_DATE_EPOCH:-}" = "${EXPECTED_SOURCE_DATE_EPOCH}"

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

for package_name in \
  esbuild \
  prettier \
  rollup \
  supertest \
  ts-node \
  tsup \
  tsx \
  typescript \
  vite \
  vitest \
  webpack
do
  if find node_modules -type f -path "*/${package_name}/package.json" -print -quit 2>/dev/null | grep -q .; then
    echo "unexpected build or test package in runtime image: ${package_name}" >&2
    exit 1
  fi
done

for scoped_package_path in '@esbuild/*/package.json' '@types/*/package.json' '@vitest/*/package.json'; do
  if find node_modules -type f -path "*/${scoped_package_path}" -print -quit 2>/dev/null | grep -q .; then
    echo "unexpected build or test package in runtime image: ${scoped_package_path}" >&2
    exit 1
  fi
done

node --check dist/server.js
node -e 'require("./dist/server.js")'
