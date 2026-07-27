import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPnpmInvocation,
  terminateProcessTree,
  terminateProcessTrees,
} from './watch-process.mjs';

test('pnpm lifecycle entry runs through Node instead of a Windows command shim', () => {
  assert.deepEqual(getPnpmInvocation('C:\\pnpm\\pnpm.cjs', 'C:\\node.exe'), {
    command: 'C:\\node.exe',
    argsPrefix: ['C:\\pnpm\\pnpm.cjs'],
  });
});

test('pnpm invocation rejects unsupported direct watcher startup', () => {
  assert.throws(
    () => getPnpmInvocation('', '/usr/bin/node'),
    /started through a pnpm lifecycle script/u
  );
});

test('Windows shutdown terminates the complete watcher process tree', () => {
  const calls = [];
  terminateProcessTree({ pid: 42, exitCode: null }, 'SIGTERM', {
    platform: 'win32',
    spawnSyncCommand: (...args) => {
      calls.push(args);
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    [
      'taskkill.exe',
      ['/pid', '42', '/t', '/f'],
      { encoding: 'utf8', windowsHide: true },
    ],
  ]);
});

test('Windows shutdown reports a taskkill launch error', () => {
  const failure = new Error('taskkill unavailable');
  assert.throws(
    () =>
      terminateProcessTree({ pid: 42, exitCode: null }, 'SIGTERM', {
        platform: 'win32',
        spawnSyncCommand: () => ({ error: failure }),
      }),
    (error) =>
      error.message === 'failed to start taskkill for watcher PID 42' &&
      error.cause === failure
  );
});

test('Windows shutdown reports a nonzero taskkill status', () => {
  assert.throws(
    () =>
      terminateProcessTree({ pid: 42, exitCode: null }, 'SIGTERM', {
        platform: 'win32',
        spawnSyncCommand: () => ({
          status: 1,
          stderr: 'process tree was not terminated',
        }),
      }),
    /taskkill for watcher PID 42 exited 1: process tree was not terminated/u
  );
});

test('POSIX shutdown signals the complete detached process group', () => {
  const calls = [];
  terminateProcessTree({ pid: 42, exitCode: null }, 'SIGINT', {
    platform: 'linux',
    kill: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[-42, 'SIGINT']]);
});

test('shutdown skips a child that has already exited', () => {
  let called = false;
  terminateProcessTree({ pid: 42, exitCode: 0 }, 'SIGTERM', {
    platform: 'linux',
    kill: () => {
      called = true;
    },
  });
  assert.equal(called, false);
});

test('all watcher trees are attempted when one teardown fails', () => {
  const calls = [];
  const failure = new Error('first tree failed');
  const failures = terminateProcessTrees(
    [
      { label: 'first', process: { pid: 41 } },
      { label: 'second', process: { pid: 42 } },
    ],
    'SIGTERM',
    (child) => {
      calls.push(child.pid);
      if (child.pid === 41) throw failure;
    }
  );

  assert.deepEqual(calls, [41, 42]);
  assert.deepEqual(failures, [{ label: 'first', error: failure }]);
});
