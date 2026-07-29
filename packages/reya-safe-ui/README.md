# Reya Cannon Safe UI

This package builds the deliberately disabled first release of Reya's self-hosted Cannon signer UI. It is a
standalone static export and does not import the generic Cannon website.

The shell has no client-side JavaScript, wallet integration, RPC, staging API, artifact, Git, IPFS, analytics, or
telemetry dependency. It cannot stage, sign, or submit a transaction. Activation belongs in a later reviewed change
that supplies the approved Safe and Reya-owned browser endpoints.

## Build

The build accepts exactly six `REYA_SAFE_UI_*` variables. Missing, unknown, or
non-canonical values fail the build. The Safe and consolidated service origin
are release inputs, not runtime selections: both are recorded in the
configuration digest and must be replaced with the reviewed activation values.

```sh
REYA_SAFE_UI_PROFILE=reya-mainnet \
REYA_SAFE_UI_CHAIN_ID=1729 \
REYA_SAFE_UI_ACTIVATION=disabled \
REYA_SAFE_UI_BUILD_SHA=0123456789abcdef0123456789abcdef01234567 \
REYA_SAFE_UI_SAFE_ADDRESS=<approved-lowercase-safe-address> \
REYA_SAFE_UI_SERVICE_ORIGIN=https://<approved-consolidated-tailnet-host> \
pnpm build
```

The output is written to `dist/`. `release.json` records the exact source digest, validated configuration digest,
build revision, approved Safe, consolidated service origin, Cannon `2.26.1`
state format `7`, fixed public `Reya-Labs/reya-deployments` source contract,
and per-file asset integrity. `sbom.cdx.json` is a deterministic CycloneDX 1.6 inventory whose empty
component and dependency sets record that the deployed shell has no runtime packages or client-side JavaScript.
`_headers` supplies Cloudflare's CSP and browser hardening headers.

Run the deterministic tests and whole-export dependency scan before publishing:

```sh
pnpm lint
pnpm test
pnpm scan
```

The scan permits only the five expected export files. It binds the SBOM to the tested source, configuration, and
revision and rejects any deployed component or dependency. It also rejects remote URLs, hosted Cannon/IPFS providers,
scripts, forms, frames, symlinks, file-integrity mismatches, and any deviation from the generated CSP.

## Non-signable local upgrade preview

The workspace also contains an offline-first QA CLI for the exact
`reya-omnibus:1.0.158@main` to `1.0.159` upgrade at Reya deployments commit
`2b10669075b91eb8db781d199292f30c52f8e994`. This tool is not part of the
Cloudflare export. It does not connect a wallet, stage a Safe transaction,
sign, publish, or submit anything.

Use the repository-pinned toolchain:

- Node `22.23.1`
- pnpm `10.11.0`
- Anvil `1.2.3-v1.2.3`, commit
  `a813a2cee7dd4926e7c56fd8a785b54f32e0d10f`

From the Cannon repository root, install only the required workspace closure
from a clean checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter @reya/cannon-safe-ui...
git status --short
```

The preview command rejects any tracked, staged, or untracked worktree change.
Before importing Cannon, it verifies the pinned Node and pnpm versions, rebuilds
the exact local builder, and then records the commit, lockfile, package metadata,
and SHA-256 directory digests of the executed builder and artifact-codec output.

The source repository and every CLI path must be absolute. Verify that the
separate `reya-deployments` checkout contains the pinned Git object:

```sh
git -C /absolute/path/to/reya-deployments \
  cat-file -e 2b10669075b91eb8db781d199292f30c52f8e994^{commit}
```

Hydration is a separate, explicit bootstrap step. It downloads raw Cannon
artifacts from one operator-chosen, credential-free Kubo `cat` origin, verifies
every CID, recursively closes the baseline imports, and writes a mode-`0600`
local cache. There is no default origin and the preview runtime never contacts
that origin:

```sh
pnpm --filter @reya/cannon-safe-ui hydrate:local-qa \
  --origin https://approved-kubo-origin.example \
  --cache-dir /absolute/path/to/reya-cannon-artifacts
```

For this fixture, `inventory.json` must contain 77 artifacts and these exact
digests:

```text
manifestSha256  f37837881e4fad205b26d11bba1c1cdfb186891fdb762435445913c44e94acae
inventorySha256 c71b8ac6fbcad5b01d251c9a813f275eccba4d635028f02f93f01c07280f85d6
```

Provide `REYA_CANNON_QA_RPC_URL` through a secret-safe environment injection.
The endpoint must report chain `1729` and serve state at an exact finalized
block number. Latest-only gateways fail closed with
`RPC_PINNED_STATE_UNAVAILABLE`. The upstream URL is held only by a loopback
proxy and is not placed in Anvil arguments, output, or errors.

```sh
test -n "${REYA_CANNON_QA_RPC_URL:?set through a secret-safe environment}"

pnpm --filter @reya/cannon-safe-ui preview:local \
  --artifact-cache /absolute/path/to/reya-cannon-artifacts \
  --source-repository /absolute/path/to/reya-deployments \
  --output /absolute/path/to/reya-preview-first.json
```

The output path is create-only. The result records the immutable source,
artifact inventory, Cannon worktree provenance, selected block number/hash,
deployer starting nonce, full simulation order, EOA deployer prerequisites,
and the Safe-only proposal calls. Provenance includes the exact Node and pnpm
versions plus hashes of the builder and artifact-codec runtime output. Local
transaction hashes are simulation evidence, not a `safeTxHash`.

Repeat the preview against the exact first-run block rather than selecting a
new finalized block:

```sh
QA_FORK_BLOCK_NUMBER="$(
  jq -er '.qaEvidence.forkBlock.blockNumber' \
    /absolute/path/to/reya-preview-first.json
)"
QA_FORK_BLOCK_HASH="$(
  jq -er '.qaEvidence.forkBlock.blockHash' \
    /absolute/path/to/reya-preview-first.json
)"

pnpm --filter @reya/cannon-safe-ui preview:local \
  --artifact-cache /absolute/path/to/reya-cannon-artifacts \
  --source-repository /absolute/path/to/reya-deployments \
  --fork-block-number "$QA_FORK_BLOCK_NUMBER" \
  --fork-block-hash "$QA_FORK_BLOCK_HASH" \
  --output /absolute/path/to/reya-preview-second.json
```

Review `deployerPrerequisites` independently before treating
`safeProposalCalls` as stageable. A deployer-only simulation is rejected as
non-proposable, and any signer other than the fixed local-QA deployer and the
approved Reya Safe fails the run.

## Dormant Reya service clients

`src/clients/` contains ESM clients that remain unreachable from the disabled
production shell built by `src/build.mjs`. The separate
`@reya/cannon-safe-website` package imports the reviewed RPC, source, artifact,
OP-registry and Safe-payload preparation subset only for local browser QA. It
does not expose a browser staging route. CI runs `pnpm verify:dormant` to
prove that the production shell remains separated and to reject hard-coded
remote origins, hosted Cannon/public IPFS/Git/RPC fallbacks, browser
credentials, upload routes, and `localStorage` from all UI source.

The client factory accepts one exact HTTPS Tailscale service origin such as
`https://cannon-api.<tailnet>.ts.net`. It rejects credentials, ports, paths,
query strings, fragments, non-Tailscale hosts, unknown options, and any bearer
token configuration. Chain selection is not configurable: every applicable
query is fixed to Reya chain `1729`. The caller must inject both
`verifyArtifactCid(bytes)` and `verifyAbiSelector(signature, selector)`
integrity implementations. Selector documents are returned only when the
second verifier returns exactly `true`; a false, malformed, or rejected result
fails the entire response closed. The injected selector implementation must
derive Ethereum Keccak-256 selectors rather than standardized SHA3-256.

The reviewed read surface is finite:

- `GET /query/search`
- `GET /query/chains`
- `GET /query/packages/:packageName`
- `GET /query/packages/:fullPackageRef/1729`
- `GET /query/selector`
- `GET /source/reya-deployments/:fullCommitSha/reya-network`
- `POST /artifacts/api/v0/cat?arg=<CIDv0>`
- `POST /registry/op/resolve`
- `POST /rpc/1729`

The source client accepts only a lowercase 40-character commit for the fixed
public `Reya-Labs/reya-deployments` repository. It re-hashes every returned
TOML file and the canonical bundle before returning an immutable include
closure rooted at `packages/tomls/src/omnibus/reya_network.toml`. It has no
branch, tag, repository, path, GitHub credential, or hosted Cannon proxy
option. The client binds the same pinned `@iarna/toml` parser used by the
gateway and uses parsed `include` arrays to reject missing files, extra
unreachable files, cycles, root escapes, and excessive graph depth. Callers
cannot replace or weaken this parser. The signed canonical `files` collection
remains path-sorted for deterministic hashing; the derived immutable
`orderedFiles` collection follows a root-first traversal in declared include
order for the reviewed Cannon adapter.

`cat` uses Kubo's read-only POST convention, sends no body or authorization
header, and requires the caller to inject a content-CID implementation. The
client compares that implementation's computed canonical CIDv0 with the
requested CID before returning bytes. There is no default verifier and no
browser upload method.

The RPC client assigns a monotonic numeric JSON-RPC ID, sends only the
runtime's finite read-method allowlist to `/rpc/1729`, and requires the exact
ID in a single canonical success envelope. Batches, notifications, upstream
error envelopes, unknown response fields, redirects, and oversized or
non-canonical JSON fail closed.

The staging client is a separate factory and is not attached to the read-only
client collection. It fixes proposal reads and mutations to
`/staging/1729/<approved-safe>`, sends no browser credentials or caller-defined
headers, and has no configurable chain, route, RPC, repository, attestation, or
target. Proposal submission accepts exactly one canonical 65-byte EIP-712 EOA
signature and one strict Safe transaction; it never forwards cached signature
sets. Supersession requires an explicit expected digest, reviewed reason, and
caller-supplied idempotency key. Mutations are attempted once and ambiguous
network failures are never retried automatically. Successful responses must
bind back to the submitted transaction, signature, or superseded digest.
Backend errors expose only a status-bound allowlisted code; upstream messages
and details are discarded.

The Safe signing client is also dormant and contains no wallet discovery,
connection, chain-switching, staging, RPC, or execution method. It prepares the
fixed chain-`1729` Safe EIP-712 payload, recomputes the Safe transaction hash,
and brands the resulting deeply frozen object to one client instance. Signing
accepts only that exact prepared object and one canonical lowercase owner
address, permits only one in-flight wallet request, normalizes only recovery
IDs `0`/`1` to the backend's required `27`/`28`, and independently recovers the
returned signer before exposing the signature. Wallet failures and malformed
or wrong-owner signatures are reduced to fixed local error codes without
provider messages.

Function and error documents use a dependency-free, bounded canonical ABI
signature subset: explicit integer widths; standard `address`, `bool`, `bytes`,
`function`, and `string` types; non-empty tuples; dynamic arrays; and fixed
arrays whose canonical positive decimal length is at most `4294967295`.
Aliases, fixed-point types, zero or leading-zero array lengths, control
characters, and non-canonical syntax are rejected. The query API must enforce
the same conformance vectors before these dormant clients can be activated.

These modules are not activation-ready infrastructure. The `/staging` prefix
is the reviewed consolidated-ingress contract and must strip to the backend's
root route. The consolidated Tailscale ingress and its `/query`, `/artifacts`,
`/source`, `/registry/op/resolve`, and `/rpc` routes do not yet exist. The
bounded source-gateway package implements the `/source` application contract,
but it is not published or deployed by this change. The registry resolver
workload must keep its OP Mainnet RPC URL server-side, probe chain `10`, and
expose only the fixed Cannon registry `getPackageInfo` read implemented by this
package. Activation also requires that resolver and its secret OP RPC
configuration, the reviewed query API and read-only artifact workloads,
exact-origin CORS, signer access testing, artifact backfill and recovery
evidence, and a separate change that intentionally imports the clients and
updates CSP. Activation depends on the reviewed query API contract, including
its normalization of Redis aggregate namespace counts into bounded JSON
numbers; these clients reject raw node-redis string/Buffer counts.
