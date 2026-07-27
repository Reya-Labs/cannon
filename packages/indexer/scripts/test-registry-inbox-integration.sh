#!/usr/bin/env bash
set -euo pipefail

REDIS_IMAGE="redis:8.6.5-alpine@sha256:58114ad49688e1bbfc1987829eae6be8446f5b608f0c9652af4a3a94833d551c"
CONTAINER_NAME="cannon-registry-inbox-test-${RANDOM}-$$"
VOLUME_NAME="${CONTAINER_NAME}-data"
PERSISTENCE_STATE_KEY="cannon:registry:v2:{cannon-registry-v2:72200001}:state"
PERSISTENCE_STREAM_KEY="cannon:registry:v2:{cannon-registry-v2:72200001}:inbox"

cleanup() {
  docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker volume rm "${VOLUME_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker pull --platform linux/amd64 "${REDIS_IMAGE}" >/dev/null
docker volume create "${VOLUME_NAME}" >/dev/null
docker run \
  --detach \
  --platform linux/amd64 \
  --name "${CONTAINER_NAME}" \
  --publish 127.0.0.1::6379 \
  --volume "${VOLUME_NAME}:/data" \
  "${REDIS_IMAGE}" \
  redis-server \
  --appendonly yes \
  --appendfsync everysec \
  --save "60 1" \
  --maxmemory-policy noeviction \
  >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" redis-cli ping 2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 1
done
docker exec "${CONTAINER_NAME}" redis-cli ping | grep -qx PONG

PORT_LINE="$(docker port "${CONTAINER_NAME}" 6379/tcp)"
REDIS_PORT="${PORT_LINE##*:}"
export REGISTRY_INBOX_TEST_REDIS_URL="redis://127.0.0.1:${REDIS_PORT}"

wait_for_host_redis() {
  for _ in $(seq 1 30); do
    if node --require ts-node/register scripts/registry-inbox-persistence-probe.ts wait >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  node --require ts-node/register scripts/registry-inbox-persistence-probe.ts wait
}

wait_for_host_redis
node --test --require ts-node/register test/registry-inbox.integration.test.ts
node --require ts-node/register scripts/registry-inbox-persistence-probe.ts seed
STATE_BEFORE_RESTART="$(docker exec "${CONTAINER_NAME}" redis-cli --raw GET "${PERSISTENCE_STATE_KEY}")"
STREAM_BEFORE_RESTART="$(docker exec "${CONTAINER_NAME}" redis-cli --raw XRANGE "${PERSISTENCE_STREAM_KEY}" - +)"
test -n "${STATE_BEFORE_RESTART}"
test -n "${STREAM_BEFORE_RESTART}"
docker stop --time 30 "${CONTAINER_NAME}" >/dev/null
docker start "${CONTAINER_NAME}" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" redis-cli ping 2>/dev/null | grep -qx PONG; then
    break
  fi
  sleep 1
done
docker exec "${CONTAINER_NAME}" redis-cli ping | grep -qx PONG
STATE_AFTER_RESTART="$(docker exec "${CONTAINER_NAME}" redis-cli --raw GET "${PERSISTENCE_STATE_KEY}")"
STREAM_AFTER_RESTART="$(docker exec "${CONTAINER_NAME}" redis-cli --raw XRANGE "${PERSISTENCE_STREAM_KEY}" - +)"
if [[ "${STATE_AFTER_RESTART}" != "${STATE_BEFORE_RESTART}" || "${STREAM_AFTER_RESTART}" != "${STREAM_BEFORE_RESTART}" ]]; then
  echo "registry inbox persistence verification failed" >&2
  exit 1
fi
docker exec "${CONTAINER_NAME}" redis-cli DEL "${PERSISTENCE_STATE_KEY}" "${PERSISTENCE_STREAM_KEY}" >/dev/null
