#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 5 || $# -gt 6 ]]; then
  echo "usage: $0 IMAGE EXPECTED_SOURCE EXPECTED_REVISION EXPECTED_VERSION EXPECTED_CMD_JSON [EXPECTED_CREATED]" >&2
  exit 2
fi

image_ref=$1
expected_source=$2
expected_revision=$3
expected_version=$4
expected_command=$5
expected_created=${6:-}

expected_entry_file=$(
  jq -er '
    if
      type == "array" and
      length == 2 and
      .[0] == "node" and
      (.[1] | type) == "string" and
      (.[1] | length) > 0
    then
      .[1]
    else
      error("expected command must be [\"node\",\"RELATIVE_ENTRY_FILE\"]")
    end
  ' <<<"$expected_command"
)
if [[ ! "$expected_entry_file" =~ ^[A-Za-z0-9_./-]+$ ]]; then
  echo "expected entry file contains unsupported characters" >&2
  exit 1
fi
case "/${expected_entry_file}/" in
  */../*|*/./*|/*//*)
    echo "expected entry file must be a normalized relative path" >&2
    exit 1
    ;;
esac
if [[ "$expected_entry_file" == /* ]]; then
  echo "expected entry file must be relative to /usr/app" >&2
  exit 1
fi

inspect_json=$(docker image inspect "$image_ref")

assert_json_value() {
  local expression=$1
  local expected=$2
  local actual

  actual=$(jq -er "$expression" <<<"$inspect_json")
  if [[ "$actual" != "$expected" ]]; then
    echo "image contract mismatch for ${expression}: expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

assert_json_value '.[0].Os + "/" + .[0].Architecture' 'linux/amd64'
assert_json_value '.[0].Config.User' 'node'
assert_json_value '.[0].Config.Labels["org.opencontainers.image.source"]' "$expected_source"
assert_json_value '.[0].Config.Labels["org.opencontainers.image.revision"]' "$expected_revision"
assert_json_value '.[0].Config.Labels["org.opencontainers.image.version"]' "$expected_version"
assert_json_value '.[0].Config.Labels["org.opencontainers.image.base.name"]' 'docker.io/library/alpine:3.24.1'
assert_json_value \
  '.[0].Config.Labels["org.opencontainers.image.base.digest"]' \
  'sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b'
assert_json_value \
  '.[0].Config.Labels["io.reya.cannon.runtime.node.name"]' \
  'docker.io/library/node:22.23.1-alpine3.24'
assert_json_value \
  '.[0].Config.Labels["io.reya.cannon.runtime.node.digest"]' \
  'sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2'
assert_json_value '.[0].Config.Entrypoint | @json' '["/usr/local/bin/docker-entrypoint.sh"]'
assert_json_value '.[0].Config.Cmd | @json' "$expected_command"

if [[ -n "$expected_created" ]]; then
  assert_json_value '.[0].Config.Labels["org.opencontainers.image.created"]' "$expected_created"
fi

container_id=$(docker create "$image_ref")
cleanup() {
  docker rm --force "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

resolved_path=$(docker container inspect --format '{{.Path}}' "$container_id")
resolved_args=$(docker container inspect --format '{{json .Args}}' "$container_id")
if [[ "$resolved_path" != '/usr/local/bin/docker-entrypoint.sh' || "$resolved_args" != "$expected_command" ]]; then
  echo "resolved default command does not match the reviewed entrypoint and arguments" >&2
  exit 1
fi

docker run --rm \
  --platform linux/amd64 \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --env "EXPECTED_ENTRY_FILE=${expected_entry_file}" \
  --entrypoint /bin/sh \
  "$image_ref" -euc '
  test "$(id -u)" = "1000"
  test "$(id -g)" = "1000"
  test "$(node --version)" = "v22.23.1"
  test "$(node -p "process.platform + \"/\" + process.arch")" = "linux/x64"
  test -f "/usr/app/${EXPECTED_ENTRY_FILE}"
  test -r "/usr/app/${EXPECTED_ENTRY_FILE}"
  node --check "/usr/app/${EXPECTED_ENTRY_FILE}"
  for tool in npm npx pnpm corepack yarn yarnpkg; do
    ! command -v "$tool" >/dev/null 2>&1
  done
  test ! -d /usr/local/lib/node_modules/npm
  test ! -e /opt/yarn-v1.22.22
  test -z "$(find / -xdev -type f -perm /6000 -print -quit 2>/dev/null)"
'
