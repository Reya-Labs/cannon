import { createHash } from 'node:crypto';
import { SOURCE_ROOT } from '../src/simulator/source.mjs';

export const SOURCE_ORIGIN = 'http://source.reya-ops.svc.cluster.local:8080';
export const ARTIFACT_ORIGIN =
  'http://artifacts.reya-ops.svc.cluster.local:8080';
export const RPC_URL = 'https://rpc.example.invalid/v1/token';
export const OP_RPC_URL = 'https://op.example.invalid/v1/token';
export const MAINNET_RPC_URL = 'https://eth.example.invalid/v1/token';
export const SAFE_ADDRESS = '0x1fe50318e5e3165742edc9c4a15d997bdb935eb9';
export const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';
export const PREVIOUS_CID = 'QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o';
export const PARTIAL_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
export const OTHER_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdH';

export function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Builds a source bundle whose digests are internally consistent, so a test
 * that wants an integrity failure has to introduce one deliberately.
 */
export function sourceBundle({ commit = COMMIT, files } = {}) {
  const contents = files ?? [
    { content: 'name = "reya-omnibus"\n', path: SOURCE_ROOT },
  ];
  const hashed = contents
    .map(({ content, path }) => ({
      content,
      path,
      sha256: sha256(content),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const canonical = {
    schemaVersion: 1,
    repository: 'Reya-Labs/reya-deployments',
    commit,
    root: SOURCE_ROOT,
    files: hashed,
  };
  return {
    bundleSha256: sha256(JSON.stringify(canonical)),
    commit,
    files: hashed,
    repository: 'Reya-Labs/reya-deployments',
    root: SOURCE_ROOT,
    schemaVersion: 1,
  };
}

export function jsonResponse(value, overrides = {}) {
  return textResponse(JSON.stringify(value), 'application/json', overrides);
}

export function textResponse(body, contentType, overrides = {}) {
  const bytes =
    typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    body: streamOf(bytes),
    headers: new Headers({
      'content-length': String(bytes.byteLength),
      'content-type': contentType,
      ...(overrides.headers ?? {}),
    }),
    ok: true,
    redirected: false,
    status: 200,
    ...overrides,
  };
}

export function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * A `fetch` stand-in that answers from a routing table and records every call,
 * so a test can assert on what was requested as well as what came back.
 */
export function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ options, url: String(url) });
    // Real `fetch` refuses an aborted signal, so the stub must too — otherwise
    // a deadline that is never honoured would still look like a passing test.
    if (options.signal?.aborted) {
      throw Object.assign(new Error('This operation was aborted'), {
        name: 'AbortError',
      });
    }
    const response = await handler(String(url), options, calls.length - 1);
    if (response === undefined) {
      throw new Error(`unexpected request: ${String(url)}`);
    }
    return response;
  };
  impl.calls = calls;
  return impl;
}

/** A deployment artifact shaped like the ones the artifact facade serves. */
export function deploymentArtifact({
  commitHash = COMMIT,
  def = { name: 'reya-omnibus', preset: 'main', version: '1.0.158' },
  status = 'complete',
} = {}) {
  return {
    chainId: 1729,
    def,
    generator: 'cannon test',
    meta: {
      commitHash,
      gitUrl: 'https://github.com/Reya-Labs/reya-deployments',
    },
    miscUrl: `ipfs://${OTHER_CID}`,
    options: {},
    state: {},
    status,
  };
}

/**
 * A minimal engine capability. Every member is replaceable so a test can make
 * exactly one of them misbehave.
 */
export function stubEngine(overrides = {}) {
  const artifacts = new Map();
  return {
    assembleDefinition: (bundle) => ({
      name: 'reya-omnibus',
      root: bundle.root,
      version: '1.0.159',
    }),
    createArtifactLoader: ({ readArtifact }) => ({
      async read(url) {
        const cid = url.slice('ipfs://'.length);
        const bytes = await readArtifact(cid);
        return JSON.parse(new TextDecoder().decode(bytes));
      },
    }),
    createEphemeralOverlay: ({ allowedCids, baseLoader }) => ({
      allowedCids,
      loader: {
        async put(value) {
          const encoded = JSON.stringify(value);
          const cid = `Qm${sha256(encoded).slice(0, 44)}`;
          artifacts.set(cid, encoded);
          allowedCids.add(cid);
          return `ipfs://${cid}`;
        },
        async read(url) {
          const cid = url.slice('ipfs://'.length);
          if (artifacts.has(cid)) return JSON.parse(artifacts.get(cid));
          return baseLoader.read(url);
        },
      },
    }),
    getContentCid: async () => PREVIOUS_CID,
    runReadOnlyPreview: async ({
      commit,
      partialDeployCid,
      previousPackageCid,
      safeAddress,
    }) => ({
      cannon: { stateFormatVersion: 7, version: '2.26.1' },
      chainId: 1729,
      commit,
      deployerAddress: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      deployerPrerequisites: [],
      deployerStartingNonce: '3',
      partialDeployCid,
      previousPackageCid,
      safeAddress,
      safeProposalCalls: [
        {
          data: '0x1234',
          from: safeAddress,
          gasUsed: '21000',
          senderRole: 'safe',
          to: '0x2222222222222222222222222222222222222222',
          value: '0',
        },
      ],
      schemaVersion: 4,
      simulationTransactions: [{ sequence: 0 }],
      type: 'reya-cannon-read-only-preview',
    }),
    ...overrides,
  };
}

/** A fork stand-in with no Anvil process behind it. */
export function stubFork(overrides = {}) {
  const stopped = { count: 0 };
  const fork = {
    forkBlock: {
      blockHash: `0x${'a'.repeat(64)}`,
      blockNumber: '19000000',
    },
    prunedState: false,
    request: async () => '0x',
    stop: async () => {
      stopped.count += 1;
    },
    ...overrides,
  };
  fork.stopped = stopped;
  return fork;
}
