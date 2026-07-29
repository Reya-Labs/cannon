# Reya Cannon browser QA

This local profile connects Cannon's existing website presentation layer to the
reviewed Reya clients, a local Safe staging backend and disposable Valkey. It
reads current Reya mainnet state, but it has no execution or transaction
broadcast method.

Use the repository-pinned Node `22.23.1` and pnpm `10.11.0`. Keep the RPC URL
and proxy secret in a secret-safe shell environment; do not put either value in
an `.env` file, command argument, Git history or terminal transcript.

Required operator values:

```sh
export REYA_LOCAL_SAFE_ADDRESS=<approved-lowercase-reya-safe>
export REYA_LOCAL_SOURCE_COMMIT=<reviewed-lowercase-full-commit>
export REYA_LOCAL_AUTH_PROXY_SECRET=<random-secret-at-least-32-bytes>
export REYA_LOCAL_IDENTITY=<stable-local-qa-identity>
export REYA_CANNON_QA_RPC_URL=<secret-reya-rpc-url>
export REYA_LOCAL_UI_ORIGIN=http://127.0.0.1:3000
export REYA_LOCAL_INGRESS_ORIGIN=http://127.0.0.1:8787
```

Start a disposable Redis/Valkey on `127.0.0.1:6379`, then build and run the
backend on a separate terminal:

```sh
pnpm --filter backend build

ADMISSION_MODE=safe-owner \
REDIS_URL=redis://127.0.0.1:6379 \
REDIS_MIN_REPLICAS=0 \
REDIS_PREFIX=cannon-local-qa \
RPC_URLS="1729=${REYA_CANNON_QA_RPC_URL}" \
SAFE_ALLOWLIST="1729:${REYA_LOCAL_SAFE_ADDRESS}" \
CORS_ORIGINS="${REYA_LOCAL_UI_ORIGIN}" \
AUTH_PROXY_SECRET="${REYA_LOCAL_AUTH_PROXY_SECRET}" \
PORT=8081 \
pnpm --filter backend start
```

Build the standalone source gateway once, then run it on another terminal:

```sh
pnpm --dir packages/source-gateway --ignore-workspace install \
  --frozen-lockfile --ignore-scripts
pnpm --dir packages/source-gateway build

AUTH_PROXY_SECRET="${REYA_LOCAL_AUTH_PROXY_SECRET}" \
SOURCE_UI_ORIGIN="${REYA_LOCAL_UI_ORIGIN}" \
PORT=8082 \
pnpm --dir packages/source-gateway start
```

Start the loopback-only ingress. It probes the server-side RPC URL for chain
`1729`, strips all browser-supplied identity headers, injects the local QA
identity for the two backends, and allows only the reviewed RPC, source,
and staging routes:

```sh
pnpm --filter @reya/cannon-safe-ui local:ingress
```

Build the constrained website export, scan it, then serve it:

```sh
pnpm --filter @reya/cannon-safe-website build
pnpm --filter @reya/cannon-safe-website scan
pnpm --filter @reya/cannon-safe-website serve
```

Open `http://127.0.0.1:3000`. Import only a preview JSON created by
`preview:local` from the same Safe and source commit. The browser verifies the
source-bundle digest before enabling signing. Any deployer prerequisite keeps
the stage action disabled.

Connecting a wallet is safe for read-only inspection. Clicking **Sign and
stage locally** asks the wallet for a genuine, portable Reya-mainnet Safe
signature and stores it in local Valkey. It does not execute or broadcast the
transaction, but the signature must still be treated as production-sensitive.
