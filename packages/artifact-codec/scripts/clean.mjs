import { rmSync } from 'node:fs';

const packageRoot = new URL('..', import.meta.url);
const allowedTargets = new Map([
  ['dist', new URL('dist', packageRoot)],
  ['.build', new URL('.build', packageRoot)],
]);
const requestedTargets = process.argv.slice(2);

if (requestedTargets.length === 0) {
  throw new Error('clean requires at least one explicit package-local target');
}

for (const target of requestedTargets) {
  const targetUrl = allowedTargets.get(target);
  if (!targetUrl) {
    throw new Error(`refusing to clean unsupported target ${target}`);
  }
  rmSync(targetUrl, { recursive: true, force: true });
}
