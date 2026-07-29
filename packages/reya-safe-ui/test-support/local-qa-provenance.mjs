import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  opendir,
  readFile,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CANNON_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HEAD_STDOUT_BYTES = 128;
const STATUS_STDOUT_BYTES = 1024 * 1024;
const LOCKFILE_BYTES = 8 * 1024 * 1024;
const PACKAGE_JSON_BYTES = 128 * 1024;
const RUNTIME_OUTPUT_BYTES = 64 * 1024 * 1024;
const RUNTIME_OUTPUT_ENTRIES = 4_096;
const RUNTIME_OUTPUT_FILES = 4_096;
const RUNTIME_OUTPUT_DEPTH = 32;
const EXPECTED_NODE_VERSION = '22.23.1';
const EXPECTED_PNPM_VERSION = '10.11.0';
const OPTION_KEYS = new Set(['execFileImpl', 'repositoryRoot', 'signal']);

function reject(message) {
  throw new Error(`local QA provenance rejected: ${message}`);
}

function canonicalOptions(value) {
  if (value === undefined) {
    return {
      execFileImpl: execFile,
      repositoryRoot: CANNON_ROOT,
      signal: undefined,
    };
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    reject('options are invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string' || !OPTION_KEYS.has(key))
  ) {
    reject('options are invalid');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      reject('options are invalid');
    }
  }
  const execFileImpl = Object.hasOwn(value, 'execFileImpl')
    ? value.execFileImpl
    : execFile;
  const repositoryRoot = Object.hasOwn(value, 'repositoryRoot')
    ? value.repositoryRoot
    : CANNON_ROOT;
  const signal = Object.hasOwn(value, 'signal') ? value.signal : undefined;
  if (
    typeof execFileImpl !== 'function' ||
    typeof repositoryRoot !== 'string' ||
    !path.isAbsolute(repositoryRoot) ||
    repositoryRoot.includes('\0') ||
    (signal !== undefined && !(signal instanceof AbortSignal))
  ) {
    reject('options are invalid');
  }
  return {
    execFileImpl,
    repositoryRoot: path.normalize(repositoryRoot),
    signal,
  };
}

async function canonicalRepositoryRoot(repositoryRoot) {
  try {
    const supplied = await lstat(repositoryRoot);
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) {
      reject('repository is invalid');
    }
    const resolved = await realpath(repositoryRoot);
    const canonical = await lstat(resolved);
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
      reject('repository is invalid');
    }
    return resolved;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('local QA provenance rejected:')
    ) {
      throw error;
    }
    reject('repository is invalid');
  }
}

function boundedGitEnvironment(repositoryRoot) {
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.env.PATH ?? '',
    GIT_CEILING_DIRECTORIES: path.dirname(repositoryRoot),
  });
}

function runGit({
  args,
  execFileImpl,
  maximumStdoutBytes,
  repositoryRoot,
  signal,
}) {
  return new Promise((resolve, rejectPromise) => {
    let completed = false;
    const finish = (callback) => {
      if (completed) return;
      completed = true;
      callback();
    };
    const callback = (error, stdout) => {
      finish(() => {
        if (
          error ||
          typeof stdout !== 'string' ||
          Buffer.byteLength(stdout, 'utf8') > maximumStdoutBytes
        ) {
          rejectPromise(
            new Error('local QA provenance rejected: Git inspection failed')
          );
          return;
        }
        resolve(stdout);
      });
    };
    try {
      execFileImpl(
        'git',
        Object.freeze([...args]),
        Object.freeze({
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: boundedGitEnvironment(repositoryRoot),
          maxBuffer: maximumStdoutBytes,
          signal,
          timeout: 30_000,
          windowsHide: true,
        }),
        callback
      );
    } catch {
      finish(() =>
        rejectPromise(
          new Error('local QA provenance rejected: Git inspection failed')
        )
      );
    }
  });
}

function runFixedCommand({
  args,
  command,
  execFileImpl,
  maximumStdoutBytes,
  repositoryRoot,
  signal,
  timeout,
}) {
  return new Promise((resolve, rejectPromise) => {
    try {
      execFileImpl(
        command,
        Object.freeze([...args]),
        Object.freeze({
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: Object.freeze({
            CI: '1',
            PATH: process.env.PATH ?? '',
          }),
          maxBuffer: maximumStdoutBytes,
          signal,
          timeout,
          windowsHide: true,
        }),
        (error, stdout) => {
          if (
            error ||
            typeof stdout !== 'string' ||
            Buffer.byteLength(stdout, 'utf8') > maximumStdoutBytes
          ) {
            rejectPromise(
              new Error(
                'local QA provenance rejected: runtime preparation failed'
              )
            );
            return;
          }
          resolve(stdout);
        }
      );
    } catch {
      rejectPromise(
        new Error('local QA provenance rejected: runtime preparation failed')
      );
    }
  });
}

async function boundedFile(repositoryRoot, relativePath, maximumBytes) {
  const target = path.join(repositoryRoot, relativePath);
  try {
    const metadata = await lstat(target);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      reject('file inspection failed');
    }
    const bytes = await readFile(target);
    if (bytes.byteLength !== metadata.size) {
      reject('file inspection failed');
    }
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('local QA provenance rejected:')
    ) {
      throw error;
    }
    reject('file inspection failed');
  }
}

async function boundedDirectoryDigest(repositoryRoot, relativePath) {
  const root = path.join(repositoryRoot, relativePath);
  const files = [];
  let totalBytes = 0;
  let totalEntries = 0;

  const visit = async (directory, prefix, depth) => {
    if (depth > RUNTIME_OUTPUT_DEPTH) {
      reject('runtime output inspection failed');
    }
    const entries = [];
    const handle = await opendir(directory);
    for await (const entry of handle) {
      totalEntries += 1;
      if (totalEntries > RUNTIME_OUTPUT_ENTRIES) {
        reject('runtime output inspection failed');
      }
      entries.push(entry);
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      if (
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile())
      ) {
        reject('runtime output inspection failed');
      }
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, relative, depth + 1);
        continue;
      }
      if (files.length >= RUNTIME_OUTPUT_FILES) {
        reject('runtime output inspection failed');
      }
      const metadata = await lstat(target);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size < 1 ||
        metadata.size > RUNTIME_OUTPUT_BYTES - totalBytes
      ) {
        reject('runtime output inspection failed');
      }
      const bytes = await readFile(target);
      if (bytes.byteLength !== metadata.size) {
        reject('runtime output inspection failed');
      }
      totalBytes += bytes.byteLength;
      files.push(
        Object.freeze({
          bytes: bytes.byteLength,
          path: relative,
          sha256: sha256(bytes),
        })
      );
    }
  };

  try {
    const rootMetadata = await lstat(root);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      reject('runtime output inspection failed');
    }
    await visit(root, '', 0);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('local QA provenance rejected:')
    ) {
      throw error;
    }
    reject('runtime output inspection failed');
  }
  if (files.length < 1) reject('runtime output inspection failed');
  return sha256(Buffer.from(JSON.stringify(files), 'utf8'));
}

function sha256(bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!DIGEST_PATTERN.test(digest)) reject('digest calculation failed');
  return digest;
}

function packageVersion(bytes, expectedName) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    reject('package metadata is invalid');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.name !== expectedName ||
    typeof value.version !== 'string' ||
    value.version.length > 128 ||
    !VERSION_PATTERN.test(value.version)
  ) {
    reject('package metadata is invalid');
  }
  return value.version;
}

/**
 * Derives non-secret provenance for one local Cannon QA execution.
 *
 * With no options, the repository is fixed to the Cannon checkout enclosing
 * this module. The options are a narrow test seam; command names and arguments
 * remain fixed and every subprocess output is independently bounded.
 */
export async function loadLocalQaProvenance(options) {
  const canonical = canonicalOptions(options);
  const repositoryRoot = await canonicalRepositoryRoot(
    canonical.repositoryRoot
  );
  const [
    headOutput,
    statusOutput,
    lockfile,
    safeUiPackage,
    builderPackage,
    codecPackage,
    builderDist,
    artifactCodecDist,
  ] = await Promise.all([
      runGit({
        args: ['rev-parse', '--verify', 'HEAD'],
        execFileImpl: canonical.execFileImpl,
        maximumStdoutBytes: HEAD_STDOUT_BYTES,
        repositoryRoot,
        signal: canonical.signal,
      }),
      runGit({
        args: [
          'status',
          '--porcelain=v1',
          '--untracked-files=normal',
          '-z',
        ],
        execFileImpl: canonical.execFileImpl,
        maximumStdoutBytes: STATUS_STDOUT_BYTES,
        repositoryRoot,
        signal: canonical.signal,
      }),
      boundedFile(repositoryRoot, 'pnpm-lock.yaml', LOCKFILE_BYTES),
      boundedFile(
        repositoryRoot,
        'packages/reya-safe-ui/package.json',
        PACKAGE_JSON_BYTES
      ),
      boundedFile(
        repositoryRoot,
        'packages/builder/package.json',
        PACKAGE_JSON_BYTES
      ),
      boundedFile(
        repositoryRoot,
        'packages/artifact-codec/package.json',
        PACKAGE_JSON_BYTES
      ),
      boundedDirectoryDigest(repositoryRoot, 'packages/builder/dist'),
      boundedDirectoryDigest(repositoryRoot, 'packages/artifact-codec/dist'),
    ]);
  if (!/^[0-9a-f]{40}\n$/.test(headOutput)) {
    reject('Git HEAD is invalid');
  }
  const cannonCommit = headOutput.slice(0, -1);
  if (!COMMIT_PATTERN.test(cannonCommit)) reject('Git HEAD is invalid');
  if (statusOutput.length > 0) reject('Cannon worktree is dirty');

  return Object.freeze({
    schemaVersion: 1,
    cannonCommit,
    worktreeDirty: false,
    nodeVersion: EXPECTED_NODE_VERSION,
    pnpmVersion: EXPECTED_PNPM_VERSION,
    pnpmLockSha256: sha256(lockfile),
    reyaSafeUiPackageJsonSha256: sha256(safeUiPackage),
    builderVersion: packageVersion(builderPackage, '@usecannon/builder'),
    artifactCodecVersion: packageVersion(
      codecPackage,
      '@usecannon/artifact-codec'
    ),
    builderDistSha256: builderDist,
    artifactCodecDistSha256: artifactCodecDist,
  });
}

export function validateLocalQaRuntimeVersions({
  nodeVersion,
  pnpmVersion,
}) {
  if (
    nodeVersion !== EXPECTED_NODE_VERSION ||
    pnpmVersion !== EXPECTED_PNPM_VERSION
  ) {
    reject('runtime version is invalid');
  }
}

export async function prepareLocalQaRuntime(options) {
  const canonical = canonicalOptions(options);
  const repositoryRoot = await canonicalRepositoryRoot(
    canonical.repositoryRoot
  );
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    reject('runtime version is invalid');
  }
  const preflightStatus = await runGit({
    args: [
      'status',
      '--porcelain=v1',
      '--untracked-files=normal',
      '-z',
    ],
    execFileImpl: canonical.execFileImpl,
    maximumStdoutBytes: STATUS_STDOUT_BYTES,
    repositoryRoot,
    signal: canonical.signal,
  });
  if (preflightStatus.length > 0) reject('Cannon worktree is dirty');
  const pnpmVersion = (
    await runFixedCommand({
      args: ['--version'],
      command: 'pnpm',
      execFileImpl: canonical.execFileImpl,
      maximumStdoutBytes: 128,
      repositoryRoot,
      signal: canonical.signal,
      timeout: 30_000,
    })
  ).trim();
  validateLocalQaRuntimeVersions({
    nodeVersion: process.versions.node,
    pnpmVersion,
  });
  await runFixedCommand({
    args: ['--filter', '@usecannon/builder', 'build:node'],
    command: 'pnpm',
    execFileImpl: canonical.execFileImpl,
    maximumStdoutBytes: 1024 * 1024,
    repositoryRoot,
    signal: canonical.signal,
    timeout: 300_000,
  });
  return loadLocalQaProvenance(canonical);
}
