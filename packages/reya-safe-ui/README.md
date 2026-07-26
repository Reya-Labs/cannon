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
