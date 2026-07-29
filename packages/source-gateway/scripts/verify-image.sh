#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <image-ref>" >&2
  exit 64
fi

: "${EXPECTED_BASE_DIGEST:?EXPECTED_BASE_DIGEST must be set}"
: "${EXPECTED_BASE_NAME:?EXPECTED_BASE_NAME must be set}"
: "${EXPECTED_BUILD_DATE:?EXPECTED_BUILD_DATE must be set}"
: "${EXPECTED_BUILD_REVISION:?EXPECTED_BUILD_REVISION must be set}"
: "${EXPECTED_SOURCE:?EXPECTED_SOURCE must be set}"
: "${EXPECTED_SOURCE_DATE_EPOCH:?EXPECTED_SOURCE_DATE_EPOCH must be set}"
: "${EXPECTED_VERSION:?EXPECTED_VERSION must be set}"

image_ref=$1
run_key="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-manual}-$$"
container_name="source-gateway-verify-${run_key//[^a-zA-Z0-9_.-]/-}"

assert_label() {
  local label_key=$1
  local expected_value=$2
  local actual_value

  actual_value=$(
    docker image inspect \
      --format "{{ index .Config.Labels \"${label_key}\" }}" \
      "${image_ref}"
  )
  if [[ "${actual_value}" != "${expected_value}" ]]; then
    echo "unexpected ${label_key}: expected ${expected_value}, got ${actual_value}" >&2
    return 1
  fi
}

cleanup() {
  docker rm --force "${container_name}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

assert_label org.opencontainers.image.base.digest "${EXPECTED_BASE_DIGEST}"
assert_label org.opencontainers.image.base.name "${EXPECTED_BASE_NAME}"
assert_label org.opencontainers.image.created "${EXPECTED_BUILD_DATE}"
assert_label org.opencontainers.image.licenses GPL-3.0
assert_label org.opencontainers.image.revision "${EXPECTED_BUILD_REVISION}"
assert_label org.opencontainers.image.source "${EXPECTED_SOURCE}"
assert_label org.opencontainers.image.version "${EXPECTED_VERSION}"

docker create --name "${container_name}" \
  --env EXPECTED_BUILD_REVISION \
  --env EXPECTED_SOURCE_DATE_EPOCH \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 64 \
  --entrypoint /usr/local/bin/verify-runtime \
  "${image_ref}" >/dev/null
docker start "${container_name}" >/dev/null

deadline=$((SECONDS + 60))
while [[ "$(docker inspect --format '{{.State.Running}}' "${container_name}")" == "true" ]]; do
  if ((SECONDS >= deadline)); then
    echo "runtime verification exceeded 60 seconds" >&2
    exit 124
  fi
  sleep 1
done

docker logs "${container_name}"
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "${container_name}")
if [[ "${exit_code}" -ne 0 ]]; then
  echo "runtime verification failed with exit code ${exit_code}" >&2
  exit "${exit_code}"
fi
