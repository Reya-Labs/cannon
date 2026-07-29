import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isReyaOmnibusPackageRef,
  OP_REGISTRY_RESOLVE_PATH,
  ReyaReadClientError,
} from '../src/clients/index.mjs';
import {
  clientWith,
  DEPLOY_CID,
  jsonResponse,
  SERVICE_ORIGIN,
} from '../test-support/client-fixtures.mjs';

const PACKAGE_REF = 'reya-omnibus:latest@main';
const REGISTRY = '0x8e5c7efc9636a6a0408a46bb7f617094b81e5dba';

function response(overrides = {}) {
  return {
    chainId: 1729,
    cid: DEPLOY_CID,
    deployUrl: `ipfs://${DEPLOY_CID}`,
    found: true,
    mutability: 'tag',
    packageRef: PACKAGE_REF,
    registryAddress: REGISTRY,
    registryChainId: 10,
    schemaVersion: 1,
    ...overrides,
  };
}

function clientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

test('resolves one Reya omnibus alias through the fixed OP bridge', async () => {
  const requests = [];
  const client = clientWith(async (url, options) => {
    requests.push({ options, url });
    return jsonResponse(response());
  });

  const resolved = await client.registry.resolve({
    chainId: 1729,
    packageRef: PACKAGE_REF,
  });

  assert.deepEqual(resolved, {
    chainId: 1729,
    cid: DEPLOY_CID,
    deployUrl: `ipfs://${DEPLOY_CID}`,
    mutability: 'tag',
    packageRef: PACKAGE_REF,
    registryAddress: REGISTRY,
    registryChainId: 10,
  });
  assert.ok(Object.isFrozen(resolved));
  assert.equal(requests[0].url, `${SERVICE_ORIGIN}${OP_REGISTRY_RESOLVE_PATH}`);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    chainId: 1729,
    packageRef: PACKAGE_REF,
  });
  assert.equal('Authorization' in requests[0].options.headers, false);
});

test('accepts only the bounded Reya omnibus package-ref namespace', () => {
  assert.equal(isReyaOmnibusPackageRef(PACKAGE_REF), true);
  assert.equal(isReyaOmnibusPackageRef('reya-omnibus:1.2.3@main'), true);
  assert.equal(isReyaOmnibusPackageRef('reya-omnibus:1.2.3-rc.1@main'), true);
  for (const value of [
    'reya-core:latest@main',
    'reya-omnibus:latest@router',
    'reya-omnibus:*@main',
    'reya-omnibus:latest@main/other',
    `reya-omnibus:1.2.3-${'a'.repeat(27)}@main`,
    'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
  ]) {
    assert.equal(isReyaOmnibusPackageRef(value), false);
  }
});

test('rejects invalid registry requests before fetch', async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    throw new Error('must not fetch');
  });

  for (const input of [
    null,
    { chainId: 10, packageRef: PACKAGE_REF },
    { chainId: 1729, packageRef: 'other:latest@main' },
    {
      chainId: 1729,
      packageRef: `reya-omnibus:1.2.3-${'a'.repeat(27)}@main`,
    },
    { chainId: 1729, packageRef: PACKAGE_REF, rpcUrl: 'https://rpc.invalid' },
  ]) {
    await assert.rejects(
      () => client.registry.resolve(input),
      clientError('INVALID_INPUT')
    );
  }
  assert.equal(calls, 0);
});

test('distinguishes an unknown alias from a malformed response', async () => {
  const responses = [
    response({
      cid: null,
      deployUrl: null,
      found: false,
      mutability: null,
    }),
    response({ registryChainId: 1 }),
    response({ deployUrl: `ipfs://${DEPLOY_CID}other` }),
    response({ packageRef: 'reya-omnibus:1.2.3@main' }),
  ];
  const client = clientWith(async () => jsonResponse(responses.shift()));

  await assert.rejects(
    () =>
      client.registry.resolve({
        chainId: 1729,
        packageRef: PACKAGE_REF,
      }),
    clientError('OP_ALIAS_UNKNOWN')
  );
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      () =>
        client.registry.resolve({
          chainId: 1729,
          packageRef: PACKAGE_REF,
        }),
      clientError('RESPONSE_REJECTED')
    );
  }
});

test('rejects duplicate and non-canonical registry responses', async () => {
  const bodies = [
    `{"chainId":1729,"cid":"${DEPLOY_CID}","cid":"${DEPLOY_CID}","deployUrl":"ipfs://${DEPLOY_CID}","found":true,"mutability":"tag","packageRef":"${PACKAGE_REF}","registryAddress":"${REGISTRY}","registryChainId":10,"schemaVersion":1}`,
    JSON.stringify(response(), null, 2),
  ];
  const client = clientWith(
    async () =>
      new Response(bodies.shift(), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
  );
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(
      () =>
        client.registry.resolve({
          chainId: 1729,
          packageRef: PACKAGE_REF,
        }),
      clientError('RESPONSE_REJECTED')
    );
  }
});
