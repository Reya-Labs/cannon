# @usecannon/artifact-codec

This package owns Cannon's persisted artifact encoding contract: pako-compressed bytes and the CIDv0 UnixFS key produced by Kubo's historical single-file add defaults.

## Kubo compatibility attestation

The regular test suite uses pinned golden CIDs, a deterministic differential corpus against the legacy implementation, and a Node-global-free browser-bundle check.

An additional local attestation executes the official Kubo 0.39.0 `darwin-arm64` binary against chunk-boundary vectors. It is intentionally not a CI check because it requires a platform-specific release archive. The script verifies the archive's pinned SHA-512 digest before extracting or executing it:

```sh
KUBO_ARCHIVE=/absolute/path/to/kubo_v0.39.0_darwin-arm64.tar.gz \
  pnpm --filter @usecannon/artifact-codec test:kubo-oracle
```

The oracle invokes `ipfs add --only-hash` with CIDv0, protobuf leaves, and the 256 KiB fixed-size chunker explicitly selected. Changing those settings is an artifact-key migration, not a routine codec refactor.
