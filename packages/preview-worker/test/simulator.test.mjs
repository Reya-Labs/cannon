import assert from 'node:assert/strict';
import test from 'node:test';
import { SIMULATOR_MODES } from '../src/config.mjs';
import { createSimulator } from '../src/simulator.mjs';
import {
  ENGINE_MEMBER_NAMES,
  loadPreviewEngine,
  validatePreviewEngine,
} from '../src/simulator/engine.mjs';
import { createForkSimulator } from '../src/simulator/fork-simulator.mjs';
import {
  ARTIFACT_ORIGIN,
  COMMIT,
  deploymentArtifact,
  jsonResponse,
  MAINNET_RPC_URL,
  OP_RPC_URL,
  OTHER_CID,
  PARTIAL_CID,
  PREVIOUS_CID,
  recordingFetch,
  RPC_URL,
  SAFE_ADDRESS,
  SOURCE_ORIGIN,
  sourceBundle,
  stubEngine,
  stubFork,
  textResponse,
} from './simulator-support.mjs';

function artifactBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Wires a fork simulator whose every boundary is a stub, so a test can break
 * exactly one of them and see what the composition does about it.
 */
function build({
  artifacts = {
    [PARTIAL_CID]: deploymentArtifact({
      def: { name: 'reya-omnibus', preset: 'main', version: '1.0.159' },
      status: 'partial',
    }),
    [PREVIOUS_CID]: deploymentArtifact(),
  },
  bundle = sourceBundle(),
  engine = {},
  fork = stubFork(),
  startFork,
} = {}) {
  const fetchImpl = recordingFetch((url) => {
    if (url.startsWith(`${SOURCE_ORIGIN}/source/`)) return jsonResponse(bundle);
    if (url.startsWith(`${ARTIFACT_ORIGIN}/artifacts/`)) {
      const cid = new URL(url).searchParams.get('arg');
      const artifact = artifacts[cid];
      if (artifact === undefined) return undefined;
      return textResponse(artifactBytes(artifact), 'application/octet-stream');
    }
    return undefined;
  });
  const capability = stubEngine({
    getContentCid: async (bytes) => {
      const decoded = JSON.parse(new TextDecoder().decode(bytes));
      return decoded.status === 'partial' ? PARTIAL_CID : PREVIOUS_CID;
    },
    ...engine,
  });
  return {
    fetchImpl,
    fork,
    simulator: createForkSimulator({
      artifactOrigin: ARTIFACT_ORIGIN,
      engine: capability,
      fetchImpl,
      mainnetRpcUrl: MAINNET_RPC_URL,
      opRpcUrl: OP_RPC_URL,
      rpcUrl: RPC_URL,
      sourceOrigin: SOURCE_ORIGIN,
      startFork: startFork ?? (async () => fork),
    }),
  };
}

function request(overrides = {}) {
  return {
    commit: COMMIT,
    deploymentMode: 'cannonfile',
    partialDeployCid: null,
    previousPackageCid: PREVIOUS_CID,
    safeAddress: SAFE_ADDRESS,
    signal: undefined,
    ...overrides,
  };
}

async function code(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

test('the disabled mode remains the default and still fails closed', async () => {
  assert.deepEqual([...SIMULATOR_MODES], ['disabled', 'fork']);
  const simulator = createSimulator({ mode: 'disabled' });

  assert.equal(await code(simulator.simulate()), 'PREVIEW_FAILED');
});

test('an unknown simulator mode is refused at construction', () => {
  assert.throws(
    () => createSimulator({ mode: 'anything' }),
    /PREVIEW_SIMULATOR_MODE must be one of: disabled, fork/,
  );
});

test('returns the ordered Safe calls and provenance evidence', async () => {
  const { fork, simulator } = build();
  const result = await simulator.simulate(request());

  assert.equal(result.safeAddress, SAFE_ADDRESS);
  assert.equal(result.safeProposalCalls.length, 1);
  assert.deepEqual(result.deployerPrerequisites, []);
  assert.equal(result.evidence.source.commit, COMMIT);
  assert.equal(result.evidence.source.bundleSha256.length, 64);
  assert.equal(result.evidence.previousPackageRef, 'reya-omnibus:1.0.158@main');
  assert.equal(result.evidence.forkBlock.blockNumber, '19000000');
  assert.equal(result.evidence.mode, 'fork-pinned-head');
  assert.equal(fork.stopped.count, 1, 'the fork must always be disposed');
});

test('never receives or reports a nonce, transaction or digest', async () => {
  const { simulator } = build();
  const result = await simulator.simulate(request());
  const serialized = JSON.stringify(result);

  for (const forbidden of ['nonce', 'safeTxHash', 'txn', 'operation']) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `the simulator must not produce ${forbidden}`,
    );
  }
});

test('the evidence never carries an upstream URL or credential', async () => {
  const { simulator } = build();
  const result = await simulator.simulate(request());
  const serialized = JSON.stringify(result);

  for (const secret of [RPC_URL, OP_RPC_URL, MAINNET_RPC_URL, 'token']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('drives the build from the pinned partial deployment when one is named', async () => {
  const captured = [];
  const { simulator } = build({
    engine: {
      runReadOnlyPreview: async (options) => {
        captured.push(options);
        return stubEngine().runReadOnlyPreview(options);
      },
    },
  });
  await simulator.simulate(
    request({ deploymentMode: 'partial', partialDeployCid: PARTIAL_CID }),
  );

  assert.equal(captured[0].deploymentMode, 'partial');
  assert.equal(captured[0].startingDeployment.status, 'partial');
  assert.equal(captured[0].previousPackageCid, PREVIOUS_CID);
  assert.equal(
    captured[0].sourceGitUrl,
    'https://github.com/Reya-Labs/reya-deployments',
  );
});

test('fails closed when the source bundle does not hash to what it claims', async () => {
  const bundle = sourceBundle();
  const { simulator } = build({
    bundle: { ...bundle, bundleSha256: 'f'.repeat(64) },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('fails closed when an artifact does not hash to its CID', async () => {
  const { simulator } = build({
    engine: { getContentCid: async () => OTHER_CID },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('fails closed when the previous package artifact is not the omnibus', async () => {
  const { simulator } = build({
    artifacts: {
      [PREVIOUS_CID]: deploymentArtifact({
        def: { name: 'some-other-package', preset: 'main', version: '1.0.0' },
      }),
    },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('fails closed when the previous package is itself only partial', async () => {
  const { simulator } = build({
    artifacts: { [PREVIOUS_CID]: deploymentArtifact({ status: 'partial' }) },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('fails closed when the fork cannot be started', async () => {
  const { simulator } = build({
    startFork: async () => {
      throw new Error('anvil is not installed');
    },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('propagates a pinned-state failure raised while starting the fork', async () => {
  const { PreviewError } = await import('../src/errors.mjs');
  const { simulator } = build({
    startFork: async () => {
      throw new PreviewError(503, 'RPC_PINNED_STATE_UNAVAILABLE');
    },
  });

  assert.equal(
    await code(simulator.simulate(request())),
    'RPC_PINNED_STATE_UNAVAILABLE',
  );
});

test('discards an otherwise successful build that read pruned state', async () => {
  const fork = stubFork({ prunedState: true });
  const { simulator } = build({ fork });

  assert.equal(
    await code(simulator.simulate(request())),
    'RPC_PINNED_STATE_UNAVAILABLE',
  );
  assert.equal(fork.stopped.count, 1);
});

test('never lets a build failure hide a pinned-state failure', async () => {
  const fork = stubFork({ prunedState: true });
  const { simulator } = build({
    fork,
    engine: {
      runReadOnlyPreview: async () => {
        throw new Error('preview build failed at invoke.something');
      },
    },
  });

  assert.equal(
    await code(simulator.simulate(request())),
    'RPC_PINNED_STATE_UNAVAILABLE',
  );
});

test('an expired run deadline stops the work before it starts', async () => {
  const fork = stubFork();
  let startedFork = false;
  const { fetchImpl, simulator } = build({
    fork,
    startFork: async () => {
      startedFork = true;
      return fork;
    },
  });
  const controller = new AbortController();
  controller.abort(new Error('deadline exceeded'));

  assert.equal(
    await code(simulator.simulate(request({ signal: controller.signal }))),
    'UPSTREAM_UNAVAILABLE',
  );
  assert.equal(fetchImpl.calls.length, 1, 'only the first read is attempted');
  assert.equal(startedFork, false, 'no Anvil process is started');
});

test('an expired deadline after the reads still stops before the fork', async () => {
  const fork = stubFork();
  const controller = new AbortController();
  let startedFork = false;
  const { simulator } = build({
    engine: {
      getContentCid: async (bytes) => {
        // The deadline expires while the artifacts are still being read.
        controller.abort(new Error('deadline exceeded'));
        const decoded = JSON.parse(new TextDecoder().decode(bytes));
        return decoded.status === 'partial' ? PARTIAL_CID : PREVIOUS_CID;
      },
    },
    fork,
    startFork: async () => {
      startedFork = true;
      return fork;
    },
  });

  assert.equal(
    await code(simulator.simulate(request({ signal: controller.signal }))),
    'PREVIEW_FAILED',
  );
  assert.equal(startedFork, false, 'no Anvil process is started');
});

test('rejects a build result bound to a different Safe', async () => {
  const { simulator } = build({
    engine: {
      runReadOnlyPreview: async (options) => ({
        ...(await stubEngine().runReadOnlyPreview(options)),
        safeAddress: '0x2222222222222222222222222222222222222222',
      }),
    },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('rejects a build result bound to a different commit', async () => {
  const { simulator } = build({
    engine: {
      runReadOnlyPreview: async (options) => ({
        ...(await stubEngine().runReadOnlyPreview(options)),
        commit: 'b'.repeat(40),
      }),
    },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('rejects a build result with no Safe proposal calls', async () => {
  const { simulator } = build({
    engine: {
      runReadOnlyPreview: async (options) => ({
        ...(await stubEngine().runReadOnlyPreview(options)),
        safeProposalCalls: [],
      }),
    },
  });

  assert.equal(await code(simulator.simulate(request())), 'PREVIEW_FAILED');
});

test('refuses inputs the request layer could never have produced', async () => {
  const { simulator } = build();

  for (const overrides of [
    { commit: 'not-a-commit' },
    { deploymentMode: 'whatever' },
    { partialDeployCid: PREVIOUS_CID, deploymentMode: 'partial' },
    { partialDeployCid: PARTIAL_CID },
    { safeAddress: '0xnope' },
  ]) {
    assert.equal(
      await code(simulator.simulate(request(overrides))),
      'INVALID_REQUEST',
      JSON.stringify(overrides),
    );
  }
});

test('the engine contract is all-or-nothing', () => {
  const complete = Object.fromEntries(
    ENGINE_MEMBER_NAMES.map((name) => [name, () => undefined]),
  );
  assert.doesNotThrow(() => validatePreviewEngine(complete));

  for (const name of ENGINE_MEMBER_NAMES) {
    assert.throws(
      () => validatePreviewEngine({ ...complete, [name]: 'not a function' }),
      /preview engine contract is not satisfied/,
    );
  }
  assert.throws(
    () => validatePreviewEngine({ ...complete, extra: () => undefined }),
    /preview engine contract is not satisfied/,
  );
});

test('a fork worker refuses to start when the image has no engine', async () => {
  await assert.rejects(
    () =>
      loadPreviewEngine(async () => {
        throw new Error("Cannot find package '@usecannon/artifact-codec'");
      }),
    /preview engine is not installed in this image/,
  );
});

test('the engine is resolved only from fixed specifiers', async () => {
  const requested = [];
  await assert.rejects(
    () =>
      loadPreviewEngine(async (specifier) => {
        requested.push(specifier);
        return {};
      }),
    /preview engine contract is not satisfied/,
  );

  assert.deepEqual(requested, [
    '@reya/cannon-safe-ui/artifact-loader',
    '@reya/cannon-safe-ui/assemble-definition',
    '@reya/cannon-safe-ui/ephemeral-artifact-overlay',
    '@reya/cannon-safe-ui/preview-engine',
    '@usecannon/artifact-codec',
  ]);
});
