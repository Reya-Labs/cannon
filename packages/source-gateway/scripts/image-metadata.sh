#!/usr/bin/env bash

set -Eeuo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <git-revision>" >&2
  exit 64
fi

revision=$(git rev-parse --verify "$1^{commit}")
if [[ ! "${revision}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "git revision must resolve to a full lowercase SHA-1" >&2
  exit 1
fi

version=$(
  sed -nE \
    's/^[[:space:]]*"version":[[:space:]]*"([^"]+)",?[[:space:]]*$/\1/p' \
    packages/source-gateway/package.json
)
if [[ ! "${version}" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]*$ ]]; then
  echo "source-gateway package version is missing or invalid" >&2
  exit 1
fi

source_date_epoch=$(git show -s --format=%ct "${revision}")
if [[ ! "${source_date_epoch}" =~ ^[0-9]+$ ]]; then
  echo "git commit timestamp is missing or invalid" >&2
  exit 1
fi

if date --version >/dev/null 2>&1; then
  build_date=$(date -u --date="@${source_date_epoch}" '+%Y-%m-%dT%H:%M:%SZ')
else
  build_date=$(date -u -r "${source_date_epoch}" '+%Y-%m-%dT%H:%M:%SZ')
fi

printf 'version=%s\n' "${version}"
printf 'revision=%s\n' "${revision}"
printf 'build_date=%s\n' "${build_date}"
printf 'source_date_epoch=%s\n' "${source_date_epoch}"
