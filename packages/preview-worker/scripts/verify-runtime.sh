#!/bin/sh

set -eu

test "$(id -u)" -ne 0
test -n "${EXPECTED_BUILD_REVISION:-}"
test "${BUILD_REVISION:-}" = "${EXPECTED_BUILD_REVISION}"
test -n "${EXPECTED_SOURCE_DATE_EPOCH:-}"
test "${SOURCE_DATE_EPOCH:-}" = "${EXPECTED_SOURCE_DATE_EPOCH}"
test "$(node --version)" = "v22.23.1"

for command_name in npm npx corepack yarn pnpm; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    echo "unexpected package manager in runtime image: ${command_name}" >&2
    exit 1
  fi
done

for package_name in prettier supertest typescript vite vitest; do
  if find node_modules -type f -path "*/${package_name}/package.json" -print -quit 2>/dev/null | grep -q .; then
    echo "unexpected build or test package in runtime image: ${package_name}" >&2
    exit 1
  fi
done

for scoped_package_path in '@types/*/package.json' '@vitest/*/package.json'; do
  if find node_modules -type f -path "*/${scoped_package_path}" -print -quit 2>/dev/null | grep -q .; then
    echo "unexpected build or test package in runtime image: ${scoped_package_path}" >&2
    exit 1
  fi
done

# This image is the `disabled`-mode worker, and that is a property to verify
# rather than assume. A `fork` worker needs the Cannon engine and the pinned
# Foundry build; if either ever arrives here silently, the image would start
# serving previews from a path this build never scanned or reviewed.
for engine_directory in \
  node_modules/@reya/cannon-safe-ui \
  node_modules/@usecannon/artifact-codec
do
  if [ -e "${engine_directory}" ]; then
    echo "unexpected preview engine in the disabled-mode image: ${engine_directory}" >&2
    exit 1
  fi
done

for command_name in anvil forge cast; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    echo "unexpected Foundry runtime in the disabled-mode image: ${command_name}" >&2
    exit 1
  fi
done

node --check src/server.mjs

# `loadPreviewEngine` is the exact call a `fork` worker makes before it opens a
# socket. Asserting that it rejects here proves the image fails closed instead
# of starting degraded, which is the claim the scope decision rests on.
node --input-type=module -e '
  const { loadPreviewEngine } = await import("/usr/app/src/simulator/engine.mjs");
  try {
    await loadPreviewEngine();
  } catch {
    process.exit(0);
  }
  console.error("preview engine unexpectedly resolved in the disabled-mode image");
  process.exit(1);
'

# Importing the entry point proves the module graph resolves without the engine.
# `server.mjs` only self-starts when it is argv[1], so this never opens a socket.
node --input-type=module -e 'await import("/usr/app/src/server.mjs");'
