# Reya Cannon RPC gateway

This package is the fail-closed, browser-safe JSON-RPC boundary for Reya's self-hosted Cannon signer. It is
standalone and stateless. It does not publish an image, configure infrastructure, or activate the signer UI.

## Security contract

- The only RPC route is `POST /rpc/1729`; clients cannot choose a chain, provider, URL, headers, or redirects.
- Exactly two distinct HTTPS provider hosts are configured from server-side secrets. Their credentials never enter
  browser configuration, response bodies, health output, metrics, or logs.
- Both providers must agree on chain 1729, a fresh common block, the Safe bytecode, nonce, ordered owners, and
  threshold. Every allowed state read is executed against both providers at the agreed numeric block. Any timeout,
  malformed response, disagreement, or stale block fails closed.
- `latest` is rewritten to the agreed numeric block and `pending`, future blocks, state overrides, batches,
  notifications, unknown methods, signing, broadcast, account, wallet, admin, debug, trace, txpool, engine, miner,
  EVM, Anvil, and Hardhat methods are rejected.
- Requests require the exact UI `Origin` plus headers injected by a trusted identity proxy. Body, calldata, response,
  rate, connection, concurrency, queue, and time limits are bounded.

The initial allowlist is deliberately small: chain and block identity, block lookup, balance, nonce, code, storage,
`eth_call`, and transaction/receipt lookup. A captured Cannon integration run must justify any expansion.

## Configuration

| Variable                   | Purpose                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `RPC_UPSTREAM_URLS_JSON`   | Exactly two canonical HTTPS JSON-RPC endpoint URL strings on distinct provider hosts |
| `SAFE_ADDRESS`             | The fixed Reya mainnet Safe checked by readiness                                     |
| `RPC_UI_ORIGIN`            | Exact canonical HTTPS signer UI origin                                               |
| `AUTH_PROXY_SECRET`        | At least 32 bytes, injected only by the trusted identity proxy                       |
| `AUTH_IDENTITY_HEADER`     | Identity header name; defaults to `x-reya-user`                                      |
| `AUTH_PROXY_SECRET_HEADER` | Proxy-authenticator header name; defaults to `x-reya-proxy-secret`                   |
| `TRUST_PROXY`              | Exact proxy hop count or IP/CIDR; blanket `true` is forbidden                        |

The remaining limit variables have conservative defaults in `src/config.ts`. Upstream URL values are secrets because
provider API keys commonly appear in their paths. Do not put real values in source, CI, command lines, or logs.
Rate, weighted-cost, concurrency, and queue state is local to one process. PRO-719 must pin the initial replica count
or calculate and load-test the aggregate limits before scaling horizontally.

## Activation boundary

Activation must use two genuinely independent provider accounts, route the browser only through this gateway, and
route Safe backend reads through a private authenticated gateway path or the same quorum client. PRO-715/PRO-716 own
the captured Test-Safe integration evidence and CSP/runtime wiring; PRO-719 owns deployment.

## Published image

`ghcr.io/reya-labs/rpc-gateway`, tagged with the source revision and addressed by digest.
`.github/workflows/rpc-gateway-publish.yml` runs this package's full CI workflow — including the image build, the
Trivy scan and `scripts/verify-image.sh` — and publishes only if that succeeded, only from a protected `dev` head,
only inside the `cannon-image-publish` environment, and only while the `CANNON_RPC_GATEWAY_PUBLISH_ENABLED`
repository variable is `true`. The pushed digest is re-pulled, re-verified and attested before the run reports
success.
