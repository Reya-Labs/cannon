import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import toml from '@iarna/toml';
import { COMMIT_PATTERN, SOURCE_PREFIX } from './constants';
import { HttpError } from './errors';

export const SOURCE_REPOSITORY = 'Reya-Labs/reya-deployments';
export const SOURCE_ROOT = 'packages/tomls/src/omnibus/reya_network.toml';
const MAX_GRAPH_DEPTH = 16;
const MAX_GRAPH_FILES = 512;
const MAX_GRAPH_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export type SourceFile = {
  content: string;
  path: string;
  sha256: string;
};

export type SourceBundle = {
  bundleSha256: string;
  commit: string;
  files: SourceFile[];
  repository: typeof SOURCE_REPOSITORY;
  root: typeof SOURCE_ROOT;
  schemaVersion: 1;
};

export type EncodedBundle = {
  body: string;
  bundle: SourceBundle;
  etag: string;
};

function reject(message: string): never {
  throw new HttpError(502, 'source_graph_rejected', message);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function includes(content: string, current: string): string[] {
  let parsed: unknown;
  try {
    parsed = toml.parse(content);
  } catch {
    reject(`source TOML cannot be parsed at ${current}`);
  }
  if (parsed === null || typeof parsed !== 'object') reject(`source TOML is invalid at ${current}`);
  const raw = Object.hasOwn(parsed, 'include') ? (parsed as { include?: unknown }).include : undefined;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_GRAPH_FILES || raw.some((value) => typeof value !== 'string')) {
    reject(`source include list is invalid at ${current}`);
  }
  return raw as string[];
}

function includePath(current: string, include: string): string {
  if (!include || include.length > 512 || include.includes('\0') || include.includes('\\') || include.startsWith('/')) {
    reject(`source include path is invalid at ${current}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(current), include));
  if (resolved.length > 512 || !resolved.startsWith(SOURCE_PREFIX) || !resolved.endsWith('.toml')) {
    reject(`source include escapes the approved TOML root at ${current}`);
  }
  return resolved;
}

/**
 * Encodes the deterministic, integrity-addressed include closure for Reya Network.
 *
 * Unreachable archive files are omitted and every included file receives a
 * SHA-256 digest before the canonical bundle itself is digested.
 *
 * @param commit - Exact lowercase 40-character Git commit.
 * @param archiveFiles - Validated repository-relative TOML source files.
 * @returns Canonical bundle, serialized body, and digest-derived ETag.
 * @throws HttpError for an invalid commit or rejected include graph.
 */
export function encodeSourceBundle(commit: string, archiveFiles: ReadonlyMap<string, string>): EncodedBundle {
  if (!COMMIT_PATTERN.test(commit)) {
    throw new HttpError(400, 'invalid_commit', 'commit must be a lowercase full Git SHA');
  }
  const reachable = new Set<string>();
  const active = new Set<string>();
  let totalBytes = 0;

  const visit = (current: string, depth: number): void => {
    if (active.has(current)) reject(`source include graph contains a cycle at ${current}`);
    if (reachable.has(current)) return;
    if (depth > MAX_GRAPH_DEPTH) reject('source include graph exceeds the depth limit');
    const content = archiveFiles.get(current);
    if (content === undefined) reject(`source include is missing at ${current}`);
    reachable.add(current);
    if (reachable.size > MAX_GRAPH_FILES) reject('source include graph contains too many files');
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_GRAPH_BYTES) reject('source include graph exceeds the byte limit');

    active.add(current);
    for (const additional of includes(content, current)) {
      visit(includePath(current, additional), depth + 1);
    }
    active.delete(current);
  };

  visit(SOURCE_ROOT, 0);
  const files = [...reachable].sort(compare).map((path): SourceFile => {
    const content = archiveFiles.get(path)!;
    return {
      content,
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  });
  const canonical: Omit<SourceBundle, 'bundleSha256'> = {
    schemaVersion: 1 as const,
    repository: SOURCE_REPOSITORY,
    commit,
    root: SOURCE_ROOT,
    files,
  };
  const bundleSha256 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const bundle: SourceBundle = { ...canonical, bundleSha256 };
  const body = JSON.stringify(bundle);
  if (Buffer.byteLength(body) > MAX_BUNDLE_BYTES) reject('encoded source bundle exceeds the response byte limit');
  return {
    body,
    bundle,
    etag: `"sha256-${bundleSha256}"`,
  };
}
