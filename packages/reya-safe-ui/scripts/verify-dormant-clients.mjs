import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { compareCanonicalText } from '../src/config.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const SOURCE_ROOT = path.join(PACKAGE_ROOT, 'src');
const ACTIVE_ENTRY = path.join(SOURCE_ROOT, 'build.mjs');
const DORMANT_ROOT = path.join(SOURCE_ROOT, 'clients');
const ALLOWED_NODE_IMPORTS = new Set([
  'node:crypto',
  'node:fs/promises',
  'node:path',
  'node:url',
]);

const FORBIDDEN_SOURCE = Object.freeze([
  ['hard-coded remote URL', /\bhttps?:\/\/[^\s'"`]+/i],
  [
    'hosted Cannon domain',
    /\b(?:repo\.|safe-staging\.|git-proxy\.repo\.)?usecannon\.com\b/i,
  ],
  [
    'public IPFS domain',
    /\b(?:ipfs\.io|dweb\.link|cloudflare-ipfs\.com|gateway\.pinata\.cloud)\b/i,
  ],
  ['public RPC domain', /\b(?:infura\.io|alchemy\.com|ankr\.com)\b/i],
  [
    'public Git host',
    /\b(?:github\.com|raw\.githubusercontent\.com|gitlab\.com|bitbucket\.org)\b/i,
  ],
  ['browser-persisted configuration', /\blocalStorage\b/],
  ['artifact upload route', /\/api\/v0\/add\b/],
  ['browser bearer credential', /\b(?:authorization|bearer)\b/i],
]);

async function collectModules(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name)
  )) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectModules(root, target)));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(path.resolve(target));
    } else if (entry.isFile()) {
      throw new Error(
        `${relativeModule(root, target)} is an unsupported UI source file`
      );
    } else if (entry.isSymbolicLink()) {
      throw new Error('Reya Safe UI source must not contain symbolic links');
    }
  }
  return files;
}

function relativeModule(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function importedSpecifiers(source) {
  const [imports] = parse(source);
  const specifiers = [];
  for (const imported of imports) {
    if (imported.d === -2) continue;
    if (typeof imported.n !== 'string') {
      throw new Error('active Reya Safe UI graph has a non-literal import');
    }
    specifiers.push(imported.n);
  }
  return specifiers;
}

async function activeImportGraph({ activeEntry, sourceRoot }) {
  await init;
  const root = path.resolve(sourceRoot);
  const pending = [path.resolve(activeEntry)];
  const reachable = new Set();

  while (pending.length > 0) {
    const current = pending.pop();
    if (reachable.has(current)) continue;
    const metadata = await lstat(current);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('active Reya Safe UI module must be a regular file');
    }
    reachable.add(current);

    const source = await readFile(current, 'utf8');
    if (
      /\b(?:createRequire|require\s*\(|eval\s*\(|new\s+Function\b)/.test(source)
    ) {
      throw new Error('active Reya Safe UI graph has a dynamic code loader');
    }

    for (const specifier of importedSpecifiers(source)) {
      if (specifier.startsWith('node:')) {
        if (!ALLOWED_NODE_IMPORTS.has(specifier)) {
          throw new Error(
            'active Reya Safe UI graph has an unsupported Node import'
          );
        }
        continue;
      }
      if (!specifier.startsWith('.')) {
        throw new Error(
          'active Reya Safe UI graph has an unsupported non-relative import'
        );
      }
      const resolved = path.resolve(path.dirname(current), specifier);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error('active Reya Safe UI import escapes the source root');
      }
      pending.push(resolved);
    }
  }
  return reachable;
}

export async function scanForbiddenSourceDomains({
  sourceRoot = SOURCE_ROOT,
} = {}) {
  const root = path.resolve(sourceRoot);
  const modules = await collectModules(root);
  for (const file of modules) {
    const source = await readFile(file, 'utf8');
    for (const [label, pattern] of FORBIDDEN_SOURCE) {
      if (pattern.test(source)) {
        throw new Error(
          `${relativeModule(root, file)} contains forbidden ${label}`
        );
      }
    }
  }
  return Object.freeze(modules.map((file) => relativeModule(root, file)));
}

export async function verifyDormantClients({
  activeEntry = ACTIVE_ENTRY,
  dormantRoot = DORMANT_ROOT,
  sourceRoot = SOURCE_ROOT,
} = {}) {
  const root = path.resolve(sourceRoot);
  const dormant = await collectModules(path.resolve(dormantRoot));
  if (dormant.length === 0) {
    throw new Error('dormant Reya client source is missing');
  }

  const reachable = await activeImportGraph({ activeEntry, sourceRoot: root });
  const leaked = dormant.filter((file) => reachable.has(file));
  if (leaked.length > 0) {
    throw new Error(
      `disabled shell imports dormant client source: ${leaked
        .map((file) => relativeModule(root, file))
        .join(', ')}`
    );
  }

  const scanned = await scanForbiddenSourceDomains({ sourceRoot: root });
  return Object.freeze({
    active: Object.freeze(
      [...reachable]
        .map((file) => relativeModule(root, file))
        .sort(compareCanonicalText)
    ),
    dormant: Object.freeze(
      dormant
        .map((file) => relativeModule(root, file))
        .sort(compareCanonicalText)
    ),
    scanned,
  });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await verifyDormantClients();
    process.stdout.write(
      `Verified ${result.dormant.length} dormant Reya client modules across ${result.scanned.length} source files\n`
    );
  } catch (error) {
    process.stderr.write(
      `Dormant Reya read client verification failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
