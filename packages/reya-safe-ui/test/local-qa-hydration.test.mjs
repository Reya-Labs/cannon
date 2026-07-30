import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compress } from '@usecannon/artifact-codec';
import {
  collectArtifactClosure,
  computeArtifactCid,
  discoverBaselineImportCids,
  hydrateArtifact,
  parseDeploymentArtifact,
  validateArtifactOrigin,
} from '../scripts/hydrate-local-qa-artifacts.mjs';

const CIDS = Object.freeze({
  baseline: 'QmaXwNU4gdBwgx4nZDV7qsPCG2GQXhyKqvxWEQoiF7CmZN',
  baselineMisc: 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn',
  blueprint: 'QmNtBYSTjBuuhkGiptYswAumhUSPPtt1uZJcDPMq16ZLCo',
  blueprintMisc: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
  importA: 'QmWxfNr1v3axczV2CRVZKFeE32yg8Hu4pDzg3dGMeZFhdf',
  importAMisc: 'Qmf5mKSS6zsThJAhgQPm3k1NFRXpKeQnjxoD6a2GRF37m8',
  importB: 'QmW4j1nV8LTk75hRdKP9e3dMSWr8oK4xhjp62nGyETHREj',
  importBMisc: 'QmdC14m9ysVQNyztkYStXkbXHumqkWaBTBi5BVvG54JN8w',
  nestedImport: 'QmWATRTVayY5YceSHtUDRDVBLEHr5ZXry26vBCcYozYLrc',
  nestedMisc: 'QmXauq3nfZigz93X8YVZsVfVv7e9AQkV8jpwqKEg9vuuo3',
  partial: 'QmRBigSTWzxDodgwMDHaXoaDJ3b1DoV7nwKPdFECMwGYZi',
  partialMisc: 'QmeSt2mnJKE8qmRhLyYbHQQxDKpsFbcWnw5e7JF4xVbN6k',
});

async function uniqueCids(count) {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      computeArtifactCid(new TextEncoder().encode(`bounded-artifact-${index}`))
    )
  );
}

test('accepts only explicit credential-free artifact origins', () => {
  assert.equal(
    validateArtifactOrigin('https://repo.usecannon.com'),
    'https://repo.usecannon.com'
  );
  assert.equal(
    validateArtifactOrigin('http://127.0.0.1:8080'),
    'http://127.0.0.1:8080'
  );
  for (const value of [
    undefined,
    '',
    'http://repo.usecannon.com',
    'https://token@repo.usecannon.com',
    'https://repo.usecannon.com/api',
    'https://repo.usecannon.com?token=secret',
  ]) {
    assert.throws(
      () => validateArtifactOrigin(value),
      /artifact origin|origin is required/
    );
  }
});

test('hydrates raw bytes at cacheDir/CID and verifies downloaded and cached data', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-hydration-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const bytes = new TextEncoder().encode('local QA artifact');
  const cid = await computeArtifactCid(bytes);
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream' },
      status: 200,
    });
  };

  assert.deepEqual(
    await hydrateArtifact({
      cacheDir: temporary,
      cid,
      fetchImpl,
      origin: 'https://artifacts.example',
    }),
    bytes
  );
  assert.deepEqual(
    new Uint8Array(await readFile(path.join(temporary, cid))),
    bytes
  );
  assert.equal(requests, 1);

  await hydrateArtifact({
    cacheDir: temporary,
    cid,
    fetchImpl: async () => {
      throw new Error('cache miss');
    },
    origin: 'https://artifacts.example',
  });
  assert.equal(requests, 1);

  await writeFile(path.join(temporary, cid), 'corrupted');
  await assert.rejects(
    () =>
      hydrateArtifact({
        cacheDir: temporary,
        cid,
        fetchImpl,
        origin: 'https://artifacts.example',
      }),
    /cached artifact .* failed CID verification/
  );
});

test('rejects a downloaded artifact whose bytes do not match the requested CID', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-cid-mismatch-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const expected = new TextEncoder().encode('expected');
  const cid = await computeArtifactCid(expected);

  await assert.rejects(
    () =>
      hydrateArtifact({
        cacheDir: temporary,
        cid,
        fetchImpl: async () =>
          new Response(new TextEncoder().encode('wrong'), {
            headers: { 'content-type': 'application/octet-stream' },
            status: 200,
          }),
        origin: 'https://artifacts.example',
      }),
    /failed CID verification/
  );
  await assert.rejects(() => readFile(path.join(temporary, cid)), {
    code: 'ENOENT',
  });
});

test('rejects a response over its remaining aggregate budget before writing it', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-byte-budget-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const bytes = new TextEncoder().encode('five');
  const cid = await computeArtifactCid(bytes);

  await assert.rejects(
    () =>
      hydrateArtifact({
        cacheDir: temporary,
        cid,
        fetchImpl: async () =>
          new Response(bytes, {
            headers: { 'content-type': 'application/octet-stream' },
            status: 200,
          }),
        maximumBytes: bytes.byteLength - 1,
        origin: 'https://artifacts.example',
      }),
    /exceeds the byte limit/
  );
  await assert.rejects(() => readFile(path.join(temporary, cid)), {
    code: 'ENOENT',
  });
});

test('cancels an unread artifact response when header validation fails', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-cancel-response-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const bytes = new TextEncoder().encode('cancel unread response');
  const cid = await computeArtifactCid(bytes);
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(bytes);
    },
  });

  await assert.rejects(
    () =>
      hydrateArtifact({
        cacheDir: temporary,
        cid,
        fetchImpl: async () =>
          new Response(body, {
            headers: { 'content-type': 'text/plain' },
            status: 200,
          }),
        origin: 'https://artifacts.example',
      }),
    /request was rejected/
  );
  assert.equal(cancelled, true);
});

test('rejects a symlink cache root and cached artifact', async (context) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), 'reya-local-qa-symlink-')
  );
  context.after(() => rm(temporary, { force: true, recursive: true }));
  const bytes = new TextEncoder().encode('local QA symlink artifact');
  const cid = await computeArtifactCid(bytes);
  const rootLink = path.join(temporary, 'cache-link');
  await symlink(temporary, rootLink);
  for (const cacheDir of [rootLink, `${rootLink}${path.sep}`]) {
    await assert.rejects(
      () =>
        hydrateArtifact({
          cacheDir,
          cid,
          fetchImpl: async () => {
            throw new Error('must not fetch');
          },
          origin: 'https://artifacts.example',
        }),
      /cache directory is invalid/
    );
  }

  const artifactTarget = path.join(temporary, 'artifact-target');
  await writeFile(artifactTarget, bytes);
  await symlink(artifactTarget, path.join(temporary, cid));
  await assert.rejects(
    () =>
      hydrateArtifact({
        cacheDir: temporary,
        cid,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
        origin: 'https://artifacts.example',
      }),
    /cached artifact file is invalid/
  );
});

test('bounds inflated deployment bytes before parsing JSON', () => {
  const encoded = compress(
    JSON.stringify({
      chainId: 1729,
      padding: 'a'.repeat(512),
      status: 'complete',
    })
  );
  assert.throws(
    () => parseDeploymentArtifact(encoded, CIDS.baseline, 128),
    /exceeds the JSON byte limit/
  );
});

test('recursively hydrates prior baseline imports and every deployment miscUrl', async () => {
  const deployments = new Map([
    [
      CIDS.baseline,
      {
        chainId: 1729,
        miscUrl: `ipfs://${CIDS.baselineMisc}`,
        status: 'complete',
        state: {
          first: {
            artifacts: { imports: { a: { url: `ipfs://${CIDS.importA}` } } },
          },
          second: [{ url: `ipfs://${CIDS.importB}` }],
        },
      },
    ],
    [
      CIDS.blueprint,
      {
        chainId: 13370,
        miscUrl: `ipfs://${CIDS.blueprintMisc}`,
        status: 'complete',
        state: {},
      },
    ],
    [
      CIDS.importA,
      {
        chainId: 1729,
        miscUrl: `ipfs://${CIDS.importAMisc}`,
        status: 'complete',
        state: {
          nested: { url: `ipfs://${CIDS.nestedImport}` },
        },
      },
    ],
    [
      CIDS.importB,
      {
        chainId: 13370,
        miscUrl: `ipfs://${CIDS.importBMisc}`,
        status: 'complete',
        state: {},
      },
    ],
    [
      CIDS.nestedImport,
      {
        chainId: 1729,
        miscUrl: `ipfs://${CIDS.nestedMisc}`,
        status: 'complete',
        state: {},
      },
    ],
    [
      CIDS.partial,
      {
        chainId: 1729,
        miscUrl: `ipfs://${CIDS.partialMisc}`,
        status: 'partial',
        state: {
          inherited: { url: `ipfs://${CIDS.importA}` },
        },
      },
    ],
  ]);
  const reads = [];
  const artifacts = await collectArtifactClosure({
    baselineCid: CIDS.baseline,
    blueprintCids: [CIDS.blueprint],
    partialDeployCids: [CIDS.partial],
    decodeDeployment(_bytes, cid) {
      const deployment = deployments.get(cid);
      assert.ok(deployment, `unexpected deployment decode for ${cid}`);
      return deployment;
    },
    async readArtifact(cid) {
      reads.push(cid);
      return new Uint8Array([cid.charCodeAt(2)]);
    },
  });

  assert.deepEqual(
    new Set(artifacts.map(({ cid }) => cid)),
    new Set(Object.values(CIDS))
  );
  assert.equal(reads.includes(CIDS.importA), true);
  assert.equal(reads.includes(CIDS.importB), true);
  assert.equal(reads.includes(CIDS.nestedImport), true);
  assert.deepEqual(
    artifacts.find(({ cid }) => cid === CIDS.nestedImport).roles,
    ['baseline-import-deploy-1729', 'partial-import-deploy-1729']
  );
  assert.deepEqual(artifacts.find(({ cid }) => cid === CIDS.importB).roles, [
    'baseline-import-deploy-13370',
  ]);
  assert.deepEqual(artifacts.find(({ cid }) => cid === CIDS.nestedMisc).roles, [
    'deployment-misc',
  ]);
  assert.deepEqual(artifacts.find(({ cid }) => cid === CIDS.partial).roles, [
    'partial-deploy',
  ]);
});

test('baseline import discovery rejects cycles and has deterministic ordering', () => {
  assert.deepEqual(
    discoverBaselineImportCids({
      z: `ipfs://${CIDS.importB}`,
      a: [`ipfs://${CIDS.importA}`, `ipfs://${CIDS.importA}`],
    }),
    [CIDS.importA, CIDS.importB].sort()
  );
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => discoverBaselineImportCids(cyclic),
    /baseline state contains a cycle/
  );
});

test('rejects a prior baseline import from the wrong chain', async () => {
  await assert.rejects(
    () =>
      collectArtifactClosure({
        baselineCid: CIDS.baseline,
        blueprintCids: [],
        decodeDeployment(_bytes, cid) {
          if (cid === CIDS.baseline) {
            return {
              chainId: 1729,
              miscUrl: `ipfs://${CIDS.baselineMisc}`,
              state: { import: `ipfs://${CIDS.importA}` },
              status: 'complete',
            };
          }
          return {
            chainId: 10,
            miscUrl: `ipfs://${CIDS.importAMisc}`,
            state: {},
            status: 'complete',
          };
        },
        async readArtifact() {
          return new Uint8Array([1]);
        },
      }),
    /baseline-import-deploy .* is not an allowed-chain complete deployment/
  );
});

test('rejects a partial root that is complete or has the wrong chain', async () => {
  for (const deployment of [
    {
      chainId: 1729,
      miscUrl: `ipfs://${CIDS.partialMisc}`,
      state: {},
      status: 'complete',
    },
    {
      chainId: 13370,
      miscUrl: `ipfs://${CIDS.partialMisc}`,
      state: {},
      status: 'partial',
    },
  ]) {
    await assert.rejects(
      () =>
        collectArtifactClosure({
          baselineCid: CIDS.baseline,
          blueprintCids: [],
          decodeDeployment(_bytes, cid) {
            if (cid === CIDS.baseline) {
              return {
                chainId: 1729,
                miscUrl: `ipfs://${CIDS.baselineMisc}`,
                state: {},
                status: 'complete',
              };
            }
            return deployment;
          },
          partialDeployCids: [CIDS.partial],
          async readArtifact() {
            return new Uint8Array([1]);
          },
        }),
      /partial-deploy .* is not an allowed-chain partial deployment/
    );
  }
});

test('rejects more than 512 unique artifacts before reading the excess artifact', async () => {
  const cids = await uniqueCids(513);
  let reads = 0;
  await assert.rejects(
    () =>
      collectArtifactClosure({
        baselineCid: cids[0],
        blueprintCids: cids.slice(1, 512),
        decodeDeployment() {
          return {
            chainId: 1729,
            miscUrl: `ipfs://${cids[512]}`,
            state: {},
            status: 'complete',
          };
        },
        async readArtifact() {
          reads += 1;
          return new Uint8Array([1]);
        },
      }),
    /unique artifact limit/
  );
  assert.equal(reads, 1);
});

test('rejects a closure over 512 MiB and passes a shrinking pre-write budget', async () => {
  const cids = await uniqueCids(11);
  const bytes = new Uint8Array(50 * 1024 * 1024);
  const observedBudgets = [];
  await assert.rejects(
    () =>
      collectArtifactClosure({
        baselineCid: cids[0],
        blueprintCids: cids.slice(1),
        decodeDeployment(_bytes, cid, role) {
          return {
            chainId: role === 'baseline-deploy' ? 1729 : 13370,
            miscUrl: `ipfs://${cid}`,
            state: {},
            status: 'complete',
          };
        },
        async readArtifact(_cid, { maximumBytes }) {
          observedBudgets.push(maximumBytes);
          return bytes;
        },
      }),
    /aggregate byte limit/
  );
  assert.deepEqual(
    observedBudgets.slice(0, 10),
    Array(10).fill(bytes.byteLength)
  );
  assert.equal(observedBudgets[10], 12 * 1024 * 1024);
});
