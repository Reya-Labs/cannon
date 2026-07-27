# Reya Cannon workflow security boundary

The Reya fork does not inherit Cannon's upstream publication authority.

## Disabled inherited paths

The following workflows are intentionally absent:

- upstream npm release and Changesets publication;
- website upload to `repo.usecannon.com`;
- write-token backmerge and dependency-bump automation;
- arbitrary-ref third-party Supersim image builds;
- arbitrary-ref GHCR image publication; and
- secret-bearing CLI end-to-end tests that still depend on hosted Cannon infrastructure.

Reintroducing any of those capabilities requires a separate threat model, least-privilege identity, immutable source
selection, protected approval boundary, and dry-run rehearsal.

## Retained workflows

Pull-request workflows receive read-only repository permissions, do not receive repository secrets, use checkout
without persisted credentials, and pin every external action to a full commit SHA. The required website Cypress
job uses credential-free public RPC fixtures so it can safely evaluate pull-request code. PRO-726 must replace
those transitional fixtures with Reya-controlled test infrastructure before activation. The disabled Reya Safe UI
workflow may also be invoked manually, but remains read-only and uploads only run-scoped diagnostic artifacts.

The sole retained publisher is the PRO-714 Safe-backend image workflow. It has no pull-request or manual trigger,
runs only on a protected `dev` push after the reusable read-only CI succeeds, and remains default-off behind
`CANNON_SAFE_PUBLISH_ENABLED == 'true'` plus the `cannon-image-publish` environment. Its only secret is the
job-scoped `GITHUB_TOKEN`; its exact write permissions and pinned action set are allowlisted. It publishes only a
source-SHA tag with SBOM, maximum provenance and attestation.

No other retained workflow can publish packages, container images, external artifacts or source changes.
Run-scoped diagnostic artifacts such as failed-test screenshots remain allowed. The Safe-backend publisher must
remain disabled until PRO-729 produces accepted runtime evidence and PRO-731 enforces and rehearses the external
repository/environment boundary described below.

## Enforced repository checks

`.github/scripts/audit-workflows.mjs` rejects:

- retired mutation workflows and hosted Cannon publication credentials;
- unreviewed workflows, triggers, permissions, runners, actions, and container images;
- deletion of the Reya Safe UI workflow once the `packages/reya-safe-ui` package is present in the composed tree;
- `pull_request_target`, repository-secret references, and GitHub-token references outside the exact Safe-backend
  publisher contract;
- any extra Safe-backend publisher field, step, command, action input, registry, image destination, or whole/computed
  secrets context;
- floating action references and mutable container image references;
- persisted checkout credentials; and
- ignored failures.

Dependency review rejects newly introduced high or critical vulnerable dependencies. Dependabot proposes bounded
weekly npm, GitHub Actions, and runtime-base updates against `dev`; human review and normal CI remain mandatory.
PRO-729 supplies the recurring exact-image, SBOM and vulnerability evidence for the repo, indexer and API runtimes
and the shared runtime-base evidence consumed by the Safe backend. The exact source, pushed-digest scan, provenance,
activation, and rollback contract is recorded in [`docs/runtime-image-security.md`](../docs/runtime-image-security.md).
The protected runtime inventory starts with every service explicitly inactive. Once a publisher is approved, each
active and rollback entry must name an immutable Reya GHCR digest and its protected-dev source revision. The weekly
workflow rescans those exact digests and binds each attestation to the runtime's reviewed publisher workflow and the
same signer/source revision; another same-repository workflow cannot satisfy that gate.

The in-repository `workflow-policy` job is advisory: a pull request can replace a required job with a no-op while
preserving its check name. After merge, PRO-731 must install an organization or enterprise ruleset-required workflow
whose workflow and policy implementation come from a protected source ref outside the candidate pull request. That
ruleset must cover `dev` and `main`, require the stable functional and dependency-review checks, enable CODEOWNERS and
last-push review for workflow and lockfile changes, and enable repository-level full-SHA action pinning. The
`cannon-image-publish` environment must require the agreed reviewers before the default-off publisher is enabled.
The four obsolete `CANNON_E2E_RPC_URL_*` repository secrets must then be removed or rotated. Complete and rehearse
those platform changes before enabling any trusted publication.
