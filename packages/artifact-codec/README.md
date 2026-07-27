# @usecannon/artifact-codec

This package owns Cannon's persisted artifact encoding contract: pako-compressed bytes and the CIDv0 UnixFS key produced by Kubo's historical single-file add defaults.

## Kubo compatibility attestation

The regular test suite uses pinned golden CIDs, a deterministic differential corpus against the legacy implementation, and a Node-global-free browser-bundle check. The supported runtime floor is Node.js 20 because the pinned UnixFS importer's production dependency graph declares Node.js 20 engines.

An additional local attestation executes the official Kubo 0.39.0 `darwin-arm64` binary against chunk-boundary vectors. It is intentionally not a CI check because it requires a platform-specific release archive. The script verifies the archive's pinned SHA-512 digest before extracting or executing it:

```sh
KUBO_ARCHIVE=/absolute/path/to/kubo_v0.39.0_darwin-arm64.tar.gz \
  pnpm --filter @usecannon/artifact-codec test:kubo-oracle
```

The oracle invokes `ipfs add --only-hash` with CIDv0, protobuf leaves, and the 256 KiB fixed-size chunker explicitly selected. Its vectors include the repository's 50 MiB maximum, which crosses the multi-level UnixFS DAG threshold. Changing those settings is an artifact-key migration, not a routine codec refactor.

## Release contract

The codec and `@usecannon/builder` are in one Changesets fixed group. This extraction raises builder's supported Node.js floor from 16 to 20, so its first release is intentionally part of the Cannon v3 semver-major release, not a v2 patch. Apply the major changeset (or select the corresponding Lerna major version) before publication so both packages have the same v3-or-later version.

Before a manual release, `pnpm run verify:artifact-release` proves clean consumer builds, major-version intent, packed fixed-group metadata and dependency rewriting, full Lerna dependency order, and installation of the codec and builder tarballs outside the workspace. Publication mode additionally requires a clean tracked and untracked worktree, binds verification to the full Git commit ID, and rechecks both after lifecycle scripts and cleanup. The root publish commands also require the major version to have been applied; they refuse to publish the pending v2 package versions. They then run `prepare:artifact-release`, which rebuilds the complete fixed group from a clean generated-output state before Lerna runs. Lerna publication is serialized, cycle-rejecting, and dependency-topological.

This Reya fork intentionally has no automated npm publisher. The first public `@usecannon/artifact-codec` release and every coupled builder release require an operator with `@usecannon` scope authority (normally the upstream Cannon maintainers). The local contract check proves package composition; it does not grant that external authority. Never publish a builder tarball until the exact codec version named in that tarball is public in the target registry.

Registry publication is not atomic. A retry may begin after any prefix of the fixed group—codec, builder, or CLI—is already public. Always use the root publish command for the retry: its preparation step recreates local output for every fixed-group package, including packages Lerna will skip as already published, so later dependents can still compile. Afterward, confirm codec, builder, CLI, and `hardhat-cannon` are all public at the same version. Never retry a dependent out of dependency order with a direct package-level publish.
