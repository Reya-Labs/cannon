# Reya Cannon preview worker

Server-side preview derivation for the production Reya Cannon signer origin
(`https://cannon.reya.xyz`).

This package exists to answer one question safely: **what exactly is a Safe
owner being asked to sign?** The browser may propose _which immutable inputs_ to
preview. It may not contribute any part of the answer.

## Why the browser cannot supply a preview

The local QA profile computes the preview in the browser and derives the Safe
transaction there. That is acceptable for a single operator inspecting their own
machine, but it cannot be the basis for collecting signatures from several
owners: a compromised or merely stale tab could present calls that do not match
the digest it asks people to sign.

The production worker therefore accepts only this request:

```json
{
  "chainId": 1729,
  "commit": "<40-character lowercase Git SHA>",
  "partialDeployCid": null,
  "previousPackageCid": "Qm…",
  "safeAddress": "0x…"
}
```

Every key is an immutable pointer. There is no key for calls, a Safe
transaction, a nonce, a digest or a signature — and because the parser pins the
exact key set, byte-for-byte, a request carrying one of those keys is rejected
whole rather than having it ignored.

From those inputs the worker, in order:

1. simulates the Cannon build to obtain the ordered Safe calls;
2. reads the live Safe `nonce`, `threshold` and owner set from chain;
3. derives the aggregate `aggregate3Value` delegatecall locally;
4. derives the EIP-712 `safeTxHash` locally;
5. asks the Safe contract for its own `getTransactionHash` and requires it to
   equal the locally derived digest.

Step 5 is what makes a domain-separator or Safe-version divergence a failed
request instead of a digest nobody should sign.

## Routes

| Method | Path                   | Purpose                                  |
| ------ | ---------------------- | ---------------------------------------- |
| `POST` | `/preview/1729`        | Derive the preview, transaction and hash |
| `POST` | `/registry/op/resolve` | Resolve the temporary OP package alias   |
| `GET`  | `/livez`, `/readyz`    | Kubelet probes                           |

There is deliberately no execute, broadcast, sign, submit or approve route.
Staging a proposal belongs to the Safe staging backend; executing one is out of
scope pending a separate security review. `test/app.test.mjs` asserts this
rather than leaving it to convention.

## Trust boundary

The worker never authenticates a browser. It sits behind the app-scoped
Tailscale identity proxy, which strips client-supplied identity headers and adds
its own alongside a shared secret. The worker:

- requires **exactly one** occurrence of each trusted header, read from
  `rawHeaders` — `headers[name]` comma-joins duplicates, which would let a
  spoofed value ride alongside the trusted one;
- compares the proxy secret in constant time;
- reflects exactly one CORS origin, never a wildcard, and never sets
  `Access-Control-Allow-Credentials`;
- holds every upstream credential server-side, and returns a fixed set of error
  codes so no upstream URL, token or message can reach the browser.

## Why `safeTxGas` and `gasPrice` are both zero

Safe reverts `execTransaction` only when `success || safeTxGas != 0 || gasPrice
!= 0` is false. Since the batch sets `requireSuccess` on every call, any failure
reverts the inner multicall — and with a non-zero `safeTxGas` that becomes a
_successful_ `execTransaction` emitting `ExecutionFailure`: the Safe nonce is
consumed, every signature already collected is void, and the batch looks
executed on-chain. With both fields zero the whole transaction reverts and the
nonce survives, so the proposal can be retried once the cause is fixed.

Zeroing `safeTxGas` does not starve the batch. When `gasPrice` is zero Safe
forwards `gasleft() - 2500` to the inner call and ignores `safeTxGas`, which
then only feeds the GS010 pre-check and the revert rule above.

The simulated total is still validated and returned as `simulatedGasUsed`
evidence — it is just not a field anyone signs.

Note this diverges from the browser-side `makeStageableSafeTransaction` in
`reya-safe-website`, which still sets `safeTxGas` to the summed `gasUsed`. The
two therefore derive different digests for the same batch. That is safe while
the local profile is QA-only and this worker is the production authority, but
the browser path should be brought in line before any shared proposal is
produced by both.

## Non-archival RPC

The available Reya RPC is not archival. Interactive current-state preview is
acceptable for MVP, but a request that needs pinned historical state fails
closed with `RPC_PINNED_STATE_UNAVAILABLE`. It never silently retries against
`latest`, because a reproducibility request answered from current state is worse
than no answer.

## Simulator activation

`PREVIEW_SIMULATOR_MODE` selects the simulator and still defaults to
`disabled`, under which `/preview/1729` fails closed and `/registry/op/resolve`
serves. Activating `fork` is a deployment decision, not a consequence of
upgrading.

### `fork`

A disposable Anvil fork of Reya Network running the reviewed read-only Cannon
build. One preview does, in order:

1. read the pinned `Reya-Labs/reya-deployments` bundle from the source gateway
   and re-hash every file and the canonical bundle;
2. assemble the Cannon definition from exactly those bytes;
3. read the previous package artifact from the facade, CID-verified, and take
   the package reference **from the artifact** rather than from the request;
4. start a disposable Anvil fork pinned to one block, with the credentialed
   upstream behind a loopback proxy;
5. run the build and return the ordered Safe calls.

Every one of those failing is a rejected request. There is no partial answer.

### What the simulator is not given

It never receives the Safe nonce, never derives a transaction and never
computes a digest — steps 2 to 5 of the sequence at the top of this file happen
after it returns, from chain state. A subverted simulator can therefore cause a
_failed_ preview; it cannot choose what an owner is asked to sign. The tests
assert this by rejecting a simulation whose Safe address, commit or package CIDs
do not match the request, and by checking that no nonce, transaction or digest
ever appears in what the simulator produces.

### Where trust actually sits

| Input                | Trusted? | What replaces trust                                                        |
| -------------------- | -------- | -------------------------------------------------------------------------- |
| source gateway       | no       | per-file and canonical SHA-256 re-hash against the requested commit        |
| artifact facade      | no       | every response re-hashed to the CID that was asked for                     |
| previous package     | pinned   | the request names the CID; the registry cannot answer a different one      |
| other package refs   | no       | `eth_call` to the Cannon registry on OP Mainnet, then Ethereum Mainnet     |
| build-time publishes | no       | process-local overlay, only for CIDs this run produced, never a pinned key |
| Reya RPC             | bounded  | one pinned block, probed before use; a pruned read fails the whole request |
| Anvil                | pinned   | exact version and commit SHA, or the fork refuses to start                 |

An unresolved package reference returns `null` and the build fails. No hosted
Cannon, Pinata or public IPFS path exists to fall back to.

### Bounds

8 MiB per source bundle and 50 MiB per artifact, at most 2048 artifact reads
and 256 distinct registry lookups per preview, a 30 s source deadline, a 60 s
artifact deadline, and the runner's own 240 s preview deadline threaded into
every upstream read so a sequence of individually quick calls cannot outlive the
request. Single-flight is already enforced by the runner.

### Runtime the image must provide

A `fork` worker needs two things the published image does not have yet, and
refuses to start without either:

- **Foundry**, exactly `anvil 1.2.3-v1.2.3` /
  `a813a2cee7dd4926e7c56fd8a785b54f32e0d10f`. Any other build is refused, so a
  preview is always produced by the reviewed EVM. Note this needs a glibc final
  stage: Foundry publishes no musl binary, and the image is Alpine today.
- **The Cannon engine**, resolved from the fixed specifiers
  `@reya/cannon-safe-ui/{assemble-definition,artifact-loader,ephemeral-artifact-overlay,preview-engine}`
  and `@usecannon/artifact-codec`. Those are workspace packages, so the image
  has to build them from the monorepo — which means widening the Docker build
  context beyond `packages/preview-worker`.

Neither specifier is configurable: no environment variable or request field
selects what gets imported, so an operator cannot substitute an engine. If the
image lacks it, `startServer` throws before the socket is opened rather than
serving previews from a degraded path.

Those image changes are deliberately not part of the change that added this
simulator: they alter the base image and the build context, and no workflow
builds this image today, so they cannot be verified alongside it. Until they
land, `PREVIEW_SIMULATOR_MODE` must stay `disabled` in every deployed profile —
and a profile that sets `fork` anyway will fail to start rather than serve.

## Configuration

| Variable                       | Notes                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `AUTH_PROXY_SECRET`            | ≥32 bytes, shared with the identity proxy                                                  |
| `AUTH_IDENTITY_HEADER`         | default `x-reya-user`                                                                      |
| `AUTH_PROXY_SECRET_HEADER`     | default `x-reya-proxy-secret`                                                              |
| `AUTH_ROLES_HEADER`            | default `x-reya-roles`                                                                     |
| `PREVIEW_UI_ORIGIN`            | exactly one canonical HTTPS origin, no port                                                |
| `PREVIEW_SAFE_ADDRESS`         | non-zero lowercase address                                                                 |
| `PREVIEW_SOURCE_COMMIT`        | pinned default `reya-deployments` commit                                                   |
| `PREVIEW_PREVIOUS_PACKAGE_CID` | pinned default previous-package CIDv0                                                      |
| `PREVIEW_RPC_URL`              | server-held; may carry a token, never logged                                               |
| `PREVIEW_OP_RPC_URL`           | server-held; OP Mainnet, alias resolution only                                             |
| `PREVIEW_SOURCE_ORIGIN`        | cluster-internal source gateway origin                                                     |
| `PREVIEW_ARTIFACT_ORIGIN`      | cluster-internal artifact facade origin                                                    |
| `PREVIEW_SIMULATOR_MODE`       | `disabled` (default) or `fork`                                                             |
| `PREVIEW_MAINNET_RPC_URL`      | server-held; Ethereum Mainnet, registry reads only — required only when the mode is `fork` |

`describeConfig` is the only thing start-up logs, and it reports credential
presence rather than any URL.

## Packaging

Like the source and RPC gateways, this is a standalone service package: it is
excluded from the root pnpm workspace and carries its own lockfile and image, so
a change here cannot re-resolve the monorepo's dependency graph.

## Tests

```bash
pnpm --dir packages/preview-worker --ignore-workspace install --frozen-lockfile --ignore-scripts
```

```bash
pnpm --dir packages/preview-worker --ignore-workspace test
```
