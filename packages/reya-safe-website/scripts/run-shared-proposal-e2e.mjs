import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  decodeFunctionData,
  encodeFunctionResult,
  hashTypedData,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalIngress } from '../../reya-safe-ui/src/local-ingress.mjs';
import {
  createSharedProposalPreviewFixture,
  E2E_COMMIT,
  E2E_SAFE,
} from '../test-support/shared-proposal-fixture.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const UI_ORIGIN = 'http://127.0.0.1:57713';
const RPC_ORIGIN = 'http://127.0.0.1:18545';
const STAGING_ORIGIN = 'http://127.0.0.1:18084';
const SAFE = E2E_SAFE;
const COMMIT = E2E_COMMIT;
const SECRET = 'deterministic-e2e-proxy-secret-at-least-32-bytes';
const PRIVATE_KEYS = [1, 2, 3, 4, 5].map(
  (value) => `0x${value.toString(16).padStart(64, '0')}`
);
const OWNERS = PRIVATE_KEYS.map((key) =>
  privateKeyToAccount(key).address.toLowerCase()
);
const SAFE_ABI = [
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'nonce',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'safeTxGas', type: 'uint256' },
      { name: 'baseGas', type: 'uint256' },
      { name: 'gasPrice', type: 'uint256' },
      { name: 'gasToken', type: 'address' },
      { name: 'refundReceiver', type: 'address' },
      { name: '_nonce', type: 'uint256' },
    ],
    name: 'getTransactionHash',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'dataHash', type: 'bytes32' },
      { name: 'data', type: 'bytes' },
      { name: 'signatures', type: 'bytes' },
      { name: 'requiredSignatures', type: 'uint256' },
    ],
    name: 'checkNSignatures',
    outputs: [],
    stateMutability: 'view',
    type: 'function',
  },
];
const SAFE_TX_TYPES = [
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' },
  { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' },
  { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function e2eRedisUrl(value) {
  const candidate = new URL(value ?? 'redis://127.0.0.1:16379/0');
  if (
    candidate.protocol !== 'redis:' ||
    candidate.hostname !== '127.0.0.1' ||
    candidate.port !== '16379' ||
    candidate.pathname !== '/0' ||
    candidate.username !== '' ||
    candidate.password !== '' ||
    candidate.search !== '' ||
    candidate.hash !== ''
  ) {
    throw new Error(
      'REYA_E2E_REDIS_URL must be exactly redis://127.0.0.1:16379/0'
    );
  }
  return candidate.href;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...options.env },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed`));
    });
  });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > 256 * 1024) throw new Error('RPC fixture request too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function currentBlock() {
  const hash = `0x${'11'.repeat(32)}`;
  return {
    baseFeePerGas: '0x0',
    difficulty: '0x0',
    extraData: '0x',
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    hash,
    logsBloom: `0x${'0'.repeat(512)}`,
    miner: zeroAddress,
    mixHash: `0x${'22'.repeat(32)}`,
    nonce: '0x0000000000000000',
    number: '0x7b',
    parentHash: `0x${'33'.repeat(32)}`,
    receiptsRoot: `0x${'44'.repeat(32)}`,
    sha3Uncles: `0x${'55'.repeat(32)}`,
    size: '0x1',
    stateRoot: `0x${'66'.repeat(32)}`,
    timestamp: `0x${Math.floor(Date.now() / 1_000).toString(16)}`,
    totalDifficulty: '0x0',
    transactions: [],
    transactionsRoot: `0x${'77'.repeat(32)}`,
    uncles: [],
  };
}

function safeCallResult(data) {
  const decoded = decodeFunctionData({ abi: SAFE_ABI, data });
  switch (decoded.functionName) {
    case 'getOwners':
      return encodeFunctionResult({
        abi: SAFE_ABI,
        functionName: 'getOwners',
        result: OWNERS,
      });
    case 'getThreshold':
      return encodeFunctionResult({
        abi: SAFE_ABI,
        functionName: 'getThreshold',
        result: 3n,
      });
    case 'nonce':
      return encodeFunctionResult({
        abi: SAFE_ABI,
        functionName: 'nonce',
        result: 477n,
      });
    case 'getTransactionHash': {
      const [
        to,
        value,
        callData,
        operation,
        safeTxGas,
        baseGas,
        gasPrice,
        gasToken,
        refundReceiver,
        nonce,
      ] = decoded.args;
      const digest = hashTypedData({
        domain: { chainId: 1729, verifyingContract: SAFE },
        message: {
          baseGas,
          data: callData,
          gasPrice,
          gasToken,
          nonce,
          operation,
          refundReceiver,
          safeTxGas,
          to,
          value,
        },
        primaryType: 'SafeTx',
        types: { SafeTx: SAFE_TX_TYPES },
      });
      return encodeFunctionResult({
        abi: SAFE_ABI,
        functionName: 'getTransactionHash',
        result: digest,
      });
    }
    case 'checkNSignatures':
      return '0x';
    default:
      throw new Error('unsupported Safe fixture read');
  }
}

function rpcResult(method, params, observedMethods) {
  observedMethods.add(method);
  switch (method) {
    case 'eth_chainId':
      return '0x6c1';
    case 'eth_blockNumber':
      return '0x7b';
    case 'eth_getBlockByNumber':
      return currentBlock();
    case 'eth_getCode':
      return '0x6000';
    case 'eth_call': {
      const call = params[0];
      if (
        call === null ||
        typeof call !== 'object' ||
        typeof call.data !== 'string' ||
        call.to?.toLowerCase() !== SAFE
      ) {
        throw new Error('unexpected deterministic Safe call');
      }
      return safeCallResult(call.data);
    }
    default:
      throw new Error(`RPC fixture rejected ${method}`);
  }
}

async function startRpcFixture(observedMethods) {
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/') {
        response.writeHead(404).end();
        return;
      }
      const input = JSON.parse((await readBody(request)).toString('utf8'));
      const output = Buffer.from(
        JSON.stringify({
          id: input.id,
          jsonrpc: '2.0',
          result: rpcResult(input.method, input.params, observedMethods),
        })
      );
      response.writeHead(200, {
        'content-length': String(output.byteLength),
        'content-type': 'application/json',
      });
      response.end(output);
    })().catch((error) => {
      const output = Buffer.from(
        JSON.stringify({
          error: { code: -32601, message: error.message },
          id: null,
          jsonrpc: '2.0',
        })
      );
      response.writeHead(200, {
        'content-length': String(output.byteLength),
        'content-type': 'application/json',
      });
      response.end(output);
    });
  });
  await listen(server, 18545);
  return server;
}

async function startStaticWebsite() {
  const assets = new Map(
    await Promise.all(
      [
        ['/', 'index.html', 'text/html; charset=utf-8'],
        ['/index.html', 'index.html', 'text/html; charset=utf-8'],
        ['/app.js', 'app.js', 'application/javascript'],
        ['/app.css', 'app.css', 'text/css'],
      ].map(async ([route, file, contentType]) => [
        route,
        {
          body: await readFile(path.join(PACKAGE_ROOT, 'out', file)),
          contentType,
        },
      ])
    )
  );
  const server = http.createServer((request, response) => {
    const asset = request.method === 'GET' ? assets.get(request.url) : null;
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': String(asset.body.byteLength),
      'content-type': asset.contentType,
      'x-content-type-options': 'nosniff',
    });
    response.end(asset.body);
  });
  await listen(server, 57713);
  return server;
}

function sourceBundle() {
  const content = 'name = "reya-omnibus"\nversion = "1.2.3"\n';
  const files = [
    {
      content,
      path: 'packages/tomls/src/omnibus/reya_network.toml',
      sha256: sha256(content),
    },
  ];
  const canonical = {
    schemaVersion: 1,
    repository: 'Reya-Labs/reya-deployments',
    commit: COMMIT,
    root: 'packages/tomls/src/omnibus/reya_network.toml',
    files,
  };
  return { ...canonical, bundleSha256: sha256(JSON.stringify(canonical)) };
}

function previewRunner(bundleSha256, previousCid) {
  return Object.freeze({
    allowsSourceCommit: (commit) => commit === COMMIT,
    close() {},
    async run(encoded) {
      const input = JSON.parse(encoded);
      if (
        JSON.stringify(Object.keys(input)) !==
          JSON.stringify([
            'chainId',
            'commit',
            'partialDeployCid',
            'previousPackageCid',
            'safeAddress',
          ]) ||
        input.chainId !== 1729 ||
        input.commit !== COMMIT ||
        input.partialDeployCid !== null ||
        input.previousPackageCid !== previousCid ||
        input.safeAddress !== SAFE
      ) {
        throw new Error('preview fixture rejected changed input');
      }
      return createSharedProposalPreviewFixture({
        bundleSha256,
        previousPackageCid: previousCid,
      });
    },
  });
}

async function buildFixture() {
  await run('pnpm', ['--filter', '@usecannon/artifact-codec', 'build']);
  await run('pnpm', [
    '--dir',
    'packages/safe-app-backend',
    '--ignore-workspace',
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
  ]);
  await run('pnpm', [
    '--dir',
    'packages/safe-app-backend',
    '--ignore-workspace',
    'build',
  ]);
  await run('pnpm', ['--filter', '@reya/cannon-safe-website', 'build'], {
    env: {
      REYA_LOCAL_INGRESS_ORIGIN: 'http://127.0.0.1:8787',
      REYA_LOCAL_PROFILE: 'enabled',
      REYA_LOCAL_SAFE_ADDRESS: SAFE,
      REYA_LOCAL_SOURCE_COMMIT: COMMIT,
      REYA_LOCAL_STAGING: 'enabled',
    },
  });
  const { getContentCID } = await import('@usecannon/artifact-codec');
  const artifactBytes = deflateSync(
    JSON.stringify({
      chainId: 1729,
      def: {
        name: 'reya-omnibus',
        preset: 'main',
        version: '1.2.3',
      },
      meta: {},
      status: 'complete',
    })
  );
  return {
    artifactBytes,
    previousCid: await getContentCID(artifactBytes),
    source: sourceBundle(),
  };
}

const originalEnvironment = new Map();
function setBackendEnvironment(values) {
  for (const [key, value] of Object.entries(values)) {
    if (!originalEnvironment.has(key)) {
      originalEnvironment.set(key, process.env[key]);
    }
    process.env[key] = value;
  }
}

function restoreEnvironment() {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let rpcServer;
let backend;
let ingress;
let websiteServer;

try {
  const redisUrl = e2eRedisUrl(process.env.REYA_E2E_REDIS_URL);
  const fixture = await buildFixture();
  const observedRpcMethods = new Set();
  rpcServer = await startRpcFixture(observedRpcMethods);
  setBackendEnvironment({
    ADMISSION_MODE: 'safe-owner',
    AUTH_PROXY_SECRET: SECRET,
    CORS_ORIGINS: UI_ORIGIN,
    HISTORY_RETENTION_SECONDS: '3600',
    MAX_BLOCK_AGE_SECONDS: '120',
    PORT: '18084',
    PROPOSAL_TTL_SECONDS: '300',
    REDIS_MIN_REPLICAS: '0',
    REDIS_PREFIX: `safe-app-backend:e2e:${process.pid}:${Date.now()}`,
    REDIS_URL: redisUrl,
    RPC_URLS: `1729=${RPC_ORIGIN}`,
    SAFE_ALLOWLIST: `1729:${SAFE}`,
    TRUST_PROXY: 'false',
  });
  const backendModule = await import('../../safe-app-backend/dist/server.js');
  backend = await backendModule.startServer();

  const sourceBytes = Buffer.from(JSON.stringify(fixture.source));
  const fixtureFetch = async (url, init) => {
    const value = String(url);
    if (
      value ===
      `http://127.0.0.1:8082/source/reya-deployments/${COMMIT}/reya-network`
    ) {
      return new Response(sourceBytes, {
        headers: { 'content-type': 'application/json' },
        status: 200,
      });
    }
    if (
      value === `http://127.0.0.1:8083/api/v0/cat?arg=${fixture.previousCid}`
    ) {
      return new Response(fixture.artifactBytes, {
        headers: { 'content-type': 'application/octet-stream' },
        status: 200,
      });
    }
    const upstream = new URL(value);
    if (upstream.origin !== RPC_ORIGIN && upstream.origin !== STAGING_ORIGIN) {
      throw new Error(
        `E2E fixture rejected unexpected upstream ${upstream.origin}`
      );
    }
    return fetch(url, init);
  };
  ingress = await createLocalIngress(
    {
      artifactOrigin: 'http://127.0.0.1:8083',
      identity: 'deterministic-e2e-signer',
      opRpcUrl: null,
      port: 8787,
      proxySecret: SECRET,
      rpcUrl: RPC_ORIGIN,
      safeAddress: SAFE,
      sourceCommit: COMMIT,
      sourceOrigin: 'http://127.0.0.1:8082',
      stagingOrigin: STAGING_ORIGIN,
      uiOrigin: UI_ORIGIN,
    },
    {
      fetchImpl: fixtureFetch,
      previewRunner: previewRunner(
        fixture.source.bundleSha256,
        fixture.previousCid
      ),
    }
  );
  websiteServer = await startStaticWebsite();

  await run(
    'pnpm',
    [
      '--filter',
      '@usecannon/website',
      'exec',
      'cypress',
      'run',
      '--e2e',
      '--browser',
      'electron',
      '--config-file',
      path.join(PACKAGE_ROOT, 'cypress.config.cjs'),
      '--project',
      PACKAGE_ROOT,
    ],
    {
      env: {
        CYPRESS_cannonfileUrl:
          `https://github.com/Reya-Labs/reya-deployments/blob/${COMMIT}/` +
          'packages/tomls/src/omnibus/reya_network.toml',
        CYPRESS_previousCid: fixture.previousCid,
        CYPRESS_safeAddress: SAFE,
        CYPRESS_sourceCommit: COMMIT,
      },
    }
  );

  for (const forbidden of [
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_signTransaction',
  ]) {
    if (observedRpcMethods.has(forbidden)) {
      throw new Error(`E2E attempted forbidden RPC method ${forbidden}`);
    }
  }
} finally {
  await closeServer(websiteServer);
  await ingress?.close();
  await backend?.close();
  await closeServer(rpcServer);
  restoreEnvironment();
}
