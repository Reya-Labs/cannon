# Reya Cannon Safe UI

This package builds the deliberately disabled first release of Reya's self-hosted Cannon signer UI. It is a
standalone static export and does not import the generic Cannon website.

The shell has no client-side JavaScript, wallet integration, RPC, staging API, artifact, Git, IPFS, analytics, or
telemetry dependency. It cannot stage, sign, or submit a transaction. Activation belongs in a later reviewed change
that supplies the approved Safe and Reya-owned browser endpoints.

## Build

The build accepts exactly four `REYA_SAFE_UI_*` variables. Missing, unknown, or non-canonical values fail the build.

```sh
REYA_SAFE_UI_PROFILE=reya-mainnet \
REYA_SAFE_UI_CHAIN_ID=1729 \
REYA_SAFE_UI_ACTIVATION=disabled \
REYA_SAFE_UI_BUILD_SHA=0123456789abcdef0123456789abcdef01234567 \
pnpm build
```

The output is written to `dist/`. `release.json` records the exact source digest, validated configuration digest,
build revision, and per-file asset integrity. `sbom.cdx.json` is a deterministic CycloneDX 1.6 inventory whose empty
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

## Dormant Reya read clients

`src/clients/` contains dormant ESM clients for a later activation change.
They are deliberately unreachable from `src/build.mjs`, are not included in
the generated export, and do not change the disabled CSP. CI runs
`pnpm verify:dormant` to prove that separation and to reject hard-coded remote
origins, hosted Cannon/public IPFS/Git/RPC fallbacks, browser credentials,
upload routes, and `localStorage` from all UI source.

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

Function and error documents use a dependency-free, bounded canonical ABI
signature subset: explicit integer widths; standard `address`, `bool`, `bytes`,
`function`, and `string` types; non-empty tuples; dynamic arrays; and fixed
arrays whose canonical positive decimal length is at most `4294967295`.
Aliases, fixed-point types, zero or leading-zero array lengths, control
characters, and non-canonical syntax are rejected. The query API must enforce
the same conformance vectors before these dormant clients can be activated.

These modules are not activation-ready infrastructure. The consolidated
Tailscale ingress and its `/query`, `/artifacts`, and `/source` routes do not
yet exist. The bounded source-gateway package implements the `/source`
application contract, but it is not published or deployed by this change.
Activation also requires the reviewed query API and read-only artifact
workloads, exact-origin CORS, signer access testing, artifact backfill and
recovery evidence, and a separate change that intentionally imports the
clients and updates CSP. Activation depends on the reviewed query API contract,
including its normalization of Redis aggregate namespace counts into bounded
JSON numbers; these clients reject raw node-redis string/Buffer counts.
