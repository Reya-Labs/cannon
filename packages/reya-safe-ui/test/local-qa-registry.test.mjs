import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalQaRegistry } from '../test-support/local-qa-registry.mjs';

const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const OTHER = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const REFERENCE = 'reya-core:1.0.26@router';

function registry() {
  return createLocalQaRegistry({
    manifest: {
      baseline: {
        chainId: 1729,
        deployCid: CID,
        fullPackageRef: 'reya-omnibus:1.0.158@main',
      },
      resolutions: [
        {
          chainId: 13370,
          deployCid: CID,
          fullPackageRef: REFERENCE,
        },
      ],
    },
    verifiedCids: new Set([CID]),
  });
}

test('local QA registry resolves only pinned manifest entries', async () => {
  const value = registry();
  assert.deepEqual(await value.getUrl(REFERENCE, 13370), {
    mutability: 'version',
    url: `ipfs://${CID}`,
  });
  assert.deepEqual(await value.getUrl('reya-core:9.9.9@router', 13370), {
    mutability: '',
    url: null,
  });
});

test('local QA registry permits only ephemeral or verified-cache CID writes', async () => {
  const value = registry();
  await value.publish(
    ['reya-core:1.0.26@with-omnibus'],
    1729,
    `ipfs://${CID}`
  );
  await value.publish(['reya-core:latest'], 1729, `ipfs://${CID}`);
  assert.deepEqual(
    await value.getUrl('reya-core:1.0.26@with-omnibus', 1729),
    {
      mutability: 'version',
      url: `ipfs://${CID}`,
    }
  );
  assert.equal(
    (await value.getUrl('reya-core:latest@main', 1729)).url,
    `ipfs://${CID}`
  );
  await assert.rejects(
    value.publish(['reya-core:1.0.26@other'], 1729, `ipfs://${OTHER}`),
    /outside the ephemeral contract/
  );
  await assert.rejects(
    value.publish(['reya-core:1.0.26@other'], 1729, 'https://example.invalid'),
    /outside the ephemeral contract/
  );
  await assert.rejects(
    value.publish(['reya-core:1.0.26@other'], 1729, 'mem://1/0'),
    /outside the ephemeral contract/
  );
});

test('local QA registry rolls back a batch containing an invalid reference', async () => {
  const value = registry();
  await assert.rejects(
    value.publish(
      ['reya-core:1.0.26@atomic', 'reya core:1.0.26'],
      1729,
      `ipfs://${CID}`
    ),
    /lookup is invalid/
  );
  assert.deepEqual(
    await value.getUrl('reya-core:1.0.26@atomic', 1729),
    {
      mutability: '',
      url: null,
    }
  );
});

test('local QA registry rejects duplicate canonical references atomically', async () => {
  const value = registry();
  await assert.rejects(
    value.publish(
      ['reya-core:latest', 'reya-core:latest@main'],
      1729,
      `ipfs://${CID}`
    ),
    /duplicate references/
  );
  assert.deepEqual(
    await value.getUrl('reya-core:latest@main', 1729),
    {
      mutability: '',
      url: null,
    }
  );
});
