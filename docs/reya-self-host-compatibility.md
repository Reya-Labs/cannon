# Reya self-host compatibility contract

Status: source-grounded compatibility and implementation handoff for [PRO-690](https://linear.app/reya-labs/issue/PRO-690/bootstrap-reya-cannon-v3-fork-and-self-host-compatibility-contract). This document describes checked-in behavior at Cannon commit `7edc8f116a8a4db84f9201a37b852684443105ce` on `dev`, then labels the normative gates owned by follow-on tickets. Infrastructure decisions remain in the linked Linear design. This is not a production deployment runbook and does not authorize a mainnet Safe action.

## Outcome

Reya can self-host the Cannon UI, Safe staging backend, package-query API, registry indexer and artifact facade from this fork. Cannon artifacts do not require Reya to operate a public IPFS node: Cannon computes the CID locally from the exact compressed bytes, and the repository service stores those bytes under the CID in S3-compatible storage while presenting the Kubo-compatible `/api/v0/add` and `/api/v0/cat` calls used by the builder and UI.

The current source is a usable starting point, not yet a production-ready self-host distribution. Before a mainnet canary, Reya must harden the Safe staging backend, make the artifact mirror recoverable without Cannon's hosted services, run the package-query API/indexer, parameterize hosted defaults in the UI, and add fork-specific CI and release artifacts. Those changes are split into [PRO-691](https://linear.app/reya-labs/issue/PRO-691/harden-cannon-safe-staging-backend-for-reya-mainnet), [PRO-692](https://linear.app/reya-labs/issue/PRO-692/deploy-reya-cannon-artifact-mirror-and-persistent-valkey), [PRO-697](https://linear.app/reya-labs/issue/PRO-697/self-host-cannon-package-query-api-and-registry-indexer), and [PRO-694](https://linear.app/reya-labs/issue/PRO-694/self-host-cannon-ui-with-reya-access-and-runtime-configuration).

## Pinned source and reproducible baseline

The public fork is `Reya-Labs/cannon`. `origin/dev` and `upstream/dev` both resolved to the pinned commit above when this spike was run.

Use Node `20.5.1` and pnpm `10.11.0` to match the primary upstream lint, unit and website jobs. Upstream CLI E2E uses Node `20.18.0`, the root package permits a broader Node range, and release Dockerfiles use Node 22. Reya must choose one supported Node line and verify every fork-specific gate on it before producing images.

The following baselines passed from a clean install:

```bash
pnpm i --frozen-lockfile
pnpm build
pnpm --filter backend build
pnpm --filter @usecannon/repo build

REDISMS_SYSTEM_BINARY=/opt/homebrew/bin/redis-server \
  pnpm --filter @usecannon/repo test

pnpm --filter @usecannon/website tsc:build
NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID=non-secret-build-placeholder \
  pnpm build:website
```

The Redis override is only a local test-harness workaround because dependency install scripts were disabled on the test machine. It is not a production setting. The website build emits a static export in `packages/website/out` and passed with upstream warnings about Contentlayer, ESLint, Sentry tunnelling, and disabled minification; these warnings must be resolved or explicitly accepted in PRO-694.

Upstream PR CI does not cover all of this surface. Root `pnpm build` omits the website, Safe backend, repository and indexer; root `pnpm test` excludes the repository. The Safe backend has no test script. Reya must add explicit package and image gates rather than treating upstream's green checks as self-host readiness.

## Proposed service boundary

```mermaid
flowchart LR
  signer["Safe signer browser"] --> ui["Static Cannon UI<br/>Cloudflare"]
  ui --> rpc["Browser-safe RPC endpoint"]
  ui --> stage["Reya Safe staging backend"]
  ui --> packageApi["Reya package-query API"]
  ui --> repo["Reya artifact facade<br/>Kubo-compatible HTTP"]
  stage --> stageRedis["Persistent Valkey<br/>staged transactions"]
  stage --> rpc
  packageApi --> packageRedis["Persistent Redis Stack<br/>package/search indexes"]
  indexer["Reya registry indexer<br/>and pinning workers"] --> packageRedis
  indexer --> registry["Cannon registry"]
  indexer --> rpc
  indexer --> repo
  indexer -->|"privileged artifact copy"| s3
  repo --> artifactRedis["Persistent Valkey<br/>artifact index"]
  repo --> s3["Private S3-compatible storage<br/>CID-addressed bytes"]
  repo -. "migration fallback only" .-> cannon["repo.usecannon.com / public IPFS"]
  ci["reya-deployments CI"] --> repo
  ci --> registry
```

The UI can be served as a static Cloudflare asset deployment; nginx is not required. Access policy remains a product/security decision because some Safe signers are external to Reya. A Reya-employee-only SSO gate is insufficient. PRO-694 should choose an explicit signer identity allowlist, for example Cloudflare Access identities that include approved external signers, with Tailscale as an additional operator path rather than the sole browser path.

Browser calls originate outside the cluster, so cluster network policy does not constrain their destinations. The static deployment needs a strict CSP and explicit runtime/build configuration for the Safe staging backend, package-query API, artifact facade, RPC endpoints, wallet connectivity, and any retained analytics/telemetry endpoints.

## What Redis/Valkey persists

The three data planes have different durability contracts and should use separate instances or at least separately monitored namespaces and credentials. The package API/indexer specifically requires Redis Stack features such as search and time series; plain Valkey compatibility is not sufficient without proving every used module.

| Service | Current keys/role | Consequence of loss | Required production posture |
| --- | --- | --- | --- |
| Safe staging backend | `safe-app-backend:<chainId>-<safeAddress>` contains the serialized transaction map and accumulated signatures | Staged proposals and collected signatures disappear after a restart or cache miss | Persistent Valkey with backups, encryption, restricted network access, restore drill, and no eviction |
| Artifact repository | Sorted sets `repo:tempUploadHashes`, `repo:pkgHashes`, and `repo:longTermHashes` authorize/index CIDs; S3 stores the bytes | S3-resident blobs remain readable, but promotion state, upload authorization, and upstream-fallback classification are lost | Persistent Valkey plus deterministic rebuild from artifact-closure manifests; PRO-692 may remove these legacy sets only if authenticated writes and fallback behavior no longer depend on them |
| Package API/indexer | `reg:*` search, selector, ownership, checkpoint and time-series records plus BullMQ pinning jobs | Package/search UI becomes unavailable and index/pinning progress is lost; artifact bytes may remain intact | Isolated persistent Redis Stack with replayable registry checkpoints, queue recovery, a clean rebuild proof and no staging-backend credentials |

Running the staging backend without `REDIS_URL` is explicitly supported by the code but stores state only in process memory. That mode is unacceptable for mainnet staging.

## Named manifests

Two versioned artifacts have distinct purposes:

- The **artifact-closure manifest** is one complete snapshot, not one record per deployment. A new immutable manifest is emitted for every successful backfill or registry-publish commit and contains the entire active and rollback-eligible closure at one registry contract/network/block snapshot. It records each package resolution and whether that resolution is mutable; resolved deploy/meta URLs; every root/misc/meta/import CID and role; byte length; intended durable artifact-index class; the canonical per-CID sorted-set score plus the registry block timestamp/event that proves it; source/destination; and verification evidence. Store its bytes outside Valkey at a digest-addressed, immutable location such as `manifests/sha256/<digest>.json` in versioned private S3. A fixed genesis commit starts a predecessor-linked single-successor chain. To commit a manifest, conditionally create `manifests/next/<parentCommitDigest>.json` with `If-None-Match: *`; the canonical record contains its parent commit digest, manifest digest, and strictly increasing registry cursor `(blockNumber, transactionIndex, logIndex)`, while the SHA-256 of those canonical record bytes is its commit digest. Successful creation is the sole commit point. A loser cannot create a second child for the same parent and must read the winner and rebase. Recovery starts at genesis, validates each record/digest/cursor, and follows deterministic `next/<commitDigest>` keys to the terminal commit, so unlinked prepared manifests are ignored. A versioned `manifests/current.json` may cache that terminal digest but is never authoritative.
- The **self-host release manifest** records upstream and Reya source SHAs, package/config-schema/toolchain versions, UI asset digest, image digests, and the exact committed artifact-closure-manifest and commit digests promoted with that release. Artifact manifests can advance between software releases; every such publish still extends the durable commit chain above.

Every later reference to one of these manifests uses its full name. A CID itself is immutable; mutability applies only to a registry package/tag resolution.

## Artifact and CID contract

### CID determinism

For structured Cannon records the builder performs:

1. `JSON.stringify(content)`.
2. `pako.deflate(...)`.
3. `ipfs-only-hash` over the resulting bytes.
4. Upload of those exact bytes to `/api/v0/add`.
5. Rejection if the server's returned `Hash` differs from the locally computed CID.

The repository independently hashes the received bytes and stores them at `${S3_FOLDER}/${cid}`. Therefore the same byte sequence has the same Cannon/IPFS CID without contacting a public IPFS node. A local proof at the pinned commit produced the same CID twice for copied 101-byte buffers:

```text
QmUnSpSUKh9e825fvB7omLNRuLZE8Jyht9ioHjjvf7jXm7
```

The guarantee is byte identity, not merely semantic JSON equality. Reordering object keys or changing the compression output can produce a different CID. Migration should prefer raw byte copying and then independently verify the destination CID.

### Execution and UI artifact closure

A recoverable mirrored deployment is not just the root CID. The closure is:

1. The root `DeploymentInfo` blob referenced by the Cannon registry.
2. Its `miscUrl` blob.
3. Every deployment URL recorded under every `state.*.artifacts.imports` entry.
4. Recursively, each imported deployment's root, `miscUrl`, and imports.
5. Every non-empty registry `metaUrl` associated with a resolved package in that tree. The website reads this separate blob for source/package metadata.

The builder's `forPackageTree` traversal copies the execution-critical root/`miscUrl`/import closure depth-first. Import records are copied whether or not they carry provision tags; the tags affect returned registry publish calls, not blob copying. `metaUrl` copying is currently disabled, so the current builder mirror path is not sufficient for complete UI availability.

The repository server cannot infer the full closure from one root upload. Its `add` route only discovers and authorizes the root's direct `miscUrl`. The migration/backfill job must use builder-side traversal or an equivalent independently verified walker.

### The facade is not a general public IPFS node

The required compatibility surface is deliberately small:

| Request | Current behavior | Reya contract |
| --- | --- | --- |
| `POST /api/v0/add?local=true&to-files=/CID` | Recomputes the CID; accepts already-authorized bytes or any inflated JSON with a CID-shaped `miscUrl`; stores bytes in S3 and returns `{"Hash": "CID"}`. It does not validate the full `DeploymentInfo` schema | Preserve request/response compatibility; authenticate writers and enforce the expected schema/limits |
| `POST /api/v0/cat?arg=CID` | Reads S3 first, otherwise proxies configured `IPFS_URL` according to Redis/JSON checks | Read S3 first; use hosted IPFS only during migration; verify fallback bytes against CID and backfill S3 atomically |
| `HEAD /api/v0/cat?arg=CID` | Checks S3 only | Preserve as the authoritative local-presence probe |

Folder uploads (`wrap-with-directory`) are a separate Pinata-backed feature used for website bundles. They are not needed to preserve the deployment-artifact contract and should be disabled unless PRO-692 identifies a Reya requirement.

### Why keep a public IPFS fallback initially

Reya can reuse `repo.usecannon.com` or another public gateway/node for migration reads and as a time-bounded emergency fallback. It must not be the only durable copy: Cannon can change, deprecate, rate-limit, or stop operating its hosted repository, and public IPFS availability depends on someone retaining/pinning the bytes.

The cutover gate is not "the root CID loads once." Before CI writes only to Reya, an artifact-closure manifest for every active and rollback-eligible Reya deployment must prove that every root, `miscUrl`, recursive import, and non-empty registry `metaUrl` is present in Reya S3 and readable with the upstream disabled.

## Current gaps that block production

### Safe staging backend

At the pinned commit the staging backend:

- accepts `PORT`, optional `REDIS_URL`, comma-separated `RPC_URLS`, and truthy `TRUST_PROXY`;
- falls back to viem's public RPC URL for a known chain when no explicit RPC is configured;
- exposes unauthenticated reads and writes with wildcard CORS;
- accepts arbitrary valid chain IDs/Safe addresses supported by its provider lookup;
- rate-limits globally but has no Reya signer identity, Safe allowlist, request audit identity, or idempotent concurrency contract;
- merges signatures with a read/modify/write process that is not protected against concurrent writers;
- writes Redis asynchronously after responding logic and has no automated tests;
- has a broken package `start` path (`src/index.js`) even though TypeScript and the Docker image use `dist/index.js`.

PRO-691 must add an explicit chain/Safe allowlist, authenticated writer identity, deliberate read policy, constrained CORS, mandatory Reya RPCs, strict proxy parsing, audit logs/metrics, request/body/rate limits, failure-mode tests, and a reproducible image. Redis must be the authoritative state, with each successful response durably acknowledged and signature union performed through linearizable CAS/Lua semantics or an equivalent protocol. Process-local caches must be removed or versioned/invalidated so warm replicas cannot serve or overwrite stale state. Tests must cover simultaneous distinct-owner signatures through two replicas, a stale warmed replica, idempotent replay, and a new unprimed replica; every response/read must converge without signature loss.

Browser-to-backend authentication must be part of the contract, not just an ingress assumption: use a same-origin authenticated route or short-lived audience-bound credentials, fail closed on proxy identity headers, authorize the requested Safe, and continue validating every submitted signature against the current Safe on-chain. Add external-signer success plus unauthenticated, wrong-audience, unauthorized-Safe, and valid-identity/invalid-signature rejection tests. Execution remains in the user's Safe wallet; the service must never hold signing keys or submit a mainnet transaction autonomously.

### Artifact repository

The current repository service has several recovery and integrity gaps:

- normal artifact uploads and all reads are unauthenticated;
- root validation only checks inflated JSON and a CID-shaped `miscUrl`, not the full deployment schema;
- Redis authorization is written before S3, so a failed S3 write can leave a phantom index entry;
- an existing S3 root short-circuits before reauthorizing its `miscUrl`;
- a registry URL equality shortcut in builder mirroring can skip checking whether destination blobs still exist;
- a changed `miscUrl` CID is logged but does not fail the copy;
- upstream fallback responses are not status/CID-verified and are not cached into S3;
- S3 object-existence misses are memoized without expiry, so an out-of-band restore can remain invisible until cache clear/restart;
- `forcePathStyle` is hard-coded false, excluding some S3-compatible stores;
- application code provides no S3 deletion/retention mechanism; bucket lifecycle policy is external;
- the recursive builder walk has no cycle guard and its deduplication key does not include chain ID or content CID.
- the only legacy promotion code is an uninvoked cleaner; it derives wall-clock scores from temporary uploads, so the checked-in source does not define a deterministic durable index-rebuild oracle.

PRO-692 must close these gaps or wrap the service with an equivalent hardened implementation while preserving the CID and HTTP contracts above. If it retains the legacy sorted sets, the canonical target mapping is: all deployment-info roots (including recursive imports) in `repo:pkgHashes`; all `miscUrl`/`metaUrl` support blobs in `repo:longTermHashes`; no CID listed in a finalized artifact-closure manifest in `repo:tempUploadHashes`; and a score equal to the earliest retained referencing registry block timestamp in seconds. Each manifest must carry that score and its registry-event provenance for every CID. An unknown CID may be served only when present in S3; upstream fallback must reject CIDs absent from the permanent manifest-derived sets. The publish protocol must stage verified S3 objects, write the digest-addressed immutable artifact-closure manifest, then conditionally create the single-successor record for the terminal parent. That conditional creation is the sole durable commit point. After it succeeds, the service updates the non-authoritative head cache and transactionally reconciles the Redis indexes/cached manifest pointer to the committed terminal record. It reports success only when the Redis projection agrees. A retry after a post-commit crash resumes projection when the existing child matches; a CAS loser rebases onto the winning child. If PRO-692 instead removes these indexes, it must prove that authenticated writes, local reads and fallback policy no longer depend on them.

After the newest post-cutover publish, the recovery test must destroy Valkey and ignore/delete the head cache, walk and validate the commit chain from genesis, rebuild solely from the terminal committed manifest, assert exact members/classes/scores and their provenance (or prove the replacement has no such state), and exercise behavior that depends on each class rather than S3 presence alone. Concurrency/failure tests must cover competing publishers from the same parent, the losing conditional create, a stale lower-cursor publisher, crashes immediately before and after the commit point, a missing/stale head cache, unlinked prepared manifests, and empty Valkey.

### Package-query API and registry indexer

`NEXT_PUBLIC_API_URL` configures `@usecannon/api`, not the Safe staging backend. The website uses it for package search/listing, details, chain and selector data. The API reads Redis Stack records populated by `@usecannon/indexer`, which scans Cannon registry events and runs BullMQ pinning jobs. The indexer already discovers root/`miscUrl`/recursive-import blobs and registry `metaUrl` blobs and copies between configured IPFS and S3, but it does not independently prove requested-CID integrity or provide a complete self-host recovery contract. Its process also unconditionally starts a downloader against hard-coded `4byte.directory` endpoints; repeated request failures call `process.exit(1)` and can take down registry indexing even though signature-directory enrichment is not part of artifact correctness.

PRO-697 owns the package API/indexer, their isolated Redis Stack, recorded registry checkpoints, replay/backfill, queue recovery, CID verification, health/metrics, reproducible images and offline UI parity. It must use explicit Reya RPC/artifact/S3 settings and leave `NOTIFY_PKGS` empty unless a separately approved notification integration exists. It must also make 4byte enrichment configurable and non-fatal or replace it with a recoverable Reya-controlled snapshot, isolate its failure from registry indexing, and prove startup plus a clean rebuild with 4byte egress denied.

### Website and distribution

The static website supports a build-time `NEXT_PUBLIC_API_URL`, while artifact and Safe staging endpoints default in browser-local settings to `https://repo.usecannon.com/` and `https://safe-staging.usecannon.com`. Users can edit those settings, but that is not a safe deployment contract. One browser read path also silently falls back directly to `ipfs.io` after a facade error, which can conceal mirror failure and bypass facade policy. Safe simulation dynamically imports executable Ganache code from `https://unpkg.com/ganache@7.9.1`. Git operations use a hard-coded `https://git-proxy.repo.usecannon.com`.

PRO-694 must parameterize these defaults, remove or feature-gate the direct `ipfs.io` fallback, vendor/bundle and digest-pin Ganache rather than executing third-party CDN code in signer browsers, decide whether runtime configuration is required, remove or explicitly allow every remaining hosted dependency, and validate CSP/wallet behavior from the deployed Cloudflare origin. Its offline browser smoke test must deny all public IPFS and external script/CDN traffic. The current Sentry tunnel option cannot work with a static export.

The repository has no coherent self-host release today: root CI omits critical packages, the checked-in Compose mapping/configuration is inconsistent with the repo service, the Safe backend's nested workflow is not loaded by GitHub Actions, and server images are manual-only. Reya should publish immutable images/assets with upstream SHA, Reya SHA and digest in a self-host release manifest.

## Migration and recovery acceptance criteria

PRO-692 should implement and exercise this sequence before PRO-693 switches `reya-deployments`:

1. Enumerate the active and rollback-eligible Reya package references and chain IDs from a recorded registry contract, network and block snapshot; resolve both deploy and metadata URLs.
2. Derive the root/`miscUrl`/import/`metaUrl` set twice: once by the actual indexer/CLI/browser consumers and once by a separately implemented closure verifier that does not reuse Cannon's traversal helper. Require exact set equality, fail when a consumer fetches a CID absent from the candidate set, and fail when a candidate CID is not exercised by a declared consumer.
3. Copy exact raw bytes into private S3-compatible storage under their CIDs.
4. Independently recompute and reject every CID mismatch.
5. Produce one full-snapshot artifact-closure manifest containing package reference, chain ID, registry snapshot, resolution mutability, resolved deploy/meta URLs, each CID's root/misc/meta/import role, intended durable artifact-index class, canonical score and registry-event provenance, byte length, source, destination and verification time. Store it by digest in versioned private S3, then commit it by conditionally creating the sole `next/<parentCommitDigest>` record with a strictly increasing registry cursor. Verify the manifest and commit record without Valkey; update `current.json` only as a non-authoritative cache.
6. Assert that live registry resolution still matches the snapshot, discover the authoritative manifest without Redis by walking the validated chain from genesis, then rebuild the artifact Redis indexes from it on an empty database. Compare exact sorted-set membership, classification, scores and provenance to the manifest, and exercise an isolated authorization/fallback operation whose result depends on each declared durable index class rather than S3 presence alone. Race competing publishers and inject crashes on both sides of the commit point; prove that only the winning child extends the chain, preparations are ignored, and retries converge with a stale/deleted head cache and empty Valkey.
7. Disable fallback at the repository, browser and CSP/egress layers; restart the facade to clear memoized results; run real builder/CLI and package/source/staging browser flows; raw-fetch every CID listed in the artifact-closure manifest, recompute its CID and compare its byte length.
8. Back up S3/Valkey, delete an isolated test environment, restore it, restart/clear caches, repeat the exact raw-byte proof, and record recovery time.
9. Test the newest package written after cutover with the primary facade unavailable. Cannon's read-only service is only a legacy-miss source; it is not a failover for new Reya writes. If independent failover is required during the rollback window, dual-copy and verify every new CID to that target.
10. Only then change CI publishing to the Reya endpoint. Continue serving Reya S3 during rollback unless the independently verified failover in step 9 is available.

S3 must be private, encrypted and versioned, with blocked public access and scoped service credentials. Reads are exposed only through the facade. Lifecycle rules must not expire any CID referenced by an active or rollback-eligible artifact-closure manifest.

## Deployment order and ticket boundary

1. **PRO-690:** pin source behavior and compatibility contract (this document).
2. **PRO-691:** harden and test the Safe staging backend.
3. **PRO-692:** deploy the artifact facade, S3 and persistent Valkey; backfill and prove offline recovery.
4. **PRO-693:** point `reya-deployments` CI at Reya and add closure verification.
5. **PRO-697:** deploy and rebuild the package-query API, registry indexer and Redis Stack data plane.
6. **PRO-694:** deploy the static UI through Cloudflare with the approved external-signer access model and no Cannon-hosted data/runtime dependency.
7. **PRO-695:** test-Safe rehearsal, disaster-recovery exercise and bounded mainnet canary.
8. **PRO-696:** optionally make `reya-deployments` private after all consumers, GitHub environments, bots and artifact inputs have been migrated and an authenticated browser Git-read path exists.

Making `reya-deployments` private is not compatible with the current browser staging flow: its Git proxy supplies neither a GitHub authentication callback nor authenticated headers. PRO-694/PRO-696 need a server-side GitHub App/broker with repository/ref allowlisting, short-lived credentials and audit logs; no PAT or long-lived GitHub credential may reach signer browsers. With that addition, privacy is compatible with this architecture, but it remains deliberately last. It reduces source visibility; it does not replace artifact endpoint authentication, Safe policy, or immutable self-host release manifests.

## Questions for Cannon

The following message is ready to send to the Cannon team:

> Thanks — we're bootstrapping a Reya fork from the current `dev` branch and mapping the self-host path. Before we harden/deploy it, could you confirm:
>
> 1. Which v3 tag/commit should self-hosters target, and will the supported bundle include the website, `safe-app-backend`, package API, registry indexer, artifact repo, images and deployment examples?
> 2. Which website endpoints will be officially configurable at build/runtime (API, staging backend, artifact repo, Git proxy, RPCs, registry and telemetry)?
> 3. Is the intended artifact topology still the current Kubo-compatible repo facade backed by S3/Redis plus an upstream IPFS fallback? Is there a supported way to backfill and verify the full root + `miscUrl` + recursive import closure plus non-empty registry `metaUrl` blobs?
> 4. What are the required Redis durability and concurrency semantics for `safe-app-backend`? Are Redis-authoritative atomic signature merges, cache invalidation across multiple replicas and restore behavior part of the v3 work?
> 5. Which auth/CORS/Safe allowlist hooks and health/metrics interfaces do you expect self-hosters to put in front of or configure in the Safe staging backend?
> 6. Are `repo.usecannon.com`, `safe-staging.usecannon.com` and `git-proxy.repo.usecannon.com` expected to remain supported fallbacks through a published deprecation window?
> 7. Do you plan to add CI coverage and versioned images for the artifact repo, package API/indexer and Safe backend, or should we upstream those changes from our fork?
>
> We want to preserve Cannon CID and registry semantics while ensuring Reya can recover and operate without a hosted Cannon dependency. Happy to share the compatibility matrix/patches as we go.

## Upstream sync policy

Use `upstream/dev` as the synchronization source and `origin/dev` as Reya's integration branch. Open merge-based sync PRs at least weekly and immediately for security fixes; do not rewrite the long-lived fork. Keep Reya deltas small and upstream generic fixes where practical.

Every sync must pass upstream checks plus fork-specific gates for the Safe backend, package API/indexer, artifact repository, website export, images, service health, and a browser-to-staging/package/artifact/RPC smoke test. Promote a tested `origin/dev` commit to `origin/main` and publish a self-host release manifest that pins upstream SHA, Reya SHA, package versions, config-schema version, toolchain versions, artifact-closure-manifest digest, and asset/image digests.
