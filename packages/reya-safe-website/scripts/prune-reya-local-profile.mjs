import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const output = path.join(packageRoot, 'out');
const keep = new Set(['404.html', '_next', 'index.html']);

for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!keep.has(entry.name)) {
    await rm(path.join(output, entry.name), {
      force: true,
      recursive: true,
    });
  }
}
