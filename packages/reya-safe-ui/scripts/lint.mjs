import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCanonicalText } from '../src/config.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const SOURCE_DIRECTORIES = ['scripts', 'src', 'test'];

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name)
  )) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesIn(target)));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(target);
    }
  }

  return files;
}

const sourceFiles = (
  await Promise.all(
    SOURCE_DIRECTORIES.map((directory) =>
      filesIn(path.join(PACKAGE_ROOT, directory))
    )
  )
).flat();

for (const file of sourceFiles) {
  const relativePath = path.relative(PACKAGE_ROOT, file);
  const source = await readFile(file, 'utf8');

  if (!source.endsWith('\n'))
    throw new Error(`${relativePath} must end with a newline`);
  if (source.includes('\r'))
    throw new Error(`${relativePath} must use LF line endings`);
  if (source.includes('\t'))
    throw new Error(`${relativePath} must not contain tab characters`);
  if (/ +$/m.test(source))
    throw new Error(`${relativePath} contains trailing whitespace`);

  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}

process.stdout.write(
  `Checked ${sourceFiles.length} Reya Safe UI source files\n`
);
