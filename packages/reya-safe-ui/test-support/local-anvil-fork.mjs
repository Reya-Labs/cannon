import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const CHAIN_ID = 1729;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const MAX_RPC_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RPC_REQUEST_BYTES = 1024 * 1024;
const UPSTREAM_ATTEMPTS = 4;
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const EXPECTED_ANVIL_VERSION =
  'anvil Version: 1.2.3-v1.2.3\n' +
  'Commit SHA: a813a2cee7dd4926e7c56fd8a785b54f32e0d10f\n';

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('local fork port allocation failed'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

export async function verifyAnvilRuntime(execFileImpl = execFile) {
  if (typeof execFileImpl !== 'function') {
    throw new Error('local Anvil verifier is invalid');
  }
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
        (error, value) => {
          if (error) reject(error);
          else resolve(value);
        }
      );
    });
  } catch {
    throw new Error('required local Anvil runtime is unavailable');
  }
  if (
    typeof stdout !== 'string' ||
    Buffer.byteLength(stdout) > 4_096 ||
    !stdout.startsWith(EXPECTED_ANVIL_VERSION)
  ) {
    throw new Error('required local Anvil runtime is unavailable');
  }
}

function upstreamUrl(value) {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new Error('local fork upstream URL is invalid');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('local fork upstream URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.href
  ) {
    throw new Error('local fork upstream URL is invalid');
  }
  return value;
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('local fork stopped'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createRpcRequest(origin, signal) {
  let id = 0;
  return async ({ method, params = [] }) => {
    if (
      typeof method !== 'string' ||
      !/^[a-z][A-Za-z0-9_]{0,127}$/.test(method) ||
      !Array.isArray(params)
    ) {
      throw new Error('local fork RPC request is invalid');
    }
    const requestId = ++id;
    const timeout = AbortSignal.timeout(180_000);
    let response;
    let bytes;
    try {
      response = await fetch(origin, {
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }),
        headers: {
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'error',
        signal:
          signal instanceof AbortSignal
            ? AbortSignal.any([signal, timeout])
            : timeout,
      });
      bytes = await boundedResponseBytes(response);
    } catch (error) {
      throw new Error(`local fork RPC ${method} transport failed`, {
        cause: error,
      });
    }
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('local fork RPC response is invalid');
    }
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.jsonrpc !== '2.0' ||
      body.id !== requestId ||
      !Object.hasOwn(body, 'result') === !Object.hasOwn(body, 'error')
    ) {
      throw new Error('local fork RPC response is invalid');
    }
    if (Object.hasOwn(body, 'error')) {
      const code = Number.isSafeInteger(body.error?.code)
        ? String(body.error.code)
        : 'unknown';
      throw new Error(`local fork RPC ${method} failed with code ${code}`);
    }
    return body.result;
  };
}

async function boundedResponseBytes(response) {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error('local fork upstream request failed');
  }
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) ||
      Number(declared) > MAX_RPC_RESPONSE_BYTES)
  ) {
    await response.body.cancel();
    throw new Error('local fork upstream response is too large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) {
      await reader.cancel();
      throw new Error('local fork upstream response is invalid');
    }
    size += part.value.byteLength;
    if (size > MAX_RPC_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('local fork upstream response is too large');
    }
    chunks.push(part.value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size
  );
}

export async function createUpstreamProxy(upstream) {
  const lifecycle = new AbortController();
  const sockets = new Set();
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
          Number(declared) > MAX_RPC_REQUEST_BYTES)
      ) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > MAX_RPC_REQUEST_BYTES) {
          response.writeHead(413).end();
          request.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks, size);
      let upstreamResponse;
      for (let attempt = 1; attempt <= UPSTREAM_ATTEMPTS; attempt += 1) {
        try {
          upstreamResponse = await fetch(upstream, {
            body,
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
            },
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.any([
              lifecycle.signal,
              AbortSignal.timeout(180_000),
            ]),
          });
        } catch (error) {
          if (lifecycle.signal.aborted || attempt === UPSTREAM_ATTEMPTS) {
            throw error;
          }
          await abortableDelay(100 * 2 ** (attempt - 1), lifecycle.signal);
          continue;
        }
        if (
          !RETRYABLE_HTTP_STATUSES.has(upstreamResponse.status) ||
          attempt === UPSTREAM_ATTEMPTS
        ) {
          break;
        }
        await upstreamResponse.body?.cancel();
        await abortableDelay(100 * 2 ** (attempt - 1), lifecycle.signal);
      }
      if (!upstreamResponse) {
        throw new Error('local fork upstream request failed');
      }
      const bytes = await boundedResponseBytes(upstreamResponse);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': String(bytes.byteLength),
        'content-type': 'application/json',
      });
      response.end(bytes);
    })().catch(() => {
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
    throw new Error('local fork proxy startup failed');
  }
  let closePromise;
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    close() {
      closePromise ??= (async () => {
        lifecycle.abort(new Error('local fork proxy stopped'));
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      })();
      return closePromise;
    },
  });
}

function observedForkBlock(
  value,
  expectedNumber,
  expectedHash,
  mode = 'upstream-finalized'
) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.number !== 'string' ||
    !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value.number) ||
    (expectedNumber !== undefined && value.number !== expectedNumber) ||
    typeof value.hash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.hash) ||
    (expectedHash !== undefined && value.hash !== expectedHash) ||
    !['explicit-pinned', 'interactive-latest', 'upstream-finalized'].includes(
      mode
    )
  ) {
    throw new Error('local fork upstream block is invalid');
  }
  return Object.freeze({
    blockHash: value.hash,
    blockNumber: BigInt(value.number).toString(),
    mode,
  });
}

function requestedForkBlock(value) {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value)) !==
      JSON.stringify(['blockHash', 'blockNumber']) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    typeof value.blockNumber !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(value.blockNumber) ||
    typeof value.blockHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(value.blockHash)
  ) {
    throw new Error('local fork requested block is invalid');
  }
  return value;
}

export async function selectPinnedForkBlock({
  forkBlock,
  request,
  safeAddress,
}) {
  if (
    typeof request !== 'function' ||
    typeof safeAddress !== 'string' ||
    !ADDRESS_PATTERN.test(safeAddress)
  ) {
    throw new Error('local fork block selection is invalid');
  }
  const requested = requestedForkBlock(forkBlock);
  try {
    const expectedNumber =
      requested === undefined
        ? undefined
        : `0x${BigInt(requested.blockNumber).toString(16)}`;
    const block = observedForkBlock(
      await request({
        method: 'eth_getBlockByNumber',
        params: [expectedNumber ?? 'finalized', false],
      }),
      expectedNumber,
      requested?.blockHash,
      requested === undefined ? 'upstream-finalized' : 'explicit-pinned'
    );
    await request({
      method: 'eth_getBalance',
      params: [safeAddress, `0x${BigInt(block.blockNumber).toString(16)}`],
    });
    return block;
  } catch (error) {
    throw new Error('local fork upstream cannot serve finalized state', {
      cause: error,
    });
  }
}

export async function createLocalAnvilFork({
  forkBlock,
  forkMode = 'pinned',
  safeAddress,
  signal,
  upstreamRpcUrl,
}) {
  if (typeof safeAddress !== 'string' || !ADDRESS_PATTERN.test(safeAddress)) {
    throw new Error('local fork Safe address is invalid');
  }
  if (
    !['interactive-latest', 'pinned'].includes(forkMode) ||
    (forkMode === 'interactive-latest' && forkBlock !== undefined)
  ) {
    throw new Error('local fork mode is invalid');
  }
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new Error('local fork lifecycle is invalid');
  }
  const lifecycle = new AbortController();
  const abortFromParent = () =>
    lifecycle.abort(signal.reason ?? new Error('local fork stopped'));
  signal.addEventListener('abort', abortFromParent, { once: true });
  const detachParent = () =>
    signal.removeEventListener('abort', abortFromParent);
  try {
    await verifyAnvilRuntime();
  } catch (error) {
    detachParent();
    throw error;
  }
  if (lifecycle.signal.aborted) {
    detachParent();
    throw new Error('local fork stopped');
  }
  const upstream = upstreamUrl(upstreamRpcUrl);
  let proxy;
  try {
    proxy = await createUpstreamProxy(upstream);
    if (lifecycle.signal.aborted) {
      throw new Error('local fork stopped');
    }
  } catch (error) {
    await proxy?.close();
    detachParent();
    throw error;
  }
  let selectedForkBlock;
  try {
    const proxyRequest = createRpcRequest(proxy.origin, lifecycle.signal);
    if ((await proxyRequest({ method: 'eth_chainId' })) !== '0x6c1') {
      throw new Error('local fork upstream reported the wrong chain');
    }
    if (forkMode === 'pinned') {
      selectedForkBlock = await selectPinnedForkBlock({
        forkBlock,
        request: proxyRequest,
        safeAddress,
      });
    }
  } catch (error) {
    await proxy.close();
    detachParent();
    throw error;
  }
  const port = await availablePort();
  if (lifecycle.signal.aborted) {
    await proxy.close();
    detachParent();
    throw new Error('local fork stopped');
  }
  const childArguments = [
    '--accounts',
    '1',
    '--chain-id',
    String(CHAIN_ID),
    '--fork-url',
    proxy.origin,
  ];
  if (selectedForkBlock !== undefined) {
    childArguments.push('--fork-block-number', selectedForkBlock.blockNumber);
  }
  childArguments.push('--host', '127.0.0.1', '--port', String(port));
  const child = spawn('anvil', childArguments, {
    env: {
      PATH: process.env.PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const origin = `http://127.0.0.1:${port}`;
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error('local fork startup timed out'))),
      30_000
    );
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lifecycle.signal.removeEventListener('abort', abortStartup);
      callback();
    };
    const abortStartup = () =>
      finish(() => reject(new Error('local fork startup interrupted')));
    child.once('error', () =>
      finish(() => reject(new Error('local fork failed to start')))
    );
    child.once('exit', () =>
      finish(() => reject(new Error('local fork exited before startup')))
    );
    let startupTail = '';
    child.stdout.on('data', (chunk) => {
      startupTail = `${startupTail}${chunk.toString('utf8')}`.slice(-256);
      if (startupTail.includes('Listening on')) {
        finish(resolve);
      }
    });
    child.stderr.on('data', () => {
      // Deliberately discard Anvil output because it can contain the upstream
      // URL, which may carry a provider credential in its path.
    });
    if (lifecycle.signal.aborted) abortStartup();
    else {
      lifecycle.signal.addEventListener('abort', abortStartup, {
        once: true,
      });
    }
  });

  try {
    await ready;
    const request = createRpcRequest(origin, lifecycle.signal);
    if ((await request({ method: 'eth_chainId' })) !== '0x6c1') {
      throw new Error('local fork reported the wrong chain');
    }
    const forkBlockNumber =
      selectedForkBlock === undefined
        ? undefined
        : `0x${BigInt(selectedForkBlock.blockNumber).toString(16)}`;
    const forkBlock = observedForkBlock(
      await request({
        method: 'eth_getBlockByNumber',
        params: [forkBlockNumber ?? 'latest', false],
      }),
      forkBlockNumber,
      selectedForkBlock?.blockHash,
      selectedForkBlock?.mode ?? 'interactive-latest'
    );
    await request({
      method: 'anvil_impersonateAccount',
      params: [safeAddress],
    });
    await request({
      method: 'anvil_setBalance',
      params: [safeAddress, '0x21e19e0c9bab2400000'],
    });

    let stopPromise;
    return Object.freeze({
      forkBlock,
      origin,
      request,
      stop() {
        stopPromise ??= (async () => {
          lifecycle.abort(new Error('local fork stopped'));
          if (child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => {
              const timer = setTimeout(() => {
                child.kill('SIGKILL');
              }, 5_000);
              child.once('exit', () => {
                clearTimeout(timer);
                resolve();
              });
              child.kill('SIGTERM');
            });
          }
          await proxy.close();
          detachParent();
        })();
        return stopPromise;
      },
    });
  } catch (error) {
    lifecycle.abort(new Error('local fork stopped'));
    child.kill('SIGKILL');
    await proxy.close();
    detachParent();
    throw error;
  }
}
