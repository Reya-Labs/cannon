import { spawnPnpm, terminateProcessTrees } from './watch-process.mjs';

const commands = [
  {
    label: 'TypeScript',
    args: [
      'exec',
      'tsc',
      '-p',
      'tsconfig.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  },
  {
    label: 'Rollup',
    args: ['exec', 'rollup', '-c', '--watch', '--watch.clearScreen=false'],
  },
];

const children = commands.map(({ label, args }) => ({
  label,
  process: spawnPnpm(args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  }),
}));

let stopping = false;

function stop(exitCode, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;

  for (const failure of terminateProcessTrees(children, signal)) {
    console.error(`${failure.label} watcher failed to stop:`, failure.error);
  }
}

for (const child of children) {
  child.process.once('error', (error) => {
    console.error(`${child.label} watcher failed to start:`, error);
    stop(1);
  });
  child.process.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `${child.label} watcher exited unexpectedly (${
          signal ?? code ?? 'unknown'
        })`
      );
      stop(code && code > 0 ? code : 1);
    }
  });
}

process.once('SIGINT', () => stop(130, 'SIGINT'));
process.once('SIGTERM', () => stop(143, 'SIGTERM'));
