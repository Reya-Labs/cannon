import { spawn, spawnSync } from 'node:child_process';

/**
 * Resolve pnpm's JavaScript lifecycle entry point so Windows never executes a
 * `.cmd` shim through `spawn()` and no shell is introduced.
 */
export function getPnpmInvocation(
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath
) {
  if (!npmExecPath) {
    throw new Error('watchers must be started through a pnpm lifecycle script');
  }
  return { command: nodeExecutable, argsPrefix: [npmExecPath] };
}

export function spawnPnpm(args, options) {
  const { command, argsPrefix } = getPnpmInvocation();
  return spawn(command, [...argsPrefix, ...args], {
    ...options,
    detached: process.platform !== 'win32',
  });
}

/**
 * Terminate the complete watcher subprocess tree on every supported platform.
 */
export function terminateProcessTree(
  child,
  signal,
  {
    platform = process.platform,
    kill = process.kill,
    spawnSyncCommand = spawnSync,
  } = {}
) {
  if (child.pid === undefined || child.exitCode !== null) return;

  if (platform === 'win32') {
    const result = spawnSyncCommand(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      {
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    if (result.error) {
      throw new Error(`failed to start taskkill for watcher PID ${child.pid}`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new Error(
        [
          `taskkill for watcher PID ${child.pid} exited ${result.status}`,
          result.stderr?.trim(),
        ]
          .filter(Boolean)
          .join(': ')
      );
    }
    return;
  }

  try {
    kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/**
 * Attempt every watcher teardown and return failures after all trees were tried.
 */
export function terminateProcessTrees(
  children,
  signal,
  terminate = terminateProcessTree
) {
  const failures = [];
  for (const child of children) {
    try {
      terminate(child.process, signal);
    } catch (error) {
      failures.push({ label: child.label, error });
    }
  }
  return failures;
}
