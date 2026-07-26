import 'dotenv/config';
import * as viem from 'viem';
/* eslint no-console: "off" */
import { FourByteConfig, loadFourByteConfig } from './4byte-config';
import * as rkey from './db';
import { useRedis } from './redis';

export type DirectoryKind = 'function' | 'event';

type DirectoryEntry = {
  id: number;
  createdAt: string;
  textSignature: string;
  hexSignature: string;
  bytesSignature: string;
};

type DirectoryPage = {
  count: number;
  next: string | null;
  previous: string | null;
  results: DirectoryEntry[];
};

type RedisBatch = {
  exec(): Promise<unknown>;
  hSetNX(key: string, field: string, value: string): RedisBatch;
  set(key: string, value: string): RedisBatch;
};

export type FourByteRedis = {
  get(key: string): Promise<string | null>;
  multi(): RedisBatch;
};

export type FeedSummary = {
  entries: number;
  kind: DirectoryKind;
  pages: number;
};

export type EnrichmentSummary = {
  failures: Array<{ error: Error; kind: DirectoryKind }>;
  feeds: FeedSummary[];
};

type Fetch = (input: string | URL, init?: Parameters<typeof fetch>[1]) => Promise<Response>;
type Sleep = (milliseconds: number) => Promise<void>;
type ReserveEntries = (entries: number) => void;

class RetryableRequestError extends Error {}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${context} must be a string or null`);
  return value;
}

function safeInteger(value: unknown, context: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${context} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

export function resolvePageUrl(value: string, baseUrl: string): string {
  let pageUrl: URL;
  const configuredOrigin = new URL(baseUrl);
  try {
    pageUrl = new URL(value, `${configuredOrigin.origin}/`);
  } catch {
    throw new Error('4byte pagination URL is invalid');
  }

  // 4byte currently emits absolute http:// links behind its HTTPS proxy. Canonicalize
  // only that same-authority downgrade; no request is ever made over plaintext HTTP.
  if (pageUrl.protocol === 'http:' && pageUrl.host === configuredOrigin.host) {
    pageUrl.protocol = 'https:';
  }

  if (
    pageUrl.protocol !== 'https:' ||
    pageUrl.origin !== configuredOrigin.origin ||
    pageUrl.username ||
    pageUrl.password ||
    pageUrl.hash
  ) {
    throw new Error(`4byte pagination must remain on configured HTTPS origin ${configuredOrigin.origin}`);
  }
  if (pageUrl.toString().length > 2_048) throw new Error('4byte pagination URL exceeds the configured safety bound');

  return pageUrl.toString();
}

function validateSelector(kind: DirectoryKind, textSignature: string, hexSignature: unknown): string {
  const expectedLength = kind === 'function' ? 8 : 64;
  if (typeof hexSignature !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${expectedLength}}$`).test(hexSignature)) {
    throw new Error(`4byte ${kind} selector has an invalid shape`);
  }

  const digest = viem.keccak256(viem.toBytes(textSignature));
  const expectedSelector = kind === 'function' ? digest.slice(0, 10) : digest;
  if (hexSignature.toLowerCase() !== expectedSelector.toLowerCase()) {
    throw new Error(`4byte ${kind} selector does not match its text signature`);
  }

  return hexSignature.toLowerCase();
}

function parseEntry(value: unknown, kind: DirectoryKind): DirectoryEntry {
  const entry = asRecord(value, `4byte ${kind} entry`);
  const id = safeInteger(entry.id, `4byte ${kind} entry id`, 1);
  if (
    typeof entry.text_signature !== 'string' ||
    entry.text_signature.length < 1 ||
    entry.text_signature.length > 4_096 ||
    !/^[\x20-\x7e]+$/.test(entry.text_signature)
  ) {
    throw new Error(`4byte ${kind} text signature must be 1-4096 printable ASCII characters`);
  }
  if (typeof entry.created_at !== 'string' || !Number.isFinite(Date.parse(entry.created_at))) {
    throw new Error(`4byte ${kind} created_at must be a valid timestamp`);
  }
  if (typeof entry.bytes_signature !== 'string' || entry.bytes_signature.length > 4_096) {
    throw new Error(`4byte ${kind} bytes_signature must be a bounded string`);
  }

  return {
    id,
    createdAt: entry.created_at,
    textSignature: entry.text_signature,
    hexSignature: validateSelector(kind, entry.text_signature, entry.hex_signature),
    bytesSignature: entry.bytes_signature,
  };
}

export function parseDirectoryPage(value: unknown, kind: DirectoryKind, baseUrl: string, maxResults: number): DirectoryPage {
  const page = asRecord(value, `4byte ${kind} page`);
  const count = safeInteger(page.count, `4byte ${kind} count`);
  if (!Array.isArray(page.results)) throw new Error(`4byte ${kind} results must be an array`);
  if (page.results.length > maxResults) {
    throw new Error(`4byte ${kind} page exceeds the configured result bound`);
  }

  const results = page.results.map((entry) => parseEntry(entry, kind));
  if (new Set(results.map((entry) => entry.id)).size !== results.length) {
    throw new Error(`4byte ${kind} page contains duplicate entry ids`);
  }
  if (count < results.length) throw new Error(`4byte ${kind} count is smaller than its result set`);

  const next = asNullableString(page.next, `4byte ${kind} next`);
  const previous = asNullableString(page.previous, `4byte ${kind} previous`);

  return {
    count,
    next: next === null ? null : resolvePageUrl(next, baseUrl),
    previous: previous === null ? null : resolvePageUrl(previous, baseUrl),
    results,
  };
}

async function readBoundedJson(response: Response, maxResponseBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('4byte response must use application/json');

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxResponseBytes) {
      throw new Error('4byte response Content-Length exceeds the configured byte bound');
    }
  }

  if (!response.body) throw new Error('4byte response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    let streamComplete = false;
    while (!streamComplete) {
      const { done, value } = await reader.read();
      if (done) {
        streamComplete = true;
        continue;
      }
      if (!value) throw new Error('4byte response stream returned an invalid chunk');
      receivedBytes += value.byteLength;
      if (receivedBytes > maxResponseBytes) {
        await reader.cancel();
        throw new Error('4byte response body exceeds the configured byte bound');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new Error('4byte response body is not valid UTF-8');
  }

  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error('4byte response body is not valid JSON');
  }
}

async function requestPage(url: string, config: FourByteConfig, fetchPage: Fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let response: Response;

  try {
    response = await fetchPage(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new RetryableRequestError(`4byte request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('4byte redirects are forbidden');
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      throw new RetryableRequestError(`4byte request returned retryable HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`4byte request returned HTTP ${response.status}`);

    if (response.url && new URL(response.url).toString() !== new URL(url).toString()) {
      throw new Error('4byte response URL does not match the requested URL');
    }

    return await readBoundedJson(response, config.maxResponseBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestPageWithRetries(url: string, config: FourByteConfig, fetchPage: Fetch, wait: Sleep): Promise<unknown> {
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      return await requestPage(url, config, fetchPage);
    } catch (error) {
      if (!(error instanceof RetryableRequestError) || attempt >= config.retries) throw error;
      await wait(Math.min(config.retryBaseMs * 2 ** attempt, config.retryMaxMs));
    }
  }

  throw new Error('4byte retry loop exhausted unexpectedly');
}

function initialPageUrl(kind: DirectoryKind, baseUrl: string): string {
  const path = kind === 'function' ? '/api/v1/signatures/' : '/api/v1/event-signatures/';
  return resolvePageUrl(`${path}?format=json`, baseUrl);
}

function cursorKey(kind: DirectoryKind): string {
  return `${rkey.RKEY_4BYTE_CURSOR_PREFIX}:${kind}`;
}

function entryKey(kind: DirectoryKind, id: number): string {
  return `${rkey.RKEY_4BYTE_ABI_PREFIX}:${kind}:${id}`;
}

export async function scanFeed(
  redis: FourByteRedis,
  kind: DirectoryKind,
  config: FourByteConfig,
  entryBudget: number,
  fetchPage: Fetch = fetch,
  wait: Sleep = sleep,
  reserveEntries: ReserveEntries = () => undefined
): Promise<FeedSummary> {
  const storedCursor = await redis.get(cursorKey(kind));
  let nextUrl = storedCursor ? resolvePageUrl(storedCursor, config.baseUrl) : initialPageUrl(kind, config.baseUrl);
  let entries = 0;
  let pages = 0;
  const visitedUrls = new Set<string>();

  while (nextUrl && pages < config.maxPagesPerFeed) {
    if (visitedUrls.has(nextUrl)) throw new Error(`4byte ${kind} pagination contains a cycle`);
    visitedUrls.add(nextUrl);
    const page = parseDirectoryPage(
      await requestPageWithRetries(nextUrl, config, fetchPage, wait),
      kind,
      config.baseUrl,
      config.maxResultsPerPage
    );
    if (entries + page.results.length > entryBudget) {
      throw new Error('4byte run exceeds the configured aggregate entry bound');
    }
    // Reserve before EXEC so a lost transaction reply cannot make a committed page
    // disappear from the shared run budget. Reservations are intentionally not
    // refunded on failure; conservative under-utilization is safer than overrun.
    reserveEntries(page.results.length);

    const batch = redis.multi();
    for (const item of page.results) {
      const key = entryKey(kind, item.id);
      batch.hSetNX(key, 'name', item.textSignature);
      batch.hSetNX(key, 'selector', item.hexSignature);
      batch.hSetNX(key, 'type', kind);
      batch.hSetNX(key, 'timestamp', Math.floor(Date.parse(item.createdAt) / 1_000).toString());
    }
    batch.set(cursorKey(kind), page.next ?? '');
    await batch.exec();

    entries += page.results.length;
    pages++;
    nextUrl = page.next ?? '';
  }

  return { entries, kind, pages };
}

export async function runFourByteEnrichment(
  redis: FourByteRedis,
  config: FourByteConfig,
  fetchPage: Fetch = fetch,
  wait: Sleep = sleep
): Promise<EnrichmentSummary> {
  const failures: EnrichmentSummary['failures'] = [];
  const feeds: FeedSummary[] = [];
  let reservedEntries = 0;

  for (const kind of ['function', 'event'] as const) {
    try {
      const result = await scanFeed(
        redis,
        kind,
        config,
        config.maxEntriesPerRun - reservedEntries,
        fetchPage,
        wait,
        (entries) => {
          if (reservedEntries + entries > config.maxEntriesPerRun) {
            throw new Error('4byte run exceeds the configured aggregate entry bound');
          }
          reservedEntries += entries;
        }
      );
      feeds.push(result);
    } catch (error) {
      failures.push({ error: error instanceof Error ? error : new Error(String(error)), kind });
    }
  }

  return { failures, feeds };
}

export async function loop(environment: unknown = process.env): Promise<void> {
  const config = loadFourByteConfig(environment);
  if (!config.enabled) {
    console.log('4byte enrichment is disabled');
    return;
  }

  const redis = await useRedis(config.redisUrl);
  try {
    const summary = await runFourByteEnrichment(redis as FourByteRedis, config);
    console.log(
      '4byte enrichment completed',
      summary.feeds.map(({ entries, kind, pages }) => ({ entries, kind, pages }))
    );
    if (summary.failures.length) {
      throw new Error(
        `4byte enrichment failed for ${summary.failures.map(({ error, kind }) => `${kind}: ${error.message}`).join('; ')}`
      );
    }
  } finally {
    await redis.quit();
  }
}

if (require.main === module) {
  void loop().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
