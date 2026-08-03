import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { REYA_CHAIN_ID } from '../config.mjs';
import { PreviewError } from '../errors.mjs';
import { isPrunedStateError, PRUNED_STATE_MARKERS } from '../rpc.mjs';

// Pinned so the container image and this check cannot drift apart: the
// Dockerfile installs exactly this Foundry build and the fork refuses to start
// against any other one.
export const EXPECTED_ANVIL_VERSION =
  'anvil Version: 1.2.3-v1.2.3\n' +
  'Commit SHA: a813a2cee7dd4926e7c56fd8a785b54f32e0d10f\n';

export const FORK_STARTUP_TIMEOUT_MS = 60_000;
export const FORK_REQUEST_TIMEOUT_MS = 180_000;
export const MAX_FORK_RESPONSE_BYTES = 16 * 1024 * 1024;
export const MAX_FORK_REQUEST_BYTES = 4 * 1024 * 1024;

// JSON-RPC 2.0 spells the rejection member `error`, lowercase. Scanning the
// raw bytes for it costs no allocation and lets a large successful body skip
// the decode entirely — without ever skipping a body that could carry one.
const ERROR_MEMBER = Buffer.from('"error"', 'utf8');

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const HEX_QUANTITY_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const REYA_CHAIN_ID_HEX = `0x${REYA_CHAIN_ID.toString(16)}`;
const SAFE_FORK_BALANCE = '0x21e19e0c9bab2400000';

function forkFailure() {
  throw new PreviewError(502, 'PREVIEW_FAILED');
}

function prunedState() {
  throw new PreviewError(503, 'RPC_PINNED_STATE_UNAVAILABLE');
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('preview fork port allocation failed'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Refuses to run against any Anvil but the pinned one. A preview is only
 * meaningful if the EVM that produced it is the reviewed one.
 */
export async function verifyAnvilRuntime(execFileImpl = execFile) {
  let stdout;
  try {
    stdout = await new Promise((resolve, reject) => {
      execFileImpl(
        'anvil',
        ['--version'],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
          maxBuffer: 4_096,
          timeout: 5_000,
          windowsHide: true,
        },
        (error, value) => (error ? reject(error) : resolve(value)),
      );
    });
  } catch {
    forkFailure();
  }
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout) > 4_096 ||
    !stdout.startsWith(EXPECTED_ANVIL_VERSION)
  ) {
    forkFailure();
  }
}

/**
 * Recognises a pruned-state rejection inside a raw upstream response body.
 *
 * This is the only place a pinned-state failure can be observed once the build
 * is running, because from then on it is Anvil — not this process — that talks
 * to the upstream.
 */
export function detectPrunedState(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  // Deliberately not bounded by size. A batched response mixes large results
  // with individual rejections, so a size gate here would silently exempt
  // exactly the responses that most need checking — and the fail-closed
  // pinned-state guarantee is derived from this flag. The body is already
  // capped at MAX_FORK_RESPONSE_BYTES, and the two filters below mean a large
  // body carrying no rejection costs one scan of the raw bytes.
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!raw.includes(ERROR_MEMBER)) return false;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  // The markers gate the parse; the parse itself sees the original bytes, so a
  // JSON-RPC member is never altered by the case-folding done to match them.
  const folded = text.toLowerCase();
  if (!PRUNED_STATE_MARKERS.some((marker) => folded.includes(marker))) {
    return false;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return false;
  }
  const entries = Array.isArray(body) ? body : [body];
  return entries.some(
    (entry) =>
      entry !== null &&
      typeof entry === 'object' &&
      Object.hasOwn(entry, 'error') &&
      isPrunedStateError(entry.error),
  );
}

async function boundedResponseBytes(response) {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    forkFailure();
  }
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_FORK_RESPONSE_BYTES)
  ) {
    await response.body.cancel();
    forkFailure();
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array)) forkFailure();
    size += chunk.byteLength;
    if (size > MAX_FORK_RESPONSE_BYTES) forkFailure();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/**
 * Stands between Anvil and the credentialed Reya RPC.
 *
 * Anvil is given a loopback origin, so the upstream URL — which carries a
 * provider token in its path — never reaches its argument vector, its output
 * or a crash report. The proxy is also the only vantage point from which a
 * mid-build pruned-state rejection is visible, so it records one.
 */
export async function createUpstreamProxy({
  fetchImpl = globalThis.fetch,
  upstream,
}) {
  const lifecycle = new AbortController();
  const sockets = new Set();
  let observedPrunedState = false;

  const server = http.createServer((request, response) => {
    void (async () => {
      if (
        request.method !== 'POST' ||
        request.url !== '/' ||
        request.headers['content-type']?.split(';', 1)[0].trim() !==
          'application/json'
      ) {
        response.writeHead(404).end();
        return;
      }
      const declared = request.headers['content-length'];
      if (
        declared !== undefined &&
        (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
          Number(declared) > MAX_FORK_REQUEST_BYTES)
      ) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > MAX_FORK_REQUEST_BYTES) {
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const upstreamResponse = await fetchImpl(upstream, {
        body: Buffer.concat(chunks, size),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([
          lifecycle.signal,
          AbortSignal.timeout(FORK_REQUEST_TIMEOUT_MS),
        ]),
      });
      const bytes = await boundedResponseBytes(upstreamResponse);
      if (detectPrunedState(bytes)) observedPrunedState = true;
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': String(bytes.byteLength),
        'content-type': 'application/json',
      });
      response.end(bytes);
    })().catch(() => {
      // The upstream URL may carry a credential, so nothing about the failure
      // is logged or forwarded; Anvil sees an opaque gateway error.
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    forkFailure();
  }
  let closePromise;
  return Object.freeze({
    close() {
      closePromise ??= (async () => {
        lifecycle.abort(new Error('preview fork proxy stopped'));
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      })();
      return closePromise;
    },
    origin: `http://127.0.0.1:${address.port}`,
    get prunedState() {
      return observedPrunedState;
    },
  });
}

export function createForkRequest(origin, signal) {
  let id = 0;
  return async ({ method, params = [] }) => {
    if (
      typeof method !== 'string' ||
      !/^[a-z][A-Za-z0-9_]{0,127}$/.test(method) ||
      !Array.isArray(params)
    ) {
      throw new Error('preview fork RPC request is invalid');
    }
    const requestId = ++id;
    const timeout = AbortSignal.timeout(FORK_REQUEST_TIMEOUT_MS);
    let response;
    let bytes;
    try {
      response = await fetch(origin, {
        body: JSON.stringify({
          id: requestId,
          jsonrpc: '2.0',
          method,
          params,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
        signal:
          signal instanceof AbortSignal
            ? AbortSignal.any([signal, timeout])
            : timeout,
      });
      bytes = await boundedResponseBytes(response);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      forkFailure();
    }
    let body;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      forkFailure();
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      body.id !== requestId ||
      Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error')
    ) {
      forkFailure();
    }
    if (Object.hasOwn(body, 'error')) {
      if (isPrunedStateError(body.error)) prunedState();
      // The builder distinguishes a reverted call from a transport failure, so
      // an RPC-level rejection must stay an ordinary error here rather than
      // becoming a fail-closed preview error.
      throw new Error(`preview fork RPC ${method} was rejected`);
    }
    return body.result;
  };
}

function observedForkBlock(value, expectedNumber) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.number !== 'string' ||
    !HEX_QUANTITY_PATTERN.test(value.number) ||
    (expectedNumber !== undefined && value.number !== expectedNumber) ||
    typeof value.hash !== 'string' ||
    !HASH_PATTERN.test(value.hash)
  ) {
    forkFailure();
  }
  return Object.freeze({
    blockHash: value.hash,
    blockNumber: BigInt(value.number).toString(),
  });
}

/**
 * Starts one disposable Anvil fork of Reya Network for a single preview.
 *
 * The fork is pinned to the block the upstream reported at start-up, so every
 * step of one build reads the same state. Before the build begins the upstream
 * is asked for that block's state directly: if it cannot serve it, the request
 * fails closed with `RPC_PINNED_STATE_UNAVAILABLE` rather than quietly reading
 * a later state and answering a reproducibility question with today's chain.
 *
 * `verifyRuntime` exists so the pre-flight sequence can be exercised without a
 * Foundry install. It is a constructor argument of this process, never a
 * configuration or request value, and production always uses the default.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   safeAddress: string,
 *   signal?: AbortSignal,
 *   upstreamRpcUrl: string,
 *   verifyRuntime?: () => Promise<void>,
 * }} options
 */
export async function createPreviewFork({
  fetchImpl,
  safeAddress,
  signal,
  upstreamRpcUrl,
  verifyRuntime = verifyAnvilRuntime,
}) {
  if (
    typeof safeAddress !== 'string' ||
    !ADDRESS_PATTERN.test(safeAddress) ||
    typeof upstreamRpcUrl !== 'string' ||
    upstreamRpcUrl.length < 1 ||
    typeof verifyRuntime !== 'function'
  ) {
    throw new Error('preview fork configuration is invalid');
  }
  const lifecycle = new AbortController();
  const abortFromParent = () =>
    lifecycle.abort(new Error('preview fork stopped'));
  if (signal instanceof AbortSignal) {
    if (signal.aborted) throw new Error('preview fork lifecycle is invalid');
    signal.addEventListener('abort', abortFromParent, { once: true });
  }
  const detachParent = () => {
    if (signal instanceof AbortSignal) {
      signal.removeEventListener('abort', abortFromParent);
    }
  };

  let proxy;
  let child;
  try {
    await verifyRuntime();
    proxy = await createUpstreamProxy({
      fetchImpl,
      upstream: upstreamRpcUrl,
    });
    const upstreamRequest = createForkRequest(proxy.origin, lifecycle.signal);
    if (
      (await upstreamRequest({ method: 'eth_chainId' })) !== REYA_CHAIN_ID_HEX
    ) {
      forkFailure();
    }
    const head = observedForkBlock(
      await upstreamRequest({
        method: 'eth_getBlockByNumber',
        params: ['latest', false],
      }),
    );
    const pinnedNumber = `0x${BigInt(head.blockNumber).toString(16)}`;
    // Proves the upstream can still serve state at the block the fork pins to.
    // `createForkRequest` turns a pruned-state rejection into the fail-closed
    // contract, so this never degrades into a latest-state read.
    await upstreamRequest({
      method: 'eth_getBalance',
      params: [safeAddress, pinnedNumber],
    });

    const port = await availablePort();
    child = spawn(
      'anvil',
      [
        '--accounts',
        '1',
        '--chain-id',
        String(REYA_CHAIN_ID),
        '--fork-url',
        proxy.origin,
        '--fork-block-number',
        head.blockNumber,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        env: { PATH: process.env.PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const origin = `http://127.0.0.1:${port}`;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lifecycle.signal.removeEventListener('abort', abortStartup);
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('preview fork startup timed out'))),
        FORK_STARTUP_TIMEOUT_MS,
      );
      const abortStartup = () =>
        finish(() => reject(new Error('preview fork startup interrupted')));
      child.once('error', () =>
        finish(() => reject(new Error('preview fork failed to start'))),
      );
      child.once('exit', () =>
        finish(() => reject(new Error('preview fork exited before startup'))),
      );
      let startupTail = '';
      child.stdout.on('data', (chunk) => {
        startupTail = `${startupTail}${chunk.toString('utf8')}`.slice(-256);
        if (startupTail.includes('Listening on')) finish(resolve);
      });
      child.stderr.on('data', () => {
        // Discarded deliberately: Anvil echoes its fork URL, and although that
        // is the loopback proxy today, nothing downstream should depend on it.
      });
      if (lifecycle.signal.aborted) abortStartup();
      else {
        lifecycle.signal.addEventListener('abort', abortStartup, {
          once: true,
        });
      }
    });

    const request = createForkRequest(origin, lifecycle.signal);
    if ((await request({ method: 'eth_chainId' })) !== REYA_CHAIN_ID_HEX) {
      forkFailure();
    }
    const forkBlock = observedForkBlock(
      await request({
        method: 'eth_getBlockByNumber',
        params: [pinnedNumber, false],
      }),
      pinnedNumber,
    );
    if (forkBlock.blockHash !== head.blockHash) forkFailure();
    await request({
      method: 'anvil_impersonateAccount',
      params: [safeAddress],
    });
    await request({
      method: 'anvil_setBalance',
      params: [safeAddress, SAFE_FORK_BALANCE],
    });

    const startedChild = child;
    const startedProxy = proxy;
    let stopPromise;
    return Object.freeze({
      forkBlock,
      origin,
      get prunedState() {
        return startedProxy.prunedState;
      },
      request,
      stop() {
        stopPromise ??= (async () => {
          lifecycle.abort(new Error('preview fork stopped'));
          if (
            startedChild.exitCode === null &&
            startedChild.signalCode === null
          ) {
            await new Promise((resolve) => {
              const timer = setTimeout(
                () => startedChild.kill('SIGKILL'),
                5_000,
              );
              startedChild.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              startedChild.kill('SIGTERM');
            });
          }
          await startedProxy.close();
          detachParent();
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    lifecycle.abort(new Error('preview fork stopped'));
    child?.kill('SIGKILL');
    await proxy?.close();
    detachParent();
    throw error;
  }
}
