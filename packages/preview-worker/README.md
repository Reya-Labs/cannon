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

## Non-archival RPC

The available Reya RPC is not archival. Interactive current-state preview is
acceptable for MVP, but a request that needs pinned historical state fails
closed with `RPC_PINNED_STATE_UNAVAILABLE`. It never silently retries against
`latest`, because a reproducibility request answered from current state is worse
than no answer.

## Simulator activation

The worker ships dormant, matching the rest of the signer plane. The route
exists, is authenticated, bounded and fail-closed, but `PREVIEW_SIMULATOR_MODE`
currently supports only `disabled`, under which `/preview/1729` fails closed and
`/registry/op/resolve` still serves.

The fork-backed simulator — a disposable Anvil fork of Reya Network running the
Cannon build against the source gateway and the GCS-backed artifact facade —
lands as its own change, so that the derivation boundary above can be reviewed
on its own terms.

## Configuration

| Variable                       | Notes                                          |
| ------------------------------ | ---------------------------------------------- |
| `AUTH_PROXY_SECRET`            | ≥32 bytes, shared with the identity proxy      |
| `AUTH_IDENTITY_HEADER`         | default `x-reya-user`                          |
| `AUTH_PROXY_SECRET_HEADER`     | default `x-reya-proxy-secret`                  |
| `AUTH_ROLES_HEADER`            | default `x-reya-roles`                         |
| `PREVIEW_UI_ORIGIN`            | exactly one canonical HTTPS origin, no port    |
| `PREVIEW_SAFE_ADDRESS`         | non-zero lowercase address                     |
| `PREVIEW_SOURCE_COMMIT`        | pinned default `reya-deployments` commit       |
| `PREVIEW_PREVIOUS_PACKAGE_CID` | pinned default previous-package CIDv0          |
| `PREVIEW_RPC_URL`              | server-held; may carry a token, never logged   |
| `PREVIEW_OP_RPC_URL`           | server-held; OP Mainnet, alias resolution only |
| `PREVIEW_SOURCE_ORIGIN`        | cluster-internal source gateway origin         |
| `PREVIEW_ARTIFACT_ORIGIN`      | cluster-internal artifact facade origin        |
| `PREVIEW_SIMULATOR_MODE`       | `disabled`                                     |

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
