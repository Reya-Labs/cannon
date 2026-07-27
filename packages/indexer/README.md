# Cannon indexer workloads

The indexer image contains three independent entrypoints:

- `node dist/registry/index.js` runs only the credential-free registry producer.
- `node dist/artifact-worker/index.js` runs only the artifact mirror worker.
- `node dist/4byte-directory/index.js` is the optional, one-shot 4byte enrichment worker.

The registry bundle never imports or starts either worker. Worker startup or runtime failure therefore cannot stop registry scanning or enqueueing.

## Registry configuration

Production and staging require explicit `MAINNET_PROVIDER_URL` and `OPTIMISM_PROVIDER_URL` values using non-loopback HTTPS or WSS endpoints. Startup verifies chain IDs 1 and 10 before connecting to Redis or starting the queue worker. The image has no production RPC fallback.

## Registry/artifact-worker isolation

Deploy the registry and artifact worker as separately supervised workloads
against the same `REDIS_URL` and `QUEUE_NAME`. Keep activation held until the
worker health check passes against both facades and Redis.

The worker has no S3 or GCS configuration. It requires:

- `ARTIFACT_SOURCE_URL`: an explicit reader-facade origin implementing bounded
  Kubo-compatible `POST /api/v0/cat?arg=<cid>` reads;
- `ARTIFACT_WRITER_URL`: an explicit Reya writer-facade origin;
- `ARTIFACT_WRITER_TOKEN`: the bearer token used only for writer health and
  `POST /api/v0/add?expected-cid=<cid>` requests;
- the shared Redis and queue configuration.

Production and staging facade URLs must be non-loopback HTTPS origins. The
worker rejects redirects, applies deadlines, streams responses into explicit
bounds, independently recomputes every CID, and discovers the complete package
closure before writing. A package job mirrors the root, every recursive import,
every `miscUrl`, and each non-empty on-chain metadata CID. Writer responses are
reconciled as an exact set, including missing and extra members, and replays are
idempotent.

Resource controls are configurable with `ARTIFACT_FETCH_TIMEOUT_MS`,
`ARTIFACT_WRITE_TIMEOUT_MS`, `ARTIFACT_READINESS_TIMEOUT_MS`,
`ARTIFACT_MAX_FETCH_BYTES`, `ARTIFACT_MAX_NODE_BYTES`,
`ARTIFACT_MAX_COMPRESSED_BYTES`, `ARTIFACT_MAX_INFLATED_BYTES`,
`ARTIFACT_MAX_CLOSURE_BYTES`, `ARTIFACT_MAX_CLOSURE_INFLATED_BYTES`,
`ARTIFACT_MAX_CLOSURE_NODES`, and `ARTIFACT_MAX_WRITE_RESPONSE_BYTES`.

Legacy unversioned jobs remain valid and retain their original job IDs. New
package jobs may include normalized `metadataCids`; their deterministic job ID
includes the metadata set so a second publication of the same root with
different metadata cannot be discarded as a duplicate.

Both process entrypoints handle `SIGINT` and `SIGTERM` by closing their owned
Redis, queue, and worker resources. The image build asserts after NCC that the
registry bundle contains no artifact handler, writer token, object-store SDK, or
`@usecannon/repo` code.

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
