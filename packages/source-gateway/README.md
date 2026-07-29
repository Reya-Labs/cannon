# Reya Cannon source gateway

This service exposes one immutable, bounded source bundle for the Reya Cannon
GitOps flow. It accepts only:

```text
GET /source/reya-deployments/<lowercase-40-character-commit>/reya-network
```

The upstream is fixed to the public `Reya-Labs/reya-deployments` GitHub
codeload archive. The response contains the root
`packages/tomls/src/omnibus/reya_network.toml` and its complete reachable TOML
include graph, sorted deterministically and bound to both per-file and bundle
SHA-256 digests.

The gateway does not implement a generic Git proxy. Repository names, paths,
branches, tags, credentials, redirects, and arbitrary upstream hosts are not
accepted.

## Required configuration

| Variable            | Purpose                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `AUTH_PROXY_SECRET` | At least 32 bytes. Shared only with the origin-unreachable identity proxy. |
| `SOURCE_UI_ORIGIN`  | Exact canonical HTTPS origin allowed by CORS.                              |

Optional settings are `AUTH_IDENTITY_HEADER` (default `x-reya-user`),
`AUTH_PROXY_SECRET_HEADER` (default `x-reya-proxy-secret`), `PORT` (default
`8080`), `RATE_LIMIT` (default `60`), `RATE_LIMIT_WINDOW_MS` (default `60000`),
and `TRUST_PROXY` (default `false`). `TRUST_PROXY=true` is forbidden; use an
exact hop count or proxy IP/CIDR.

The browser never receives or sends the proxy secret. The trusted ingress adds
the identity and proxy-authentication headers after stripping any client
supplied copies.

## Local verification

```sh
pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm build
pnpm test
RUN_NETWORK_TESTS=1 pnpm test
```

The opt-in network test downloads one pinned public archive and verifies the
real `reya_network.toml` include closure. It never writes to GitHub or GCP.
