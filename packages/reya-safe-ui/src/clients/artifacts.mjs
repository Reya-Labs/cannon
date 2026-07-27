import { REYA_READ_LIMITS } from './config.mjs';
import { fail } from './errors.mjs';
import { isCanonicalCidV0, validateCidInput } from './schema.mjs';
import { boundedRequest } from './transport.mjs';

export const ARTIFACT_CAT_PATH = '/artifacts/api/v0/cat';

export function createArtifactClient(config) {
  return Object.freeze({
    async cat(input) {
      const cid = validateCidInput(input);
      const url = new URL(config.serviceOrigin);
      url.pathname = ARTIFACT_CAT_PATH;
      url.searchParams.set('arg', cid);

      const bytes = await boundedRequest({
        accept: 'application/octet-stream',
        deadlineMs: config.artifactDeadlineMs,
        fetchImpl: config.fetchImpl,
        maximumBytes: REYA_READ_LIMITS.artifactBytes,
        method: 'POST',
        responseMediaType: 'application/octet-stream',
        url: url.href,
      });

      let computedCid;
      try {
        computedCid = await config.verifyArtifactCid(bytes.slice());
      } catch {
        fail('ARTIFACT_MISMATCH');
      }
      if (!isCanonicalCidV0(computedCid) || computedCid !== cid) {
        fail('ARTIFACT_MISMATCH');
      }
      return bytes;
    },
  });
}
