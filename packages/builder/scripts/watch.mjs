import { spawn } from 'node:child_process';

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const commands = [
  {
    label: 'Artifact codec',
    args: ['--filter', '@usecannon/artifact-codec', 'run', 'watch'],
  },
  {
    label: 'Builder TypeScript',
    args: [
      'exec',
      'tsc',
      '-p',
      'tsconfig.build.json',
      '--watch',
      '--preserveWatchOutput',
    ],
  },
];

const children = commands.map(({ label, args }) => ({
  label,
  process: spawn(pnpm, args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
  }),
}));

let stopping = false;

function stop(exitCode, signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;

  for (const child of children) {
    child.process.kill(signal);
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
