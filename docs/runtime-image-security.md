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

The evidence toolchain is also selected by OCI index digest:

| Purpose                         | Official image            | Version | OCI index digest                                                          |
| ------------------------------- | ------------------------- | ------- | ------------------------------------------------------------------------- |
| Whole-image software inventory  | `docker.io/anchore/syft`  | 1.48.0  | `sha256:b4f1df79f97b817682d8b5ff941eb6bfe74f6172553a5e312c75bbc2eabc405c` |
| Vulnerability database matching | `docker.io/anchore/grype` | 0.116.0 | `sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821` |

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
- [Syft v1.48.0 release](https://github.com/anchore/syft/releases/tag/v1.48.0)
- [Grype v0.116.0 release](https://github.com/anchore/grype/releases/tag/v0.116.0)

The final images start from the Alpine digest, install only pinned
`libgcc=15.2.0-r5` and `libstdc++=15.2.0-r5`, and copy Node from the pinned Node
image. They do not contain npm, npx, pnpm, Corepack, or Yarn. The image labels
record both the direct Alpine base and the pinned Node source. The build stages
also pin pnpm 10.11.0 and `@vercel/ncc` 0.44.1 by their registry SHA-512
integrities.
Dependency installation disables lifecycle scripts in every build stage.

## Required evidence

`.github/workflows/runtime-image-security.yml` performs the following on an
exact source revision:

1. builds each image for `linux/amd64`;
2. verifies its source, revision, version, creation timestamp, base digests,
   default command, non-root identity, Node version, native runtime
   compatibility, readable and syntactically valid default entry file, absent
   package managers, and absent setuid/setgid files;
3. saves the final image to a local archive and generates a Syft SPDX JSON SBOM
   without granting the scanner a Docker socket or network access;
4. requires that whole-image SBOM to contain the exact Node 22.23.1 binary and
   Alpine packages, and requires installed npm packages for the Safe backend;
5. for the three NCC-bundled services, extracts and validates the embedded
   CycloneDX inventory of the exact resolved production, non-optional dependency
   graph supplied to the bundle; and
6. scans both evidence layers with Grype and fails on every HIGH or CRITICAL
   match.

The NCC bundle-input inventory is deliberately conservative. It records the
resolved production dependency graph supplied to bundling; it does not claim
that every package or vulnerable code path is reachable from the service entry
point. A match therefore blocks activation pending remediation or explicit
reachability analysis, but it is not by itself proof of exploitability. The Safe
backend retains normal `node_modules`, so Syft directly inventories its installed
runtime packages.

The workflow retains the SBOM and JSON vulnerability report as run-scoped
evidence, including a machine-readable summary that keeps whole-image and
bundle-input results separate and a verified `SHA256SUMS` manifest over every
retained file. The scanners are immutable, capability-free, read-only
containers. Syft receives only the read-only image archive. Grype
first refreshes and hash-validates its vulnerability database without any SBOM
mounted; the separate scan containers then receive read-only SBOM evidence with
networking disabled and automatic database updates disabled. All scanners
receive generated minimal configuration from an isolated temporary directory,
so a repository-level ignore or scanner configuration cannot suppress findings.
The workflow runs for relevant pull requests and protected-branch changes, and
recurs each Monday at 06:23 UTC. PR #15's Dependabot policy independently
proposes bounded weekly Docker-base updates for `/docker` and
`/packages/safe-app-backend`; scanner-image refresh remains an explicit reviewed
policy change.

Grype's own compiled defaults exclude four indirect kernel-header match classes
for RPM and Debian packages. Those defaults are retained in the JSON report and
do not apply to these Alpine runtimes. Reya adds no vulnerability ID, package,
severity, fix-state, or path exception. Any future Reya exception requires an
owner, evidence-backed rationale, and expiry in reviewed policy.

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

The repository currently contains a protected publisher only for
`safe-app-backend`. The retired generic Docker workflow must not be restored.
Before `repo`, `indexer`, or `api` can be activated, their separately reviewed
publisher path must create the same GitHub-verifiable protected-dev SLSA
provenance. A registry digest produced without it is intentionally unusable by
this gate. Ownership is:

- PRO-714: `safe-app-backend` publication;
- PRO-723: `api` and `indexer` immutable publication; and
- PRO-692: repository artifact-service delivery and publication.

PRO-729 verifies the resulting images and attestations; it does not grant
registry write authority to the scan workflow.

The GKE ARC/Terraform runner is not an image publisher. It remains scoped to
controlled infrastructure work, while PRO-713 may use the ephemeral tailnet
runner for read-only proposal verification. Image attestations for PRO-714,
PRO-723, and PRO-692 must come from protected GitHub-hosted publication jobs;
`--deny-self-hosted-runners` is an activation invariant, not an optional
hardening flag.

The digest-scan job has only `attestations: read`, `contents: read`, and
`packages: read`. It authenticates to GHCR with the job-scoped `github.token`;
it does not consume a repository secret. Before pulling or trusting labels, it
uses GitHub's attestation verifier to require SLSA provenance for the exact OCI
digest, exact declared source commit, protected `refs/heads/dev` source ref, and
a GitHub-hosted runner. A matching label without that attestation is rejected.

The trusted verification policy and the declared image source are checked out
into separate directories. Metadata is read from the declared source, but no
script from that revision is executed after registry authentication. The
`--ref dev` in the command above intentionally selects the protected workflow,
verifier, and scanner; `expected_revision` selects only the image source
metadata. The job fails unless it is running in `Reya-Labs/cannon` from the
protected `refs/heads/dev` ref and the declared source revision is an ancestor
of that exact dev checkout. Runtime probes execute the candidate with no
network, read-only filesystems, all capabilities dropped,
`no-new-privileges`, and a bounded PID limit. The exact workflow, SBOM
generator, scanner, and verifier policies reject package writes, broader job
permissions, ancestry or attestation bypasses, scanner substitutions, ignore
configuration, or relaxation of those sandbox controls.

Activation requires:

- a successful exact-source build;
- protected-dev SLSA provenance for the exact pushed digest and source commit;
- a successful exact-pushed-digest scan with zero HIGH or CRITICAL findings;
- retained SBOM and scan evidence;
- recorded candidate and rollback digests; and
- an independently approved, manual DevOps digest change.

No floating production tag is permitted.

## Rollback quarantine

The historical repository-service image is:

```text
ghcr.io/reya-labs/repo@sha256:6397afa38b21d2d9e18b137eb73ef576df46d577b346f05a5a09f81a195678f5
```

Its `linux/amd64` manifest is
`sha256:6354c14c71c1b71b32660d4a3f9f8cab90b371ac0dd20fb1f3c06fda06b7b804`
and its embedded source revision is
`d1b3800baf8b9b35fbc07e2fa684727f86d5e325`. The OCI index remained readable
from GHCR on 2026-07-27.

This is an inventory reference, **not an activation-approved rollback**. A
2026-07-27 re-scan with the pinned current scanner found 4 CRITICAL and 41 HIGH
matches. The image is also based on end-of-life Alpine 3.20.3, runs as root,
contains npm and Yarn, and its build attestation names a retired feature branch
rather than protected `dev`. The exact protected-dev attestation gate therefore
rejects it.

None of the four images currently has an accepted live rollback digest.
Production activation remains blocked until each activated service records a
separately built, protected-dev-attested digest that passes the same runtime and
zero-HIGH/CRITICAL policy. Restoring the historical digest requires an explicit
incident decision through the normal reviewed DevOps and manual deployment
path; it must not be presented as the routine safe rollback, rebuilt, or
retagged.
