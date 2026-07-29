import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import toml from '@iarna/toml';

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_ROOT = 'packages/tomls/src/omnibus/reya_network.toml';
const SOURCE_PREFIX = 'packages/tomls/src/';
const MAX_FILES = 512;
const MAX_DEPTH = 16;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourcePath(value) {
  if (
    typeof value !== 'string' ||
    !value.startsWith(SOURCE_PREFIX) ||
    !value.endsWith('.toml') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error('local source path is invalid');
  }
  const components = value.split('/');
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === '.' ||
        component === '..'
    )
  ) {
    throw new Error('local source path is invalid');
  }
  return value;
}

function resolveInclude(current, include) {
  if (
    typeof include !== 'string' ||
    include.length < 1 ||
    include.includes('\\') ||
    include.includes('\0') ||
    include.startsWith('/')
  ) {
    throw new Error('local source include is invalid');
  }
  const parts = current.split('/');
  parts.pop();
  for (const component of include.split('/')) {
    if (component.length === 0 || component === '.') continue;
    if (component === '..') {
      if (parts.length <= 3) {
        throw new Error('local source include escapes the source root');
      }
      parts.pop();
    } else {
      parts.push(component);
    }
  }
  return sourcePath(parts.join('/'));
}

async function git(repositoryPath, args, maximumBytes = 4 * 1024 * 1024) {
  let result;
  try {
    result = await execFileAsync('git', ['-C', repositoryPath, ...args], {
      encoding: 'utf8',
      maxBuffer: maximumBytes,
      timeout: 30_000,
      windowsHide: true,
    });
  } catch {
    throw new Error('local source Git read failed');
  }
  return result.stdout;
}

/**
 * Loads the exact include closure from a local reya-deployments Git object.
 * Worktree contents, branches, remotes, and credentials are never consulted.
 */
export async function loadLocalSourceBundle({
  commit,
  expectedBundleSha256,
  repositoryPath,
}) {
  if (
    !COMMIT_PATTERN.test(commit) ||
    !DIGEST_PATTERN.test(expectedBundleSha256) ||
    typeof repositoryPath !== 'string' ||
    !path.isAbsolute(repositoryPath)
  ) {
    throw new Error('local source bundle options are invalid');
  }
  const canonicalRepository = await realpath(repositoryPath);
  const metadata = await lstat(canonicalRepository);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('local source repository is invalid');
  }
  const resolved = (
    await git(canonicalRepository, ['rev-parse', '--verify', `${commit}^{commit}`])
  ).trim();
  if (resolved !== commit) {
    throw new Error('local source commit is unavailable');
  }

  const files = new Map();
  const active = new Set();

  async function visit(sourceFile, depth) {
    if (active.has(sourceFile)) {
      throw new Error('local source include cycle detected');
    }
    if (files.has(sourceFile)) return;
    if (files.size >= MAX_FILES || depth > MAX_DEPTH) {
      throw new Error('local source include closure exceeds limits');
    }
    active.add(sourceFile);
    const content = await git(
      canonicalRepository,
      ['show', `${commit}:${sourceFile}`],
      8 * 1024 * 1024
    );
    let parsed;
    try {
      parsed = toml.parse(content);
    } catch {
      throw new Error('local source TOML is invalid');
    }
    const includes = Object.hasOwn(parsed, 'include') ? parsed.include : [];
    if (
      !Array.isArray(includes) ||
      includes.length > MAX_FILES ||
      includes.some((include) => typeof include !== 'string')
    ) {
      throw new Error('local source include list is invalid');
    }
    files.set(sourceFile, {
      content,
      path: sourceFile,
      sha256: sha256(content),
    });
    for (const include of includes) {
      await visit(resolveInclude(sourceFile, include), depth + 1);
    }
    active.delete(sourceFile);
  }

  await visit(SOURCE_ROOT, 0);
  const orderedFiles = [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path, 'en')
  );
  const canonical = {
    schemaVersion: 1,
    repository: 'Reya-Labs/reya-deployments',
    commit,
    root: SOURCE_ROOT,
    files: orderedFiles,
  };
  const bundleSha256 = sha256(JSON.stringify(canonical));
  if (bundleSha256 !== expectedBundleSha256) {
    throw new Error('local source bundle digest does not match the manifest');
  }
  return Object.freeze({
    ...canonical,
    bundleSha256,
    files: Object.freeze(orderedFiles.map((file) => Object.freeze(file))),
  });
}
