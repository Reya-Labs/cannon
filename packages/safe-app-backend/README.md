# Safe App Backend

This service accumulates Safe-owner signatures for Cannon transactions. The Safe remains the only execution authority: this service has no private key, signing endpoint or transaction-broadcast endpoint.

The Reya hardening profile is deliberately fail-closed:

- Redis/Valkey is mandatory and authoritative; there is no process-local proposal cache.
- Every RPC and Safe is explicitly allowlisted; each backend deployment is restricted to exactly one Safe.
- Only the current on-chain Safe nonce can be proposed.
- A proposer must create the first record with at least one current-owner signature.
- Signature updates are atomic, owner-keyed, replica-acknowledged before HTTP success and idempotent.
- A Redis-persisted Safe-nonce high-water mark rejects stale RPC regressions.
- Terminal records and per-nonce replacement counts expire; the audit stream is bounded.
- Browser identity is supplied by a trusted ingress and enforced again at the application layer.
- `PILOT_MODE=true` permits unattested test-Safe proposals. The current server refuses to start with pilot mode disabled until a production CI-attestation verifier is composed into the service.

Do not expose the container origin directly. The first deployment remains a single writer until the production failover and multi-replica race drills are approved.

## Build and test

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter backend build
pnpm --filter backend lint
REDIS_URL=redis://127.0.0.1:6379 pnpm --filter backend test
```

The integration suite requires a disposable Redis/Valkey instance and uses a unique key prefix per test. It exercises concurrent writers through independent Redis clients.

## Required configuration

| Variable            | Contract                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`         | Dedicated persistent, non-clustered Redis/Valkey URL. Production needs its own credentials, network policy, backups, no-eviction policy and restore drill. |
| `RPC_URLS`          | Comma-separated, explicit `<chainId>=<https-url>` entries. The server verifies every endpoint's chain ID and never falls back to public viem RPCs.         |
| `SAFE_ALLOWLIST`    | Exactly one `<chainId>:<safeAddress>` target per deployment. Its chain must have an explicit RPC. Duplicate identical entries are ignored.                 |
| `CORS_ORIGINS`      | Exact comma-separated browser origins. Wildcards and path-bearing URLs are rejected.                                                                       |
| `AUTH_PROXY_SECRET` | At least 32 bytes. A server-only ingress secret; it must never be shipped to the browser.                                                                  |
| `PILOT_MODE`        | `true` only for the bounded test-Safe pilot. The current server refuses to start with this disabled because the production verifier is not implemented.    |

Optional hardening settings:

| Variable                    | Default               | Purpose                                                                                                                |
| --------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `AUTH_PROXY_SECRET_HEADER`  | `x-reya-proxy-secret` | Ingress-only shared-secret header.                                                                                     |
| `AUTH_IDENTITY_HEADER`      | `x-reya-user`         | Stable authenticated actor identifier injected by ingress.                                                             |
| `AUTH_ROLES_HEADER`         | `x-reya-roles`        | Comma-separated `proposer`, `signer` and/or `operator` roles injected by ingress.                                      |
| `TRUST_PROXY`               | disabled              | Exact Express proxy trust value: `false`, hop count or comma-separated IP/CIDR values. Blanket `true` is rejected.     |
| `PROPOSAL_TTL_SECONDS`      | `86400`               | Active proposal lifetime, maximum seven days.                                                                          |
| `MAX_BLOCK_AGE_SECONDS`     | `120`                 | Readiness freshness bound for the latest RPC block.                                                                    |
| `BODY_LIMIT`                | `1mb`                 | JSON body limit. Calldata is separately capped at 512 KiB.                                                             |
| `RATE_LIMIT`                | `120`                 | Per-identity requests per window.                                                                                      |
| `RATE_LIMIT_WINDOW_MS`      | `60000`               | Identity rate-limit window.                                                                                            |
| `REDIS_PREFIX`              | `safe-app-backend:v2` | Key prefix. Use a unique prefix per environment even though production instances must remain separate.                 |
| `REDIS_MIN_REPLICAS`        | `1`                   | Required replica acknowledgements before success/readiness. `0` is only for disposable local development.              |
| `REDIS_WAIT_TIMEOUT_MS`     | `2000`                | Maximum wait for the required Redis replica acknowledgements.                                                          |
| `HISTORY_RETENTION_SECONDS` | `2592000`             | Retention for terminal records, idempotency results and per-nonce replacement counts; it must exceed the proposal TTL. |
| `MAX_PROPOSALS_PER_NONCE`   | `20`                  | Maximum distinct proposals for one Safe nonce during the retention window.                                             |
| `AUDIT_MAX_LENGTH`          | `100000`              | Approximate maximum Redis audit-stream length; export it to long-term Reya audit storage.                              |
| `READINESS_CACHE_MS`        | `5000`                | Coalescing/cache window for dependency-heavy readiness checks.                                                         |
| `PORT`                      | `8080`                | HTTP port.                                                                                                             |

Example test-pilot configuration:

```sh
REDIS_URL=redis://valkey.internal:6379 \
RPC_URLS=1729=https://rpc.internal.example \
SAFE_ALLOWLIST=1729:0x1111111111111111111111111111111111111111 \
CORS_ORIGINS=https://cannon.example \
AUTH_PROXY_SECRET=replace-with-a-server-only-secret-of-at-least-32-bytes \
PILOT_MODE=true \
pnpm --filter backend start
```

## Identity boundary

The ingress must:

1. be the only network path to the container;
2. authenticate the user;
3. remove every client-supplied proxy-secret, identity and role header;
4. inject the server-only proxy secret plus the authenticated subject and application roles;
5. use TLS to the origin and rotate the proxy secret through the platform secret manager.

The browser does not receive or send the identity headers. CORS allows `Content-Type`, `X-Request-Id` and `X-Idempotency-Key`; the trusted ingress adds identity after accepting the browser request.

Roles are intentionally separate:

- `proposer`: create the first active proposal at the current Safe nonce and sign existing proposals;
- `signer`: read and add valid signatures to an existing proposal, but cannot create one;
- `operator`: read and supersede an active proposal, but cannot submit signatures.

Every submitted signature is still recovered and checked against the current on-chain Safe owner set. The actor identity and recovered signer are recorded separately in the audit stream.

Roles are not yet scoped independently by Safe. To keep an operator for one multisig from affecting another, startup rejects configurations containing more than one distinct Safe. Deploy a separate backend, Redis prefix and ingress policy per Safe until Safe-scoped authorization is implemented.

## Signature policy

The current Cannon website signs the Safe transaction digest with EIP-712 and submits a 65-byte EOA signature. This backend supports only that form with `v=27` or `v=28`.

The following Safe encodings fail closed until they receive a separate design, parser and test matrix:

- `eth_sign` signatures (`v=31` or `v=32`);
- approved-hash signatures (`v=1`);
- EIP-1271/contract signatures (`v=0` and dynamic signature data).

Signatures are recovered, restricted to current owners, deduplicated by owner, sorted by owner address and validated through the Safe's `checkNSignatures` function.

## HTTP contract

All proposal routes require trusted-ingress identity.

### `GET /:chainId/:safeAddress`

Returns zero or one active proposal at the current on-chain nonce. Signatures from removed owners are omitted immediately. A nonce advance tombstones older active proposals as stale.

### `POST /:chainId/:safeAddress`

Preserves the Cannon website request shape:

```json
{
  "txn": {
    "to": "0x2222222222222222222222222222222222222222",
    "value": "0",
    "data": "0x",
    "operation": "0",
    "safeTxGas": "0",
    "baseGas": "0",
    "gasPrice": "0",
    "gasToken": "0x0000000000000000000000000000000000000000",
    "refundReceiver": "0x1111111111111111111111111111111111111111",
    "_nonce": 7
  },
  "sigs": ["0x...65-byte-signature..."]
}
```

`createdAt` and `updatedAt` are accepted for compatibility with reposted website responses but ignored. The server supplies authoritative timestamps.

Creation requires the `proposer` role. Once active, either a `proposer` or `signer` may submit additional signatures. A different transaction hash at the same nonce returns `409`; identical retries are idempotent.

The hardened backend intentionally stages only the current on-chain Safe nonce. The existing Cannon UI's queued-future-nonce and local "override" controls are therefore not compatible with this API; PRO-694 must switch replacement to the explicit supersede flow before the Reya UI pilot.

The optional `attestation` envelope is reserved for the production admission verifier:

```json
{
  "format": "future-versioned-format",
  "payload": "...",
  "signature": "..."
}
```

Pilot mode rejects supplied attestations rather than pretending to validate them. An injected app-level verifier fails mutations with `503 production_admission_unconfigured`; the packaged server also refuses to start with pilot mode disabled until PRO-693 supplies the production verifier.

### `POST /:chainId/:safeAddress/supersede`

Requires `proposer` or `operator`, a bounded reason, the exact reviewed digest and a stable `X-Idempotency-Key` header:

```json
{
  "expectedDigest": "0x...32-byte-safe-transaction-hash...",
  "reason": "Reviewed replacement required"
}
```

The Lua transition is compare-and-set on `expectedDigest`; a delayed operator request cannot supersede a replacement. Repeating the same idempotency key and digest returns the original result after an ambiguous network failure. The idempotency record retains the original nonce, so a retry after the Safe advances repairs any interrupted stale-status transition and still returns `409 safe_nonce_advanced`. The old proposal and signatures remain immutable for the retention window. The same digest cannot be reactivated during that window; a replacement must be a newly reviewed payload.

### Health

- `GET /livez`: process liveness only.
- `GET /readyz` and `GET /health`: coalesced Redis durability plus chain-ID, block-freshness, Safe bytecode, owner and threshold checks for every configured target.

Readiness failures expose only a stable error code, not internal endpoint or credential details. Keep all health routes on the private ingress/orchestrator network; only `/livez` is cheap process liveness.

## Persistence and recovery

Redis keys separate:

- one active digest reservation per `(chainId, Safe, nonce)`;
- proposal metadata retained for a bounded recovery/audit window;
- one signature field per recovered owner;
- a monotonic per-Safe on-chain nonce fence;
- active-nonce and bounded per-nonce replacement state;
- an approximately length-bounded audit stream that must be exported to long-term storage.

Lua scripts type-check their complete key set before mutation, then perform same-nonce reservation, signature union, idempotent replay, Redis-time expiry, stale-nonce reconciliation and compare-and-set supersession atomically. Each mutation, a unique durability-marker write and `WAIT` execute in one Redis connection pipeline, preventing a reconnect from acknowledging a different primary offset. A mutation returns success only after the configured number of replicas acknowledges that pipeline. Redis failure returns `503`; no in-memory fallback acknowledges data.

`WAIT` protects managed failover but is not a disk-fsync guarantee. The Redis/Valkey deployment remains responsible for persistent storage, multi-AZ failover, backup policy and restore testing. Readiness fails when the configured replica acknowledgement count is unavailable.

Restore procedure:

1. restore the dedicated no-eviction Redis/Valkey backup;
2. keep mutations disabled;
3. verify every configured chain, Safe, current nonce, owner set and threshold;
4. read current proposals so stale nonce and removed-owner state is reconciled;
5. compare the exported audit tail and retained proposal/signature records;
6. re-enable the single writer and run an idempotent signer retry.

Production mainnet admission remains blocked until PRO-693 supplies the reviewed CI-attestation verifier and the complete proposal flow passes the PRO-695 test-Safe and recovery drills.
