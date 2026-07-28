# Cannon indexer workloads

The indexer image contains three independent entrypoints:

- `node dist/registry/index.js` runs only the credential-free registry producer.
- `node dist/artifact-worker/index.js` runs only the artifact mirror worker.
- `node dist/4byte-directory/index.js` is the optional, one-shot 4byte enrichment worker.

`pnpm start` and `pnpm start-artifact-worker` target the NCC bundle paths.
After a TypeScript-only `pnpm build`, use `pnpm start:compiled` or
`pnpm start-artifact-worker:compiled` instead.

The registry bundle never imports or starts either worker. Worker startup or runtime failure therefore cannot stop registry scanning or enqueueing.

## Registry configuration

Production and staging require explicit `MAINNET_PROVIDER_URL` and `OPTIMISM_PROVIDER_URL` values using non-loopback HTTPS or WSS endpoints. Startup verifies chain IDs 1 and 10 before connecting to Redis or starting the queue worker. The image has no production RPC fallback.

## Registry durability foundations (not active)

`registry-event-envelope.ts` and `registry-checkpoint.ts` define the first versioned, JSON-safe durability contracts for the registry indexer. They are intentionally not imported by the current registry loop. Activating them before the durable inbox, atomic projection and reorg checks exist would mix the legacy `reg:*` queues/checkpoints with the new format and could create partial processing semantics.

The eventual integration must use a fresh versioned Redis namespace. Before scanning from an existing checkpoint, it must fetch that checkpoint's block and verify the stored block hash; only an absent checkpoint is a cold-start signal. A valid checkpoint resumes from the following block. Durable ingestion must also impose explicit serialized-envelope, URL, publisher-count and batch-size bounds before parsing or deduplicating untrusted persisted state; those limits belong to the inbox design and are not active in these format-only helpers.

The legacy `PackagePublish` event did not contain fee data. Its V1 envelope therefore uses `feePaid: null`; consumers must preserve that as unknown rather than treating it as a zero payment.

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
