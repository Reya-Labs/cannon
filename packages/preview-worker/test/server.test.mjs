import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { PreviewError } from '../src/errors.mjs';
import { startServer } from '../src/server.mjs';
import { ENV } from './support.mjs';
import { MAINNET_RPC_URL, stubEngine } from './simulator-support.mjs';

const FORK_ENV = Object.freeze({
  ...ENV,
  PREVIEW_MAINNET_RPC_URL: MAINNET_RPC_URL,
  PREVIEW_SIMULATOR_MODE: 'fork',
  PORT: '18234',
});

function listening(port) {
  return new Promise((resolve) => {
    const socket = net
      .connect({ host: '127.0.0.1', port })
      .once('connect', () => {
        socket.destroy();
        resolve(true);
      })
      .once('error', () => resolve(false));
  });
}

/**
 * Runs one start-up that is expected to fail, releasing the socket if it does
 * not. Without that, a regression would leave a listening server behind and
 * hang the run instead of failing it.
 */
async function expectRefusedStartup(env, options) {
  let started = null;
  let caught = null;
  try {
    started = await startServer(env, options);
  } catch (error) {
    caught = error;
  }
  const listened = await listening(Number(env.PORT));
  if (started !== null) await started.stop();
  return { caught, listened };
}

test('a fork worker refuses to listen without the pinned Foundry runtime', async () => {
  const { caught, listened } = await expectRefusedStartup(FORK_ENV, {
    loadEngine: async () => stubEngine(),
    verifyRuntime: async () => {
      throw new PreviewError(502, 'PREVIEW_FAILED');
    },
  });

  assert.equal(caught?.code, 'PREVIEW_FAILED');
  // The point of checking at start-up rather than per preview: a worker that
  // cannot fork must not be able to pass its readiness probe.
  assert.equal(listened, false);
});

test('a fork worker refuses to listen without the Cannon engine', async () => {
  let verified = false;
  const { caught, listened } = await expectRefusedStartup(FORK_ENV, {
    loadEngine: async () => {
      throw new Error('preview engine is not installed in this image');
    },
    verifyRuntime: async () => {
      verified = true;
    },
  });

  assert.match(
    String(caught?.message),
    /preview engine is not installed in this image/,
  );
  assert.equal(verified, true, 'the runtime is checked first');
  assert.equal(listened, false);
});

test('a dormant worker checks neither and still serves', async () => {
  let checked = false;
  const started = await startServer(
    { ...ENV, PORT: '18235' },
    {
      loadEngine: async () => {
        checked = true;
        return stubEngine();
      },
      verifyRuntime: async () => {
        checked = true;
      },
    },
  );
  try {
    assert.equal(checked, false);
    assert.equal(started.config.simulatorMode, 'disabled');
    const response = await fetch('http://127.0.0.1:18235/readyz');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    await started.stop();
  }
});

test('a fork worker that has both prerequisites listens', async () => {
  const started = await startServer(
    { ...FORK_ENV, PORT: '18236' },
    {
      loadEngine: async () => stubEngine(),
      verifyRuntime: async () => undefined,
    },
  );
  try {
    assert.equal(started.config.simulatorMode, 'fork');
    const response = await fetch('http://127.0.0.1:18236/livez');
    assert.equal(response.status, 200);
  } finally {
    await started.stop();
  }
});
