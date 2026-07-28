# Cannon Query API

The query API exposes read-only Cannon registry search data from Redis.

Production and staging configuration is fail closed:

| Variable               | Requirement                                                             |
| ---------------------- | ----------------------------------------------------------------------- |
| `REDIS_URL`            | Explicit `redis://` or `rediss://` endpoint                             |
| `CORS_ORIGINS`         | Comma-separated exact HTTPS browser origins; wildcards are rejected     |
| `METRICS_USER`         | Explicit Prometheus basic-auth username                                 |
| `METRICS_PASSWORD`     | Explicit Prometheus basic-auth password of at least 16 bytes            |
| `TRUST_PROXY`          | Disabled by default; exact proxy IP/CIDR in production/staging          |
| `READINESS_CACHE_MS`   | Successful or failed readiness result cache, 10-60000 ms (default 5000) |
| `READINESS_TIMEOUT_MS` | Redis readiness probe deadline, 10-30000 ms (default 2000)              |

The HTTP listener starts independently from the background Redis connection. `GET /livez` proves only that the HTTP process is alive; `GET /readyz` returns 200 only when Redis answers `PING` and both canonical RediSearch indexes (`reg:packages` and `reg:abi`) answer `FT.INFO` before the configured deadline. Data routes fail closed while Redis is unavailable. The display-only 4byte enrichment index is deliberately not a query API dependency.

Search input is bounded before any Redis query: at most 20 chain IDs, 20 selectors, a 256-character text query, and supported document/selector types only. Aggregate namespace output is capped at 100 groups; indexed-chain output and package/tag lookup fanout are capped at 50.
