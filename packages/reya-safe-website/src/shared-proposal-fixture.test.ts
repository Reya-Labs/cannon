import { describe, expect, it } from 'vitest';
import { createSharedProposalPreviewFixture, E2E_COMMIT, E2E_SAFE } from '../test-support/shared-proposal-fixture.mjs';
import { parseReyaPreview } from './preview';

const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const BUNDLE_SHA256 = 'ab'.repeat(32);

describe('deterministic shared-proposal browser fixture', () => {
  it('is admitted by the production preview parser', () => {
    expect(
      parseReyaPreview(
        JSON.stringify(
          createSharedProposalPreviewFixture({
            bundleSha256: BUNDLE_SHA256,
            previousPackageCid: CID,
          })
        ),
        {
          commit: E2E_COMMIT,
          partialDeployCid: null,
          previousPackageCid: CID,
          safeAddress: E2E_SAFE,
          sourceBundleSha256: BUNDLE_SHA256,
        }
      ).safeProposalCalls
    ).toHaveLength(1);
  });
});
