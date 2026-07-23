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
- `MAX_ARTIFACT_BYTES`: maximum upload size; defaults to 50 MiB.

Reads are local-only. A missing CID returns 404; the service does not contact a
public IPFS gateway or hosted Cannon repository at runtime. Backfill legacy
artifacts into S3 and verify their CIDs before activating this endpoint.

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

## Integrity failure recovery

Artifact reads fail closed if the bytes stored at a CID key do not recompute to
that CID. The immutable `putObject` path will not overwrite the corrupted
object automatically. An operator must quarantine and remove the exact
`${S3_FOLDER}/${CID}` object, verify the replacement bytes locally against the
CID, and then re-publish the verified artifact. Keep this remediation
restricted to the single affected key and record it in the operational audit
trail.
