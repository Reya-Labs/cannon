# Cannon artifact repository

The service exposes the Kubo-compatible `POST /api/v0/add` and
`POST /api/v0/cat` endpoints expected by Cannon. Artifact bytes are stored
under their CID in S3-compatible object storage and indexed in Redis/Valkey.

All writes require a bearer token. Reads remain unauthenticated so browser and
CLI consumers do not receive reusable write credentials. Cannon CLI publishers
can provide the token through `CANNON_IPFS_AUTH_TOKEN`; keep it in the CI secret
store rather than `CANNON_SETTINGS` or browser configuration.

## Required production configuration

- `API_TOKEN_SECRET`: secret used to validate write tokens.
- `REDIS_URL`: dedicated persistent Valkey/Redis endpoint.
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_FOLDER`, `S3_REGION`, `S3_KEY`, `S3_SECRET`:
  private S3-compatible object storage.
- `IPFS_URL`: temporary read fallback during migration.
- `MAX_ARTIFACT_BYTES`: maximum upload and fallback response size; defaults to
  50 MiB.
- `MAX_ARCHIVE_FILES` and `MAX_ARCHIVE_EXTRACTED_BYTES`: folder-upload
  expansion limits; default to 1,000 files and 50 MiB.
- `UPSTREAM_TIMEOUT_MS`: fallback request timeout; defaults to 30 seconds.

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
  -H "Content-Type: multipart/form-data" \
  -F "file=@./artifact.bin"
```

Folder uploads use the same authentication requirement and add
`?wrap-with-directory=true`.
