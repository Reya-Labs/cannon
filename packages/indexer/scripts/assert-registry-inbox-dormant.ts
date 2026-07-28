import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const distDirectory = resolve(__dirname, '..', 'dist');
const runtimeEntry = join(distDirectory, 'index.js');
const forbiddenModules = [
  realpathSync(join(distDirectory, 'registry-inbox.js')),
  realpathSync(join(distDirectory, 'registry-scan-batch.js')),
];

function resolveLocalModule(importer: string, specifier: string): string {
  const unresolved = resolve(dirname(importer), specifier);
  const candidates = [unresolved, `${unresolved}.js`, join(unresolved, 'index.js')];
  const resolved = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  assert.ok(resolved, `cannot resolve emitted local dependency ${specifier} from ${importer}`);
  return realpathSync(resolved);
}

assert.ok(existsSync(runtimeEntry), 'indexer build output is required for the dormancy assertion');

const pending = [realpathSync(runtimeEntry)];
const reachable = new Set<string>();
while (pending.length > 0) {
  const modulePath = pending.pop()!;
  if (reachable.has(modulePath)) continue;
  reachable.add(modulePath);

  const source = readFileSync(modulePath, 'utf8');
  assert.doesNotMatch(
    source,
    /registry-(?:inbox|scan-batch)/,
    `live emitted module ${modulePath} references the dormant registry inbox`
  );

  for (const match of source.matchAll(/\brequire\((['"])(\.[^'"]+)\1\)/g)) {
    pending.push(resolveLocalModule(modulePath, match[2]));
  }
}

for (const forbiddenModule of forbiddenModules) {
  assert.ok(existsSync(forbiddenModule), `expected dormant emitted module ${forbiddenModule}`);
  assert.ok(!reachable.has(forbiddenModule), `${forbiddenModule} is reachable from the live indexer entrypoint`);
}
