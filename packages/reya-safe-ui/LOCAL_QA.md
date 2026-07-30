# Reya Cannon browser QA

This local profile connects Cannon's existing website presentation layer to the
reviewed Reya read clients. It reads current Reya mainnet state, but the browser
and loopback ingress expose no signing, staging, execution or transaction
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

Start the loopback-only ingress. It probes the server-side RPC URL for chain
`1729`, strips all browser-supplied identity headers, injects the local QA
identity for the source gateway, and allows only the reviewed RPC, source,
artifact, OP-registry and interactive-preview routes. The preview route accepts
one canonical request bound to the configured source commit, Safe, Cannonfile
and previous CID. It controls no path, RPC URL, signer or package resolution.
Staging routes are absent.
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

Open `http://127.0.0.1:3000`. Automatic preview currently requires the approved
immutable Cannonfile URL. The previous-package input accepts an exact CID or
`reya-omnibus:<version-or-latest>@main`; an OP Mainnet alias is resolved once
and the exact resulting version and CID are displayed.

Selecting **Preview Transactions to Queue** automatically rebuilds the pinned
Cannonfile against a fresh disposable Anvil fork of current Reya state. The
loopback runner loads only the server-configured immutable source closure and
CID-verified artifact cache, permits one build at a time, and returns the
ordered calls directly to the browser. No preview file is uploaded.

This interactive path deliberately uses current RPC state so it works with a
latest-only Reya endpoint. It is useful for operator review but is not
reproducible evidence: signing and staging remain disabled. The separate
`preview:local` CLI continues to require an exact readable finalized block and
remains the fail-closed reproducibility check. Production signing requires the
reviewed preview service to bind authenticated evidence to the source, selected
deployment CID, Safe and nonce.

Connecting a wallet is optional and read-only: it verifies that the selected
account is a current owner of the configured Safe. No typed-data signature,
staging write, publication, execution or transaction broadcast is available
from this UI.

The Safe staging backend and Valkey can be tested separately, but this
review-only browser slice does not connect to them. Reintroduce a staging route
only with the trusted preview worker and its independently reviewed
authorization binding.
