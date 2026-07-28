#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <image-ref>" >&2
  exit 64
fi

image_ref=$1
run_key="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-manual}-$$"
run_key="${run_key//[^a-zA-Z0-9_.-]/-}"
bad_label_image="safe-app-backend:bad-label-${run_key}"
bad_toolchain_image="safe-app-backend:bad-toolchain-${run_key}"

cleanup() {
  docker image rm --force "${bad_label_image}" "${bad_toolchain_image}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

bash packages/safe-app-backend/scripts/verify-image.sh "${image_ref}"

if EXPECTED_BUILD_REVISION=0000000000000000000000000000000000000000 \
  bash packages/safe-app-backend/scripts/verify-image.sh "${image_ref}"; then
  echo "image verification accepted the wrong revision" >&2
  exit 1
fi

printf '%s\n' \
  'ARG BASE_IMAGE=safe-app-backend:ci' \
  "FROM \${BASE_IMAGE}" \
  'LABEL org.opencontainers.image.created="1970-01-01T00:00:00Z"' |
  docker build \
    --build-arg "BASE_IMAGE=${image_ref}" \
    --file - \
    --tag "${bad_label_image}" \
    packages/safe-app-backend

if bash packages/safe-app-backend/scripts/verify-image.sh "${bad_label_image}"; then
  echo "image verification accepted the wrong creation timestamp" >&2
  exit 1
fi

printf '%s\n' \
  'ARG BASE_IMAGE=safe-app-backend:ci' \
  "FROM \${BASE_IMAGE}" \
  'USER root' \
  'RUN mkdir -p /usr/app/node_modules/typescript && touch /usr/app/node_modules/typescript/package.json' \
  'USER node' |
  docker build \
    --build-arg "BASE_IMAGE=${image_ref}" \
    --file - \
    --tag "${bad_toolchain_image}" \
    packages/safe-app-backend

if bash packages/safe-app-backend/scripts/verify-image.sh "${bad_toolchain_image}"; then
  echo "runtime verification accepted a TypeScript toolchain" >&2
  exit 1
fi
