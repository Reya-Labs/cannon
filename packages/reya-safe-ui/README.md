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
build revision, and per-file asset integrity. `_headers` supplies Cloudflare's CSP and browser hardening headers.

Run the deterministic tests and whole-export dependency scan before publishing:

```sh
pnpm lint
pnpm test
pnpm scan
```

The scan permits only the four expected export files. It rejects remote URLs, hosted Cannon/IPFS providers, scripts,
forms, frames, symlinks, file-integrity mismatches, and any deviation from the generated CSP.

## Dormant Reya read clients

`src/clients/` contains dependency-free ESM clients for a later activation
change. They are deliberately unreachable from `src/build.mjs`, are not
included in the generated export, and do not change the disabled CSP. CI runs
`pnpm verify:dormant` to prove that separation and to reject hard-coded remote
origins, hosted Cannon/public IPFS/Git/RPC fallbacks, browser credentials,
upload routes, and `localStorage` from all UI source.

The client factory accepts one exact HTTPS Tailscale service origin such as
`https://cannon-api.<tailnet>.ts.net`. It rejects credentials, ports, paths,
query strings, fragments, non-Tailscale hosts, unknown options, and any bearer
token configuration. Chain selection is not configurable: every applicable
query is fixed to Reya chain `1729`.

The reviewed read surface is finite:

- `GET /query/search`
- `GET /query/chains`
- `GET /query/packages/:packageName`
- `GET /query/packages/:fullPackageRef/1729`
- `GET /query/selector`
- `POST /artifacts/api/v0/cat?arg=<CIDv0>`

`cat` uses Kubo's read-only POST convention, sends no body or authorization
header, and requires the caller to inject a content-CID implementation. The
client compares that implementation's computed canonical CIDv0 with the
requested CID before returning bytes. There is no default verifier and no
browser upload method.

These modules are not activation-ready infrastructure. The consolidated
Tailscale ingress and its `/query` and `/artifacts` routes do not yet exist.
Activation also requires the reviewed query API and read-only artifact
workloads, exact-origin CORS, signer access testing, artifact backfill and
recovery evidence, and a separate change that intentionally imports the
clients and updates CSP. The query API must also normalize Redis aggregate
namespace counts into bounded JSON numbers; its current declared numeric
contract must not forward the raw node-redis string/Buffer value.
