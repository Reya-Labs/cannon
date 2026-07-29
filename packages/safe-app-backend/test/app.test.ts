import Redis from 'ioredis';
import request from 'supertest';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeOwnerAdmissionVerifier } from '../src/admission';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config';
import { RedisStagingStore, type RedisStorePolicy } from '../src/store';
import type { ProviderRegistry, SafeClient, SafeTransaction } from '../src/types';

const redisUrl = process.env.REDIS_URL ?? '';

const CHAIN_ID = 1729;
const SAFE = getAddress('0x1111111111111111111111111111111111111111');
const OTHER_SAFE = getAddress('0x2222222222222222222222222222222222222222');
const PRIVATE_KEYS = [
  `0x${'01'.padStart(64, '0')}`,
  `0x${'02'.padStart(64, '0')}`,
  `0x${'03'.padStart(64, '0')}`,
] as const satisfies readonly Hex[];
const OUTSIDER_PRIVATE_KEY = `0x${'04'.padStart(64, '0')}` as const satisfies Hex;
const ACCOUNTS = PRIVATE_KEYS.map(privateKeyToAccount);

class FakeSafeClient implements SafeClient {
  nonce = 7;
  nonceResponses: number[] = [];
  owners = ACCOUNTS.map(({ address }) => getAddress(address));
  blockTimestamp = BigInt(Math.floor(Date.now() / 1000));
  available = true;
  rejectSignatures = false;

  digest(txn: SafeTransaction): Hex {
    return keccak256(toHex(JSON.stringify(txn)));
  }

  async getBlock(): Promise<{ timestamp: bigint }> {
    if (!this.available) throw new Error('RPC unavailable');
    return { timestamp: this.blockTimestamp };
  }

  async getBytecode(): Promise<Hex> {
    if (!this.available) throw new Error('RPC unavailable');
    return '0x6000';
  }

  async getChainId(): Promise<number> {
    if (!this.available) throw new Error('RPC unavailable');
    return CHAIN_ID;
  }

  async readContract(parameters: Record<string, unknown>): Promise<unknown> {
    if (!this.available) throw new Error('RPC unavailable');
    switch (parameters.functionName) {
      case 'nonce':
        return BigInt(this.nonceResponses.shift() ?? this.nonce);
      case 'getOwners':
        return this.owners;
      case 'getThreshold':
        return 2n;
      case 'getTransactionHash': {
        const args = parameters.args as [Address, string, Hex, '0' | '1', string, string, string, Address, Address, number];
        return this.digest({
          _nonce: args[9],
          baseGas: args[5],
          data: args[2],
          gasPrice: args[6],
          gasToken: args[7],
          operation: args[3],
          refundReceiver: args[8],
          safeTxGas: args[4],
          to: args[0],
          value: args[1],
        });
      }
      case 'checkNSignatures':
        if (this.rejectSignatures) throw new Error('Safe rejected signatures');
        return undefined;
      default:
        throw new Error(`unexpected contract read ${String(parameters.functionName)}`);
    }
  }
}

function config(prefix: string): AppConfig {
  return {
    admissionMode: 'safe-owner',
    auditMaxLength: 10_000,
    auth: {
      identityHeader: 'x-reya-user',
      proxySecret: 'a-secure-ingress-secret-that-is-long-enough',
      proxySecretHeader: 'x-reya-proxy-secret',
      rolesHeader: 'x-reya-roles',
    },
    bodyLimit: '32kb',
    corsOrigins: new Set(['https://cannon.reya.network']),
    historyRetentionMs: 60 * 60 * 1000,
    maxBlockAgeSeconds: 120,
    maxProposalsPerNonce: 20,
    port: 8080,
    proposalTtlMs: 60_000,
    readinessCacheMs: 10,
    rateLimit: { limit: 1_000, windowMs: 60_000 },
    redisMinReplicas: 0,
    redisPrefix: prefix,
    redisUrl,
    redisWaitTimeoutMs: 10,
    rpcUrls: new Map([[CHAIN_ID, 'https://rpc.example.com']]),
    safeAllowlist: new Map([[CHAIN_ID, new Set([SAFE])]]),
    safeTargets: [{ address: SAFE, chainId: CHAIN_ID }],
    trustProxy: false,
  };
}

function storePolicy(appConfig: AppConfig): RedisStorePolicy {
  return {
    auditMaxLength: appConfig.auditMaxLength,
    historyRetentionMs: appConfig.historyRetentionMs,
    maxProposalsPerNonce: appConfig.maxProposalsPerNonce,
    minReplicas: appConfig.redisMinReplicas,
    waitTimeoutMs: appConfig.redisWaitTimeoutMs,
  };
}

function txn(overrides: Partial<SafeTransaction> = {}): SafeTransaction {
  return {
    _nonce: 7,
    baseGas: '0',
    data: '0x',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    operation: '0',
    refundReceiver: SAFE,
    safeTxGas: '0',
    to: OTHER_SAFE,
    value: '0',
    ...overrides,
  };
}

async function signature(transaction: SafeTransaction, accountIndex: number, client: FakeSafeClient): Promise<Hex> {
  return sign({
    hash: client.digest(transaction),
    privateKey: PRIVATE_KEYS[accountIndex],
    to: 'hex',
  });
}

function auth(roles: string, subject = 'owner@example.com') {
  return {
    'x-reya-proxy-secret': 'a-secure-ingress-secret-that-is-long-enough',
    'x-reya-roles': roles,
    'x-reya-user': subject,
  };
}

describe.skipIf(!redisUrl)('safe staging API', () => {
  let client: FakeSafeClient;
  let now: number;
  let primaryRedis: Redis;
  let replicaRedis: Redis;
  let primaryStore: RedisStagingStore;
  let replicaStore: RedisStagingStore;
  let primaryApp: ReturnType<typeof createApp>;
  let replicaApp: ReturnType<typeof createApp>;
  let testConfig: AppConfig;
  let testPrefix: string;

  beforeEach(async () => {
    client = new FakeSafeClient();
    now = Date.now();
    testPrefix = `test:${crypto.randomUUID()}`;
    testConfig = config(testPrefix);
    const providers: ProviderRegistry = new Map([[CHAIN_ID, client]]);
    primaryRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    replicaRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    primaryStore = new RedisStagingStore(primaryRedis, testConfig.redisPrefix, storePolicy(testConfig));
    replicaStore = new RedisStagingStore(replicaRedis, testConfig.redisPrefix, storePolicy(testConfig));
    await Promise.all([primaryStore.ping(), replicaStore.ping()]);
    primaryApp = createApp({
      admissionVerifier: new SafeOwnerAdmissionVerifier(),
      config: testConfig,
      now: () => now,
      providers,
      store: primaryStore,
    });
    replicaApp = createApp({
      admissionVerifier: new SafeOwnerAdmissionVerifier(),
      config: testConfig,
      now: () => now,
      providers,
      store: replicaStore,
    });
  });

  afterEach(async () => {
    await Promise.allSettled([primaryStore.disconnect(), replicaStore.disconnect()]);
  });

  it('separates liveness from dependency-aware readiness', async () => {
    const expectedHealth = {
      status: 'ok',
      version: process.env.BUILD_REVISION ?? 'unknown',
    };
    await request(primaryApp).get('/livez').expect(200, expectedHealth);
    await request(primaryApp).get('/readyz').expect(200, expectedHealth);

    client.available = false;
    now += testConfig.readinessCacheMs + 1;
    await request(primaryApp).get('/livez').expect(200, expectedHealth);
    const response = await request(primaryApp).get('/readyz').expect(503);
    expect(response.body).toEqual({
      error: { code: 'not_ready', message: 'a required dependency is not ready' },
    });
  });

  it('requires trusted-proxy identity and a configured origin', async () => {
    await request(primaryApp).get(`/${CHAIN_ID}/${SAFE}`).expect(401);
    await request(primaryApp).post(`/${CHAIN_ID}/${SAFE}`).send({}).expect(401);
    await request(primaryApp)
      .get(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .set('origin', 'https://evil.example')
      .expect(403);
    await request(primaryApp).get(`/${CHAIN_ID}/${OTHER_SAFE}`).set(auth('signer')).expect(404);
    await request(primaryApp).post(`/1/${SAFE}`).set(auth('proposer')).send({}).expect(404);
    await request(primaryApp).post(`/${CHAIN_ID}/${OTHER_SAFE}`).set(auth('proposer')).send({}).expect(404);
  });

  it('rejects zero signatures and lets only proposers create current-nonce proposals', async () => {
    const transaction = txn();
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [], txn: transaction })
      .expect(400);

    const signed = await signature(transaction, 0, client);
    const signerOnly = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: [signed], txn: transaction })
      .expect(403);
    expect(signerOnly.body.error.code).toBe('proposer_role_required');

    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [signed], txn: transaction })
      .expect(201);

    const createdAuditEntry = (await primaryRedis.xrange(`${testPrefix}:audit`, '-', '+')).find(([, fields]) => {
      const eventIndex = fields.indexOf('event');
      return eventIndex >= 0 && fields[eventIndex + 1] === 'proposal.created';
    });
    expect(createdAuditEntry).toBeDefined();
    const createdFields = createdAuditEntry![1];
    const audit = new Map<string, string>();
    for (let index = 0; index < createdFields.length; index += 2) {
      audit.set(createdFields[index], createdFields[index + 1]);
    }
    expect(audit.get('actor')).toBe('owner@example.com');
    expect(audit.get('chainId')).toBe(String(CHAIN_ID));
    expect(audit.get('safe')).toBe(SAFE);
    expect(audit.get('nonce')).toBe(String(transaction._nonce));
    expect(audit.get('safeTxHash')).toBe(client.digest(transaction));
  });

  it('atomically unions concurrent signer submissions across independent replicas', async () => {
    const transaction = txn();
    const signatures = await Promise.all([0, 1, 2].map((index) => signature(transaction, index, client)));

    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer', 'proposer@example.com'))
      .send({ sigs: [signatures[0]], txn: transaction })
      .expect(201);

    await Promise.all([
      request(primaryApp)
        .post(`/${CHAIN_ID}/${SAFE}`)
        .set(auth('signer', 'owner-2@example.com'))
        .send({ sigs: [signatures[1]], txn: transaction })
        .expect(200),
      request(replicaApp)
        .post(`/${CHAIN_ID}/${SAFE}`)
        .set(auth('signer', 'owner-3@example.com'))
        .send({ sigs: [signatures[2]], txn: transaction })
        .expect(200),
    ]);

    const response = await request(replicaApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].sigs).toHaveLength(3);

    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: [signatures[1]], txn: transaction })
      .expect(200);
    const replayed = await request(primaryApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
    expect(replayed.body[0].sigs).toHaveLength(3);

    const freshRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const freshStore = new RedisStagingStore(freshRedis, testPrefix, storePolicy(testConfig));
    const freshApp = createApp({
      admissionVerifier: new SafeOwnerAdmissionVerifier(),
      config: config(testPrefix),
      providers: new Map([[CHAIN_ID, client]]),
      store: freshStore,
    });
    try {
      const restored = await request(freshApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
      expect(restored.body[0].sigs).toHaveLength(3);
    } finally {
      await freshStore.disconnect();
    }

    const auditEntries = await primaryRedis.xrange(`${testPrefix}:audit`, '-', '+');
    const auditEvents = auditEntries.map(([, fields]) => fields[fields.indexOf('event') + 1]);
    expect(auditEvents).toContain('proposal.created');
    const signatureAuditEntries = auditEntries.filter(([, fields]) => {
      const eventIndex = fields.indexOf('event');
      return eventIndex >= 0 && fields[eventIndex + 1] === 'signature.added';
    });
    expect(signatureAuditEntries).toHaveLength(3);
    for (const [, fields] of signatureAuditEntries) {
      const safeTxHashIndex = fields.indexOf('safeTxHash');
      expect(safeTxHashIndex).toBeGreaterThanOrEqual(0);
      expect(fields[safeTxHashIndex + 1]).toBe(client.digest(transaction));
    }
  });

  it('rejects same-nonce conflicts, non-owner signatures and unsupported Safe signature encodings', async () => {
    const first = txn();
    const firstSignature = await signature(first, 0, client);
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [firstSignature], txn: first })
      .expect(201);

    const conflicting = txn({ value: '1' });
    const conflictingSignature = await signature(conflicting, 1, client);
    const conflict = await request(replicaApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [conflictingSignature], txn: conflicting })
      .expect(409);
    expect(conflict.body.error.code).toBe('nonce_conflict');

    const malformed = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: ['0x12'], txn: first })
      .expect(400);
    expect(malformed.body.error.code).toBe('invalid_request');

    const outsiderSignature = await sign({
      hash: client.digest(first),
      privateKey: OUTSIDER_PRIVATE_KEY,
      to: 'hex',
    });
    const outsider = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: [outsiderSignature], txn: first })
      .expect(400);
    expect(outsider.body.error.code).toBe('non_owner_signature');

    const unsupportedBytes = Buffer.from(firstSignature.slice(2), 'hex');
    unsupportedBytes[64] = 31;
    const unsupported = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: [`0x${unsupportedBytes.toString('hex')}`], txn: first })
      .expect(400);
    expect(unsupported.body.error.code).toBe('unsupported_signature_type');

    client.rejectSignatures = true;
    const safeRejected = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('signer'))
      .send({ sigs: [firstSignature], txn: first })
      .expect(400);
    expect(safeRejected.body.error.code).toBe('invalid_signature');
  });

  it('filters removed-owner signatures and never depends on process memory', async () => {
    const transaction = txn();
    const signatures = await Promise.all([0, 1].map((index) => signature(transaction, index, client)));
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: signatures, txn: transaction })
      .expect(201);

    client.owners = [ACCOUNTS[0].address];
    const response = await request(replicaApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
    expect(response.body[0].sigs).toEqual([signatures[0]]);
  });

  it('reconciles nonce advances and permits only the new current nonce', async () => {
    const original = txn();
    const originalSignature = await signature(original, 0, client);
    const future = txn({ _nonce: 8 });
    const futureSignature = await signature(future, 0, client);
    const futureResponse = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [futureSignature], txn: future })
      .expect(409);
    expect(futureResponse.body.error.code).toBe('stale_or_future_nonce');

    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(201);

    client.nonce = 8;
    const reconciled = await request(replicaApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
    expect(reconciled.body).toEqual([]);

    const stale = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(409);
    expect(stale.body.error.code).toBe('stale_or_future_nonce');

    const current = txn({ _nonce: 8 });
    const currentSignature = await signature(current, 1, client);
    await request(replicaApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [currentSignature], txn: current })
      .expect(201);

    client.nonce = 7;
    const regression = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(503);
    expect(regression.body.error.code).toBe('safe_nonce_regression');
  });

  it('audits supersession, tombstones old payloads and permits a different replacement', async () => {
    const original = txn();
    const originalSignature = await signature(original, 0, client);
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(201);

    const expectedDigest = client.digest(original);
    const supersedeBody = { expectedDigest, reason: 'Reviewed replacement required' };
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}/supersede`)
      .set(auth('operator'))
      .set('x-idempotency-key', 'supersede-original-0001')
      .send(supersedeBody)
      .expect(200);
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}/supersede`)
      .set(auth('operator'))
      .set('x-idempotency-key', 'supersede-original-0001')
      .send(supersedeBody)
      .expect(200);

    const tombstoned = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(409);
    expect(tombstoned.body.error.code).toBe('proposal_tombstoned');

    const replacement = txn({ data: '0x1234' });
    const replacementSignature = await signature(replacement, 1, client);
    await request(replicaApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [replacementSignature], txn: replacement })
      .expect(201);

    const delayed = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}/supersede`)
      .set(auth('operator'))
      .set('x-idempotency-key', 'supersede-delayed-0002')
      .send(supersedeBody)
      .expect(409);
    expect(delayed.body.error.code).toBe('supersede_conflict');
  });

  it('reclassifies a superseded proposal if the Safe nonce advances during the transition', async () => {
    const original = txn();
    const originalSignature = await signature(original, 0, client);
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [originalSignature], txn: original })
      .expect(201);

    const digest = client.digest(original);
    client.nonceResponses = [7, 8];
    const response = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}/supersede`)
      .set(auth('operator'))
      .set('x-idempotency-key', 'supersede-nonce-race-0001')
      .send({ expectedDigest: digest, reason: 'Reviewed replacement required' })
      .expect(409);
    expect(response.body.error).toMatchObject({
      code: 'safe_nonce_advanced',
      details: { currentNonce: 8, proposedNonce: 7 },
    });

    const proposalKey = `${testPrefix}:proposal:${CHAIN_ID}:${SAFE.toLowerCase()}:${digest.toLowerCase()}`;
    expect(await primaryRedis.hget(proposalKey, 'status')).toBe('stale');

    // Simulate a crash/failure before the first request durably reclassified the terminal record.
    await primaryRedis.hset(proposalKey, 'status', 'superseded');
    client.nonce = 8;
    const retry = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}/supersede`)
      .set(auth('operator'))
      .set('x-idempotency-key', 'supersede-nonce-race-0001')
      .send({ expectedDigest: digest, reason: 'Reviewed replacement required' })
      .expect(409);
    expect(retry.body.error).toMatchObject({
      code: 'safe_nonce_advanced',
      details: { currentNonce: 8, proposedNonce: 7 },
    });
    expect(await primaryRedis.hget(proposalKey, 'status')).toBe('stale');
  });

  it('expires active proposals atomically and rejects unverified attestations in safe-owner mode', async () => {
    testConfig.proposalTtlMs = 10;
    const transaction = txn();
    const signed = await signature(transaction, 0, client);
    await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [signed], txn: transaction })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const expired = await request(replicaApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(200);
    expect(expired.body).toEqual([]);

    const safeOwnerApp = createApp({
      admissionVerifier: new SafeOwnerAdmissionVerifier(),
      config: config(`test:${crypto.randomUUID()}`),
      providers: new Map([[CHAIN_ID, client]]),
      store: primaryStore,
    });
    const rejected = await request(safeOwnerApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({
        attestation: { format: 'test', payload: 'not-verified', signature: 'not-verified' },
        sigs: [signed],
        txn: transaction,
      })
      .expect(400);
    expect(rejected.body.error.code).toBe('safe_owner_attestation_unsupported');
  });

  it('bounds distinct proposal replacements for one Safe nonce', async () => {
    const boundedPrefix = `test:${crypto.randomUUID()}`;
    const boundedConfig = config(boundedPrefix);
    const boundedRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const boundedStore = new RedisStagingStore(boundedRedis, boundedPrefix, {
      ...storePolicy(boundedConfig),
      maxProposalsPerNonce: 2,
    });
    const boundedApp = createApp({
      admissionVerifier: new SafeOwnerAdmissionVerifier(),
      config: boundedConfig,
      providers: new Map([[CHAIN_ID, client]]),
      store: boundedStore,
    });

    try {
      for (const [index, data] of ['0x01', '0x02'].entries()) {
        const transaction = txn({ data: data as Hex });
        const signed = await signature(transaction, index, client);
        await request(boundedApp)
          .post(`/${CHAIN_ID}/${SAFE}`)
          .set(auth('proposer'))
          .send({ sigs: [signed], txn: transaction })
          .expect(201);
        await request(boundedApp)
          .post(`/${CHAIN_ID}/${SAFE}/supersede`)
          .set(auth('operator'))
          .set('x-idempotency-key', `bounded-supersede-000${index}`)
          .send({
            expectedDigest: client.digest(transaction),
            reason: 'Reviewed replacement required',
          })
          .expect(200);
      }

      const rejected = txn({ data: '0x03' });
      const rejectedSignature = await signature(rejected, 2, client);
      const response = await request(boundedApp)
        .post(`/${CHAIN_ID}/${SAFE}`)
        .set(auth('proposer'))
        .send({ sigs: [rejectedSignature], txn: rejected })
        .expect(429);
      expect(response.body.error.code).toBe('proposal_quota_exceeded');
    } finally {
      await boundedStore.disconnect();
    }
  });

  it('returns 503 instead of acknowledging or serving process-local state when Redis fails', async () => {
    await primaryStore.disconnect();
    const response = await request(primaryApp).get(`/${CHAIN_ID}/${SAFE}`).set(auth('signer')).expect(503);
    expect(response.body.error.code).toBe('persistence_unavailable');
  });

  it('does not acknowledge an unreplicated mutation and permits an idempotent recovery retry', async () => {
    const durabilityPrefix = `test:${crypto.randomUUID()}`;
    const strictRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const recoveryRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const strictStore = new RedisStagingStore(strictRedis, durabilityPrefix, {
      ...storePolicy(testConfig),
      minReplicas: 1,
      waitTimeoutMs: 10,
    });
    const recoveryStore = new RedisStagingStore(recoveryRedis, durabilityPrefix, storePolicy(testConfig));
    const transaction = txn();
    const signed = await signature(transaction, 0, client);
    const input = {
      actor: { roles: new Set<'proposer'>(['proposer']), subject: 'proposer@example.com' },
      admissionId: 'safe-owner-durability-test',
      canCreate: true,
      chainId: CHAIN_ID,
      digest: client.digest(transaction),
      proposalTtlMs: testConfig.proposalTtlMs,
      requestId: crypto.randomUUID(),
      safeAddress: SAFE,
      signatures: [{ owner: ACCOUNTS[0].address, signature: signed }],
      txn: transaction,
    };

    try {
      await recoveryStore.reconcileCurrentNonce(CHAIN_ID, SAFE, client.nonce);
      await expect(strictStore.mergeProposal(input)).rejects.toMatchObject({
        code: 'persistence_unavailable',
        status: 503,
      });
      await expect(recoveryStore.mergeProposal(input)).resolves.toEqual({ added: 0, created: false });
      await expect(recoveryStore.getActive(CHAIN_ID, SAFE, client.nonce)).resolves.toMatchObject({
        digest: input.digest,
        status: 'active',
      });
    } finally {
      await strictStore.disconnect();
      await recoveryStore.disconnect();
    }
  });

  it('fails before mutation when a Redis key has an invalid type', async () => {
    await primaryRedis.set(`${testPrefix}:audit`, 'corrupt');
    const transaction = txn();
    const signed = await signature(transaction, 0, client);
    const response = await request(primaryApp)
      .post(`/${CHAIN_ID}/${SAFE}`)
      .set(auth('proposer'))
      .send({ sigs: [signed], txn: transaction })
      .expect(503);
    expect(response.body.error.code).toBe('persistence_corrupt');
    expect(await primaryRedis.exists(`${testPrefix}:active:${CHAIN_ID}:${SAFE.toLowerCase()}:7`)).toBe(0);
  });
});
