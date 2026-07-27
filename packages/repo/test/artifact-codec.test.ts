import { describe, expect, it } from 'vitest';
import { loadFixture } from './helpers/fixtures';

const FIXTURE_CIDS = {
  'greeter-misc': 'QmVmroUSFBwiAUUG5on3sHwrGTQ2bSwR4vFpsuhAQWDqvZ',
  greeter: 'QmXn5Qa3shY6vDDzeR76HsN53WnHaudQPWpHdwAt2JiLtT',
  'owned-greeter-misc': 'QmWPYWDSbBvDu1D2S2mb3vfBT59Z3dMvwaWHKmLfpU6ABC',
  'owned-greeter': 'QmPCCWJSTwiCviwL57UvPW4cmz2bNwJx2sNttgXBMuFtgg',
  'registry-misc': 'Qmb276cgTKrZULAR1RUUuXBAzFASkCMXLXaWodtb6LxMVZ',
  registry: 'QmYrLsLZwGGg68XwGkdrx8q9KaRSHq7e5sa6PbT7kNXjKw',
} as const;

describe('artifact fixture CIDs', () => {
  it.each(Object.entries(FIXTURE_CIDS))('preserves %s', async (name, expectedCid) => {
    await expect(loadFixture(name)).resolves.toMatchObject({ cid: expectedCid });
  });
});
