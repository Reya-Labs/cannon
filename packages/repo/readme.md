# Cannon artifact repository

The service exposes the Kubo-compatible `POST /api/v0/add` and
`POST /api/v0/cat` endpoints expected by Cannon. Artifact bytes are stored
under their CID in Google Cloud Storage or S3-compatible object storage.
Redis/Valkey stores the mutable package index used by authenticated uploads.

All writes require a bearer token. Reads remain unauthenticated so browser and
CLI consumers do not receive reusable write credentials. Cannon CLI publishers
can provide the token through `CANNON_IPFS_AUTH_TOKEN`; keep it in the CI secret
store rather than `CANNON_SETTINGS` or browser configuration.

## Required production configuration

- `REPO_ROLE`: `reader` or `writer`. Production GCS deployments reject the
  legacy `combined` role so browser reads and authenticated writes cannot share
  one workload identity.
- `OBJECT_STORE_PROVIDER`: `gcs` (recommended on GKE) or `s3`.
- `GCS_PROJECT_ID`, `GCS_BUCKET`, `GCS_FOLDER`: native GCS storage. The project
  is optional when Application Default Credentials can infer it.
- `API_TOKEN_SECRET`: writer-only secret used to validate upload tokens.
- `REDIS_URL`: writer-only persistent Valkey/Redis endpoint.
- `MAX_ARTIFACT_BYTES`: maximum upload size; defaults to 50 MiB.
- `CORS_ALLOWED_ORIGINS`: optional comma-separated list of exact browser
  origins. CORS is disabled when empty. Production and staging accept only
  exact HTTPS origins and reject `*`, paths, and plaintext HTTP.

Run separate reader and writer workloads. The reader mounts only
`POST|HEAD /api/v0/cat` and `/health`; it does not initialize Redis, load the API
token, or mount the upload route. The writer mounts `POST /api/v0/add`,
`/health`, and authenticated `GET /health/write` for artifact-worker readiness.
Route separation is a second boundary in addition to cloud IAM.
Leave writer CORS disabled unless an explicitly reviewed browser publisher is
required. Browser-facing readers should allow only the exact deployment
origins; CLI and server-to-server requests do not require CORS.

### Native GCS permissions

Use Workload Identity Federation for GKE and Application Default Credentials;
do not create or mount service-account keys. Bind different Kubernetes service
accounts to different Google service accounts:

- Reader: grant only `storage.objects.get` for the artifact bucket/prefix.
- Writer: grant only `storage.objects.create` and `storage.objects.get` for the
  artifact bucket/prefix. Read access is required to prove that an idempotent
  retry contains identical bytes. Do not grant update or delete.

The writer health check creates a fixed
`${GCS_FOLDER}/.cannon/capabilities/conditional-create-v1` marker with
`ifGenerationMatch=0`, proves that a conflicting create receives HTTP 412, and
then verifies the marker bytes. The reader health check verifies that same
marker, so deploy the writer once before requiring reader readiness. This
fails closed if an emulator, proxy, or backend ignores the create-only
precondition.

Before activation, use a known backfilled CID to prove that the reader can read
objects and separately prove that it receives `403 AccessDenied` when trying a
disposable conditional create. The service health check verifies backend
semantics, but it cannot infer every provider-side permission attached to the
reader identity.

### S3-compatible deployments

Set `S3_ENDPOINT`, `S3_BUCKET`, `S3_FOLDER`, `S3_REGION` and the credentials for
the active role:

- Reader: `S3_READ_KEY`, `S3_READ_SECRET`.
- Writer: `S3_WRITE_KEY`, `S3_WRITE_SECRET`.

The `combined` S3 role remains available for backward compatibility.
Production and staging reject identical read/write access-key IDs in that
role. New Reya deployments should use native GCS and split workloads.

Reads are local-only. A missing CID returns 404; the service does not contact a
public IPFS gateway or hosted Cannon repository at runtime. Backfill legacy
artifacts into the selected bucket and verify their CIDs before activating this
endpoint.

## Generate JWT token

```bash
API_TOKEN_SECRET=someSecret npx tsx src/scripts/generateToken.ts
```

## Validate JWT token

```bash
API_TOKEN_SECRET=someSecret npx tsx src/scripts/validateToken.ts "someToken"
```

## Upload an artifact

1. Start the `repo` service
2. Generate a token using the repository's `API_TOKEN_SECRET`
3. Execute the following command, replacing `JWT_TOKEN` and `artifact.bin`
   with the token and artifact path.

```bash
 curl -X POST \
  "http://localhost:8081/api/v0/add" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -F "file=@./artifact.bin"
```

Directory uploads (`?wrap-with-directory=true`) are deliberately unsupported
and return 501. Reya hosts website bundles through its normal static-asset
pipeline, so the artifact service does not require Pinata credentials.

The isolated artifact worker uses
`POST /api/v0/add?expected-cid=<CID>&local=true&to-files=/<CID>`. The writer
independently computes the upload CID, returns 422 without writing when it does
not match, and verifies identical bytes on replay. A matching `expected-cid`
allows the authenticated worker to store non-package closure members such as
on-chain metadata; ordinary uploads without it retain the existing package and
Redis admission checks.

## Integrity failure recovery

Artifact reads fail closed if the bytes stored at a CID key do not recompute to
that CID. The immutable `putObject` path will not overwrite the corrupted
object automatically. An operator must quarantine and remove the exact
`${GCS_FOLDER}/${CID}` (or `${S3_FOLDER}/${CID}`) object, verify the replacement
bytes locally against the CID, and then re-publish the verified artifact. Keep
this break-glass remediation restricted to the single affected key, separate
it from the runtime identities, and record it in the operational audit trail.
