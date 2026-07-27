# Reya Cannon runtime image security

This document is the acceptance and activation record for PRO-729. It covers the
four Cannon images that Reya may operate:

- `repo`;
- `indexer`;
- `api`; and
- `safe-app-backend`.

Merging the runtime changes does not publish or activate an image. Publication
and the later DevOps digest update remain separately approved operations.

## Reviewed upstream provenance

The build toolchain and final runtime are pinned by OCI index digest:

| Purpose                           | Official image                              | OCI index digest                                                          | linux/amd64 manifest                                                      |
| --------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Node toolchain and runtime binary | `docker.io/library/node:22.23.1-alpine3.24` | `sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2` | `sha256:b74031e546d7f4faf561d797ac1b76beccac856a042815ca77db4fd047581605` |
| Final Alpine runtime              | `docker.io/library/alpine:3.24.1`           | `sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b` | `sha256:79ff19e9084a00eece421b2523fb93e22d730e2c0e525905de047e848e56d95f` |

The manifests were resolved from the official Docker Library repositories on
2026-07-27. Node 22.23.1 is an official LTS release and Node 22 remains in
maintenance through April 2027. Alpine 3.24.1 is an official 3.24 release and
the 3.24 branch is supported through 2028-06-01.

Primary references:

- [Node 22.23.1 release](https://nodejs.org/en/blog/release/v22.23.1/)
- [Node release lifecycle](https://nodejs.org/en/about/previous-releases)
- [official Node container image](https://hub.docker.com/_/node)
- [Alpine releases](https://www.alpinelinux.org/releases/)
- [Alpine downloads](https://www.alpinelinux.org/downloads/)
- [Docker image digest semantics](https://docs.docker.com/dhi/core-concepts/digests/)

The final images start from the Alpine digest, install only pinned
`libgcc=15.2.0-r5` and `libstdc++=15.2.0-r5`, and copy Node from the pinned Node
image. They do not contain npm, npx, pnpm, Corepack, or Yarn. The image labels
record both the direct Alpine base and the pinned Node source. The build stages
also pin pnpm 10.11.0 and `@vercel/ncc` 0.44.1 by their registry SHA-512
integrities.

## Required evidence

`.github/workflows/runtime-image-security.yml` performs the following on an
exact source revision:

1. builds each image for `linux/amd64`;
2. verifies its source, revision, version, creation timestamp, base digests,
   default command, non-root identity, Node version, native runtime
   compatibility, absent package managers, and absent setuid/setgid files;
3. emits an SPDX JSON SBOM using Trivy 0.72.0 through the full-SHA-pinned
   `aquasecurity/trivy-action` v0.36.0; and
4. fails on every HIGH or CRITICAL operating-system or library finding, with no
   ignore file or accepted exception.

The workflow retains the SBOM and JSON vulnerability report as run-scoped
evidence. It runs for relevant pull requests and protected-branch changes, and
recurs each Monday at 06:23 UTC. PR #15's Dependabot policy independently
proposes bounded weekly Docker-base updates for `/docker` and
`/packages/safe-app-backend`.

The workflow's complete source is digest-locked by
`.github/scripts/audit-workflows.mjs`. Trigger, path, action, runner, permission,
or command changes therefore require an explicit workflow-policy change in the
same reviewed diff.

## Exact pushed-digest scan

After an approved publisher pushes a source-SHA-tagged image, scan the returned
immutable digest before activation:

```sh
gh workflow run runtime-image-security.yml \
  --repo Reya-Labs/cannon \
  --ref dev \
  -f runtime=repo \
  -f image_ref=ghcr.io/reya-labs/repo@sha256:<64-hex-digest> \
  -f expected_revision=<40-hex-source-commit>
```

Select the matching runtime for the other images. The job accepts only the
selected `ghcr.io/reya-labs/<runtime>@sha256:<digest>` form, checks out the
declared source revision, derives its package version and commit timestamp, and
then verifies and scans the pulled `linux/amd64` manifest.

The digest-scan job has only `contents: read` and `packages: read`. It
authenticates to GHCR with the job-scoped `github.token`; it does not consume a
repository secret. The trusted verification policy and the declared image
source are checked out into separate directories. Metadata is read from the
declared source, but no script from that revision is executed after registry
authentication. The `--ref dev` in the command above intentionally selects the
protected workflow and verifier; `expected_revision` selects only the image
source metadata. The job fails unless it is running in `Reya-Labs/cannon` from
the protected `refs/heads/dev` ref and the declared source revision is an
ancestor of that exact dev checkout. Runtime probes execute the candidate with
no network, read-only filesystems, all capabilities dropped,
`no-new-privileges`, and a bounded PID limit. The exact workflow and verifier
policies reject package writes, broader job permissions, ancestry bypasses, or
relaxation of those sandbox controls.

Activation requires:

- a successful exact-source build;
- a successful exact-pushed-digest scan with zero HIGH or CRITICAL findings;
- retained SBOM and scan evidence;
- recorded candidate and rollback digests; and
- an independently approved, manual DevOps digest change.

No floating production tag is permitted.

## Rollback

The currently recorded repository-service rollback is:

```text
ghcr.io/reya-labs/repo@sha256:6397afa38b21d2d9e18b137eb73ef576df46d577b346f05a5a09f81a195678f5
```

Its `linux/amd64` manifest is
`sha256:6354c14c71c1b71b32660d4a3f9f8cab90b371ac0dd20fb1f3c06fda06b7b804`
and its embedded source revision is
`d1b3800baf8b9b35fbc07e2fa684727f86d5e325`. The OCI index remained readable
from GHCR on 2026-07-27.

The other three images do not yet have an accepted live digest. They must not be
activated until their first candidate and rollback policy are recorded. To
roll back the repository service, restore the exact digest above through the
normal reviewed DevOps change and manual deployment path; do not rebuild or
retag it.
