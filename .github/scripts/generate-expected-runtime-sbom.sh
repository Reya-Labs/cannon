#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 SOURCE_DIRECTORY EXPECTED_REVISION RUNTIME OUTPUT_SBOM" >&2
  exit 2
fi

readonly requested_source_directory=$1
readonly expected_revision=$2
readonly runtime_kind=$3
readonly requested_output=$4
readonly node_image='docker.io/library/node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2'
readonly pnpm_version='10.11.0'
readonly pnpm_sha512='6540583f41cc5f628eb3d9773ecee802f4f9ef9923cc45b69890fb47991d4b092964694ec3a4f738a420c918a333062c8b925d312f42e4f0c263eb603551f977'

case "$runtime_kind" in
  repo|indexer|api) ;;
  *)
    echo "expected bundle-input generation is unsupported for: $runtime_kind" >&2
    exit 2
    ;;
esac

if [[ ! "$expected_revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected revision must be a lowercase 40-character Git revision" >&2
  exit 2
fi

source_directory=$(cd "$requested_source_directory" && pwd -P)
readonly source_directory
if [[ "$(git -C "$source_directory" rev-parse HEAD)" != "$expected_revision" ]]; then
  echo "checked-out source does not match the expected revision" >&2
  exit 1
fi

output_parent=$(dirname "$requested_output")
mkdir -p "$output_parent"
output_parent=$(cd "$output_parent" && pwd -P)
readonly output_parent
output_path="${output_parent}/$(basename "$requested_output")"
readonly output_path

policy_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly policy_directory
readonly generator="${policy_directory}/generate-bundle-input-sbom.mjs"
readonly bundle_input_verifier="${policy_directory}/verify-runtime-bundle-input.mjs"
test -f "$generator"
test -r "$generator"
test -f "$bundle_input_verifier"
test -r "$bundle_input_verifier"

runner_uid=$(id -u)
runner_gid=$(id -g)
readonly runner_uid
readonly runner_gid
if ((runner_uid == 0)); then
  echo "expected bundle-input generation must run as an unprivileged host user" >&2
  exit 2
fi

temporary_directory=$(
  mktemp -d "${output_parent}/.expected-runtime-sbom.XXXXXX"
)
readonly temporary_directory
readonly workspace="${temporary_directory}/source"
readonly expected_directory="${temporary_directory}/expected"
mkdir "$workspace" "$expected_directory"

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

git -C "$source_directory" archive --format=tar "$expected_revision" |
  tar -xf - -C "$workspace"

# The runtime Dockerfiles copy only the reviewed lockfile, workspace file, root
# manifest and selected package manifests before install. Source-only pnpm hook
# and npm configuration files must therefore not gain influence here.
find "$workspace" \
  \( -type f -o -type l \) \
  \( -name .npmrc -o -name .pnpmfile.cjs -o -name pnpmfile.cjs \) \
  -delete

docker run --rm \
  --platform linux/amd64 \
  --user "${runner_uid}:${runner_gid}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=2g,uid=${runner_uid},gid=${runner_gid},mode=1770" \
  --volume "${workspace}:/workspace:rw" \
  --volume "${expected_directory}:/expected:rw" \
  --volume "${generator}:/policy/generate-bundle-input-sbom.mjs:ro" \
  --workdir /workspace \
  --env "COREPACK_HOME=/tmp/corepack" \
  --env "NPM_CONFIG_GLOBALCONFIG=/tmp/pnpm-globalconfig" \
  --env "NPM_CONFIG_USERCONFIG=/tmp/pnpm-userconfig" \
  --env "PNPM_SHA512=${pnpm_sha512}" \
  --env "PNPM_HOME=/tmp/pnpm-home" \
  --env "PNPM_VERSION=${pnpm_version}" \
  --env "RUNTIME_KIND=${runtime_kind}" \
  --env "TARGET_PACKAGE=@usecannon/${runtime_kind}" \
  --env "XDG_CACHE_HOME=/tmp/cache" \
  "$node_image" \
  /bin/sh -euc '
    mkdir -p "$COREPACK_HOME" "$PNPM_HOME" "$XDG_CACHE_HOME"
    : > "$NPM_CONFIG_USERCONFIG"
    : > "$NPM_CONFIG_GLOBALCONFIG"
    corepack prepare "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}" --activate
    test "$(corepack pnpm --version)" = "$PNPM_VERSION"
    corepack pnpm \
      --filter "${TARGET_PACKAGE}..." \
      install \
      --frozen-lockfile \
      --ignore-pnpmfile \
      --ignore-scripts \
      --no-optional \
      --store-dir /tmp/pnpm-store
    corepack pnpm \
      --config.ignore-pnpmfile=true \
      --filter "$TARGET_PACKAGE" \
      list \
      --prod \
      --no-optional \
      --depth Infinity \
      --json \
      > /tmp/bundle-input-dependencies.json
    component_version="$(
      node -p "require(\"./packages/${RUNTIME_KIND}/package.json\").version"
    )"
    node /policy/generate-bundle-input-sbom.mjs \
      /workspace \
      /tmp/bundle-input-dependencies.json \
      /expected/bundle-input-dependencies.cdx.json \
      "$TARGET_PACKAGE" \
      "$component_version"
  '

test -s "${expected_directory}/bundle-input-dependencies.cdx.json"
install \
  -m 0444 \
  "${expected_directory}/bundle-input-dependencies.cdx.json" \
  "$output_path"
output_digest=$(
  node "$bundle_input_verifier" "$output_path" "$output_path"
)
readonly output_digest
printf '%s  %s\n' "$output_digest" "$output_path"
