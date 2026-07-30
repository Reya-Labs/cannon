# Reya Cannon browser QA

This local profile connects Cannon's existing website presentation layer to the
reviewed Reya clients. Its default profile is review-only. An explicit local
canary can additionally connect a current Safe owner, sign the exact displayed
Safe EIP-712 payload and persist the proposal in a loopback staging backend.
Neither profile exposes execution or transaction broadcast.

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
export REYA_LOCAL_ARTIFACT_CACHE=/absolute/path/to/reya-cannon-artifacts
export REYA_LOCAL_SOURCE_REPOSITORY=/absolute/path/to/reya-deployments
```

Optional overrides:

```sh
# Enables mutable package aliases; exact artifact CIDs work without it.
export REYA_CANNON_OP_RPC_URL=<secret-op-mainnet-rpc-url>
# Defaults to this loopback origin.
export REYA_LOCAL_ARTIFACT_ORIGIN=http://127.0.0.1:8083
```

Keep proposal staging disabled unless the local staging canary is the intended
test:

```sh
export REYA_LOCAL_STAGING=disabled
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

Before starting the ingress, expose the deployed read-only `@usecannon/repo`
role through a loopback-only port forward on `127.0.0.1:8083`; it remains
backed by the approved Reya artifact store. The browser never receives
object-store credentials. The ingress permits only
browser-facing `POST /artifacts/api/v0/cat?arg=<CIDv0>`, proxies it to the
reader's `POST /api/v0/cat?arg=<CIDv0>`, checks the response media type and
size, and the browser independently recomputes the content CID.

The local-QA artifact fixture also pins the known EOA-produced partial
deployment and its complete transitive artifact closure. Hydration accepts a
partial root only on Reya chain `1729`; all imported deployments must still be
complete and every byte is verified against its CID before the cache inventory
is sealed.

Start the loopback-only ingress. It probes the server-side RPC URL for chain
`1729`, strips all browser-supplied identity headers, injects the local QA
identity for the source gateway, and allows only the reviewed RPC, source,
artifact, OP-registry and interactive-preview routes. The preview route accepts
one canonical request bound to the configured or fixture-pinned source commit,
Safe, optional partial deployment CID and previous-package CID. For a partial
deployment, the runner loads the exact source commit authenticated by the
artifact, verifies its pinned bundle digest, checks that the assembled
Cannonfile definition exactly equals the artifact definition, and resumes from
the partial state. It controls no path, RPC URL, signer or package resolution.
The staging route is absent unless the local canary is explicitly enabled.
`REYA_CANNON_OP_RPC_URL` is optional at process startup; when absent, package
aliases fail closed while exact CID reads continue to work:

```sh
pnpm --filter @reya/cannon-safe-ui local:ingress
```

Build the constrained website export, scan it, then serve it:

```sh
pnpm --filter @reya/cannon-safe-website build
pnpm --filter @reya/cannon-safe-website scan
pnpm --filter @reya/cannon-safe-website serve
```

Open `http://127.0.0.1:3000`. The deployment input accepts either the approved
immutable Cannonfile URL or a fixture-pinned partial deployment CID. The
optional Cannonfile field shown for a CID is a comparison aid and, when
supplied, must exactly match the repository and commit embedded in the partial
artifact. The previous-package input remains separate and accepts an exact CID
or `reya-omnibus:<version-or-latest>@main`; an OP Mainnet alias is resolved once
and the exact resulting version and CID are displayed.

Selecting **Preview Transactions to Queue** automatically builds the pinned
Cannonfile from the previous complete package, or resumes the authenticated
partial state produced by the EOA, against a fresh disposable Anvil fork of
current Reya state. The loopback runner loads only manifest-pinned immutable
source closures and its CID-verified artifact cache, permits one build at a
time, and returns the ordered calls directly to the browser. No preview file is
uploaded.

This interactive path deliberately uses current RPC state so it works with a
latest-only Reya endpoint. It is useful for operator review but is not
reproducible evidence. The separate `preview:local` CLI continues to require an
exact readable finalized block and remains the fail-closed reproducibility
check. Production signing still requires the deployed preview service to bind
authenticated evidence to the source, selected deployment CID, Safe and nonce.

The review-only profile can connect a wallet only to verify that the selected
account is a current owner of the configured Safe. It exposes no typed-data
signature or staging write. The generated review JSON is an unsigned,
shareable evidence packet; it contains no wallet address or signature, and
importing it can never authorize signing or staging.

## Explicit local proposal-staging canary

Use a test Safe first. Enabling this profile permits the selected Safe owner to
create a real EIP-712 signature and writes that signed proposal to the
disposable local backend. It does not publish a Cannon package, execute a Safe
transaction, or broadcast anything to Reya.

Start a disposable loopback Valkey-compatible Redis and the staging backend.
Use a fresh proxy secret shared only with the source gateway, backend and local
ingress. Keep the RPC URL and secret in environment injection rather than
command arguments or committed files:

```sh
redis-server \
  --bind 127.0.0.1 \
  --port 16379 \
  --protected-mode yes \
  --save "" \
  --appendonly no

ADMISSION_MODE=safe-owner \
REDIS_URL=redis://127.0.0.1:16379 \
REDIS_MIN_REPLICAS=0 \
RPC_URLS="1729=${REYA_CANNON_QA_RPC_URL}" \
SAFE_ALLOWLIST="1729:${REYA_LOCAL_SAFE_ADDRESS}" \
CORS_ORIGINS="${REYA_LOCAL_UI_ORIGIN}" \
AUTH_PROXY_SECRET="${REYA_LOCAL_AUTH_PROXY_SECRET}" \
TRUST_PROXY=false \
PORT=18084 \
pnpm --filter backend start
```

Then opt both the constrained website build and the ingress into the one exact
loopback staging origin:

```sh
export REYA_LOCAL_STAGING=enabled
export REYA_LOCAL_STAGING_ORIGIN=http://127.0.0.1:18084

pnpm --filter @reya/cannon-safe-ui local:ingress
pnpm --filter @reya/cannon-safe-website build
pnpm --filter @reya/cannon-safe-website scan
pnpm --filter @reya/cannon-safe-website serve
```

Before the wallet opens, the page recomputes the full preview and current Safe
state. Any difference in source, package CIDs, ordered calls, Safe address,
nonce or `safeTxHash` replaces the displayed preview and requires a fresh
review acknowledgement. The signer permits only `eth_signTypedData_v4` for the
exact displayed payload. The staging client submits once and never
automatically retries an ambiguous mutation.

The ingress permits only `GET` and `POST` on the configured
`/staging/1729/<safe>` route. It supplies the local identity and proposer role
server-side and rejects alternate Safes, supersession and browser-supplied
identity headers. Disable the canary again after QA:

```sh
export REYA_LOCAL_STAGING=disabled
unset REYA_LOCAL_STAGING_ORIGIN
```

This is local proposal-staging evidence, not production activation approval.
Production still requires the reviewed workload identities, exact-origin
access path, durable Valkey, source/artifact services, recovery rehearsal and a
separate activation decision.
