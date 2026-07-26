#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <image-ref>" >&2
  exit 64
fi

: "${EXPECTED_BUILD_REVISION:?EXPECTED_BUILD_REVISION must be set}"

image_ref=$1
run_key="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-manual}-$$"
container_name="safe-app-backend-verify-${run_key//[^a-zA-Z0-9_.-]/-}"

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

timeout --signal=TERM --kill-after=10s 60s \
  docker run --name "${container_name}" --rm \
  --env EXPECTED_BUILD_REVISION \
  --entrypoint /usr/local/bin/verify-runtime \
  "${image_ref}"
