import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadInteractiveLocalPreviewConfig,
  parseInteractivePreviewRequest,
} from '../src/interactive-local-preview.mjs';
import {
  LOCAL_QA_BASELINE,
  LOCAL_QA_PARTIAL_DEPLOYMENTS,
  LOCAL_QA_SAFE_ADDRESS,
  LOCAL_QA_SOURCE,
} from '../test-support/local-qa-resolution.mjs';

function request(overrides = {}) {
  return {
    chainId: 1729,
    commit: LOCAL_QA_SOURCE.commit,
    partialDeployCid: null,
    previousPackageCid: LOCAL_QA_BASELINE.deployCid,
    safeAddress: LOCAL_QA_SAFE_ADDRESS,
    ...overrides,
  };
}

test('accepts only one canonical preview request bound to the QA fixture', () => {
  const value = request();
  assert.deepEqual(
    parseInteractivePreviewRequest(JSON.stringify(value), {
      defaultCommit: LOCAL_QA_SOURCE.commit,
      partialDeployments: LOCAL_QA_PARTIAL_DEPLOYMENTS,
      previousPackageCid: LOCAL_QA_BASELINE.deployCid,
      safeAddress: LOCAL_QA_SAFE_ADDRESS,
    }),
    value
  );

  for (const encoded of [
    JSON.stringify(request({ chainId: 1 })),
    JSON.stringify(
      request({
        previousPackageCid: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
      })
    ),
    JSON.stringify(
      request({ safeAddress: '0x1111111111111111111111111111111111111111' })
    ),
    `${JSON.stringify(request())}\n`,
    `{"chainId":1729,"chainId":1729,"commit":"${LOCAL_QA_SOURCE.commit}","partialDeployCid":null,"previousPackageCid":"${LOCAL_QA_BASELINE.deployCid}","safeAddress":"${LOCAL_QA_SAFE_ADDRESS}"}`,
  ]) {
    assert.throws(
      () =>
        parseInteractivePreviewRequest(encoded, {
          defaultCommit: LOCAL_QA_SOURCE.commit,
          partialDeployments: LOCAL_QA_PARTIAL_DEPLOYMENTS,
          previousPackageCid: LOCAL_QA_BASELINE.deployCid,
          safeAddress: LOCAL_QA_SAFE_ADDRESS,
        }),
      /request is invalid/
    );
  }
});

test('accepts only the pinned partial deployment and its authenticated source commit', () => {
  const partial = LOCAL_QA_PARTIAL_DEPLOYMENTS[0];
  const value = request({
    commit: partial.source.commit,
    partialDeployCid: partial.deployCid,
  });
  const expected = {
    defaultCommit: LOCAL_QA_SOURCE.commit,
    partialDeployments: LOCAL_QA_PARTIAL_DEPLOYMENTS,
    previousPackageCid: LOCAL_QA_BASELINE.deployCid,
    safeAddress: LOCAL_QA_SAFE_ADDRESS,
  };
  assert.deepEqual(
    parseInteractivePreviewRequest(JSON.stringify(value), expected),
    value
  );
  for (const candidate of [
    request({ partialDeployCid: partial.deployCid }),
    request({
      commit: partial.source.commit,
      partialDeployCid: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
    }),
  ]) {
    assert.throws(
      () => parseInteractivePreviewRequest(JSON.stringify(candidate), expected),
      /request is invalid/
    );
  }
});

test('requires absolute server-side source and artifact paths', () => {
  assert.deepEqual(
    loadInteractiveLocalPreviewConfig({
      REYA_LOCAL_ARTIFACT_CACHE: '/tmp/reya-artifacts',
      REYA_LOCAL_SOURCE_REPOSITORY: '/tmp/reya-deployments',
    }),
    {
      artifactCache: '/tmp/reya-artifacts',
      sourceRepository: '/tmp/reya-deployments',
    }
  );
  assert.throws(
    () =>
      loadInteractiveLocalPreviewConfig({
        REYA_LOCAL_ARTIFACT_CACHE: './artifacts',
        REYA_LOCAL_SOURCE_REPOSITORY: '/tmp/reya-deployments',
      }),
    /must be an absolute path/
  );
});
