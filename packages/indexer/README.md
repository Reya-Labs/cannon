# Cannon indexer workloads

The indexer image contains two independent entrypoints:

- `node dist/registry/index.js` is the default, canonical registry indexer.
- `node dist/4byte-directory/index.js` is the optional, one-shot 4byte enrichment worker.

The registry entrypoint never imports or starts the enrichment worker. A deployment can therefore deny 4byte egress without affecting registry progress.

## Registry configuration

Production and staging require explicit `MAINNET_PROVIDER_URL` and `OPTIMISM_PROVIDER_URL` values using non-loopback HTTPS or WSS endpoints. Startup verifies chain IDs 1 and 10 before connecting to Redis or starting the queue worker. The image has no production RPC fallback.

## Optional 4byte enrichment

Enrichment is disabled by default. Running the worker without `FOURBYTE_ENABLED=true` exits successfully without connecting to Redis or making a network request.

An enabled worker requires:

- `FOURBYTE_BASE_URL`: an HTTPS origin such as `https://www.4byte.directory`;
- `FOURBYTE_REDIS_URL`: its explicit Redis connection;
- `FOURBYTE_ENABLED=true`.

The following optional bounds have conservative defaults:

- `FOURBYTE_MAX_PAGES_PER_FEED=25`;
- `FOURBYTE_MAX_ENTRIES_PER_RUN=10000`;
- `FOURBYTE_MAX_RESULTS_PER_PAGE=1000`;
- `FOURBYTE_MAX_RESPONSE_BYTES=2097152`;
- `FOURBYTE_REQUEST_TIMEOUT_MS=10000`;
- `FOURBYTE_RETRIES=3`;
- `FOURBYTE_RETRY_BASE_MS=250`;
- `FOURBYTE_RETRY_MAX_MS=5000`.

Each successful page and its next cursor are committed in one Redis transaction. Enrichment keys live under `enrichment:4byte:*`, separately from canonical `reg:*` keys, and are marked `source=4byte.directory` and `trust=unverified`. Pagination is restricted to the configured non-loopback HTTPS origin, redirects are rejected, response bodies are always released, and response, page, run, timeout and retry bounds are enforced.

Untrusted enrichment is deliberately excluded from the canonical `reg:abi` index. A fresh query plane creates the display-only `enrichment:4byte:abi-search` index over `enrichment:4byte:abi:`. The package-query API does not query that index; any future consumer must expose it through an explicitly unverified display path and must never use it for signer decisions or canonical ABI precedence.

Do not enable the worker against an existing Redis Stack until an explicit migration creates the separate index and `FT.INFO` proves that `reg:abi` has only the `reg:abi:` prefix while `enrichment:4byte:abi-search` has only the `enrichment:4byte:abi:` prefix. The normal registry startup deliberately does not rewrite an existing search schema.
