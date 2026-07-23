import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { Address, Hex } from 'viem';
import { HttpError } from './errors';
import type { Actor, SafeTransaction, StoredProposal, VerifiedSignature } from './types';

const MERGE_PROPOSAL_SCRIPT = `
local function keyType(key)
  return redis.call('TYPE', key)['ok']
end
local function validType(key, expected)
  local actual = keyType(key)
  return actual == 'none' or actual == expected
end
if not validType(KEYS[1], 'hash')
  or not validType(KEYS[2], 'hash')
  or not validType(KEYS[3], 'hash')
  or not validType(KEYS[4], 'stream')
  or not validType(KEYS[5], 'zset')
  or not validType(KEYS[6], 'string')
  or not validType(KEYS[7], 'string') then
  return {'corrupt_type'}
end

local fence = redis.call('GET', KEYS[6])
if not fence or tonumber(fence) ~= tonumber(ARGV[3]) then
  return {'nonce_fence', fence or ''}
end

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local activeDigest = redis.call('HGET', KEYS[1], 'digest')
if activeDigest then
  local activeExpiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
  if activeExpiresAt <= now then
    local expiredProposalKey = redis.call('HGET', KEYS[1], 'proposalKey')
    local expiredSignatureKey = redis.call('HGET', KEYS[1], 'signatureKey')
    if not expiredProposalKey
      or not expiredSignatureKey
      or redis.call('EXISTS', expiredProposalKey) ~= 1
      or redis.call('EXISTS', expiredSignatureKey) ~= 1
      or not validType(expiredProposalKey, 'hash')
      or not validType(expiredSignatureKey, 'hash') then
      return {'corrupt_record'}
    end
    redis.call('HSET', expiredProposalKey, 'status', 'expired', 'updatedAt', now)
    redis.call('PEXPIRE', expiredProposalKey, ARGV[13])
    redis.call('PEXPIRE', expiredSignatureKey, ARGV[13])
    redis.call('PEXPIRE', KEYS[7], ARGV[13])
    redis.call(
      'XADD',
      KEYS[4],
      'MAXLEN',
      '~',
      ARGV[15],
      '*',
      'event',
      'proposal.expired',
      'digest',
      activeDigest,
      'chainId',
      ARGV[11],
      'safe',
      ARGV[12],
      'nonce',
      ARGV[3],
      'actor',
      'system'
    )
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[5], ARGV[3])
    activeDigest = false
  end
end

if activeDigest and activeDigest ~= ARGV[1] then
  return {'conflict', activeDigest}
end

if activeDigest then
  if redis.call('EXISTS', KEYS[2]) ~= 1 or redis.call('EXISTS', KEYS[3]) ~= 1 then
    return {'corrupt_record'}
  end
  local storedAdmissionId = redis.call('HGET', KEYS[2], 'admissionId')
  if storedAdmissionId ~= ARGV[9] then
    return {'admission_conflict', storedAdmissionId or ''}
  end
elseif redis.call('EXISTS', KEYS[2]) == 1 then
  return {'proposal_tombstoned', redis.call('HGET', KEYS[2], 'status') or ''}
end

local signatureCount = tonumber(ARGV[10])
for i = 1, signatureCount do
  local offset = 15 + ((i - 1) * 2)
  local owner = ARGV[offset + 1]
  local submitted = ARGV[offset + 2]
  local existing = redis.call('HGET', KEYS[3], owner)
  if existing and existing ~= submitted then
    return {'owner_conflict', owner}
  end
end

local created = 0
if not activeDigest then
  if ARGV[5] ~= '1' then
    return {'forbidden_create', ''}
  end
  local proposalCount = tonumber(redis.call('GET', KEYS[7]) or '0')
  if proposalCount >= tonumber(ARGV[14]) then
    return {'proposal_quota', tostring(proposalCount)}
  end

  local expiresAt = now + tonumber(ARGV[4])
  redis.call(
    'HSET',
    KEYS[1],
    'digest',
    ARGV[1],
    'expiresAt',
    expiresAt,
    'proposalKey',
    KEYS[2],
    'signatureKey',
    KEYS[3]
  )
  redis.call(
    'HSET',
    KEYS[2],
    'admissionId',
    ARGV[9],
    'createdAt',
    now,
    'digest',
    ARGV[1],
    'expiresAt',
    expiresAt,
    'nonce',
    ARGV[3],
    'status',
    'active',
    'txn',
    ARGV[2],
    'updatedAt',
    now
  )
  redis.call('ZADD', KEYS[5], ARGV[3], ARGV[3])
  redis.call('INCR', KEYS[7])
  redis.call('PEXPIRE', KEYS[7], ARGV[13])
  redis.call(
    'XADD',
    KEYS[4],
    'MAXLEN',
    '~',
    ARGV[15],
    '*',
    'event',
    'proposal.created',
    'digest',
    ARGV[1],
    'chainId',
    ARGV[11],
    'safe',
    ARGV[12],
    'nonce',
    ARGV[3],
    'actor',
    ARGV[6],
    'roles',
    ARGV[7],
    'requestId',
    ARGV[8],
    'admissionId',
    ARGV[9]
  )
  created = 1
end

local added = 0
for i = 1, signatureCount do
  local offset = 15 + ((i - 1) * 2)
  local owner = ARGV[offset + 1]
  local submitted = ARGV[offset + 2]
  if redis.call('HSETNX', KEYS[3], owner, submitted) == 1 then
    added = added + 1
    redis.call(
      'XADD',
      KEYS[4],
      'MAXLEN',
      '~',
      ARGV[15],
      '*',
      'event',
      'signature.added',
      'digest',
      ARGV[1],
      'chainId',
      ARGV[11],
      'safe',
      ARGV[12],
      'nonce',
      ARGV[3],
      'signer',
      owner,
      'actor',
      ARGV[6],
      'roles',
      ARGV[7],
      'requestId',
      ARGV[8]
    )
  end
end

redis.call('HSET', KEYS[2], 'updatedAt', now)
redis.call('PEXPIRE', KEYS[7], ARGV[13])
return {'ok', tostring(created), tostring(added)}
`;

const GET_ACTIVE_SCRIPT = `
local function keyType(key)
  return redis.call('TYPE', key)['ok']
end
local function validType(key, expected)
  local actual = keyType(key)
  return actual == 'none' or actual == expected
end
if not validType(KEYS[1], 'hash')
  or not validType(KEYS[2], 'stream')
  or not validType(KEYS[3], 'zset')
  or not validType(KEYS[4], 'string')
  or not validType(KEYS[5], 'string') then
  return {'corrupt_type'}
end

local fence = redis.call('GET', KEYS[4])
if not fence or tonumber(fence) ~= tonumber(ARGV[1]) then
  return {'nonce_fence', fence or ''}
end

local digest = redis.call('HGET', KEYS[1], 'digest')
if not digest then
  return {'missing'}
end

local proposalKey = redis.call('HGET', KEYS[1], 'proposalKey')
local signatureKey = redis.call('HGET', KEYS[1], 'signatureKey')
if not proposalKey
  or not signatureKey
  or redis.call('EXISTS', proposalKey) ~= 1
  or redis.call('EXISTS', signatureKey) ~= 1
  or not validType(proposalKey, 'hash')
  or not validType(signatureKey, 'hash') then
  return {'corrupt_record'}
end

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
if expiresAt <= now then
  redis.call('HSET', proposalKey, 'status', 'expired', 'updatedAt', now)
  redis.call('PEXPIRE', proposalKey, ARGV[4])
  redis.call('PEXPIRE', signatureKey, ARGV[4])
  redis.call('PEXPIRE', KEYS[5], ARGV[4])
  redis.call(
    'XADD',
    KEYS[2],
    'MAXLEN',
    '~',
    ARGV[5],
    '*',
    'event',
    'proposal.expired',
    'digest',
    digest,
    'chainId',
    ARGV[2],
    'safe',
    ARGV[3],
    'nonce',
    ARGV[1],
    'actor',
    'system'
  )
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  return {'expired'}
end

local admissionId = redis.call('HGET', proposalKey, 'admissionId')
local createdAt = redis.call('HGET', proposalKey, 'createdAt')
local status = redis.call('HGET', proposalKey, 'status')
local txn = redis.call('HGET', proposalKey, 'txn')
local updatedAt = redis.call('HGET', proposalKey, 'updatedAt')
if not admissionId or not createdAt or status ~= 'active' or not txn or not updatedAt then
  return {'corrupt_record'}
end

local response = {'ok', digest, admissionId, createdAt, tostring(expiresAt), txn, updatedAt}
local signatures = redis.call('HGETALL', signatureKey)
for _, value in ipairs(signatures) do
  table.insert(response, value)
end
return response
`;

const SUPERSEDE_SCRIPT = `
local function keyType(key)
  return redis.call('TYPE', key)['ok']
end
local function validType(key, expected)
  local actual = keyType(key)
  return actual == 'none' or actual == expected
end
if not validType(KEYS[1], 'hash')
  or not validType(KEYS[2], 'stream')
  or not validType(KEYS[3], 'zset')
  or not validType(KEYS[4], 'hash')
  or not validType(KEYS[5], 'hash')
  or not validType(KEYS[6], 'string')
  or not validType(KEYS[7], 'hash')
  or not validType(KEYS[8], 'string') then
  return {'corrupt_type'}
end

local replayDigest = redis.call('HGET', KEYS[7], 'digest')
if replayDigest then
  if replayDigest ~= ARGV[8] then
    return {'idempotency_conflict', replayDigest}
  end
  local replayOutcome = redis.call('HGET', KEYS[7], 'outcome')
  local replayNonce = redis.call('HGET', KEYS[7], 'nonce')
  if not replayOutcome or not replayNonce then
    return {'corrupt_record'}
  end
  if replayOutcome == 'ok' and tonumber(replayNonce) ~= tonumber(ARGV[1]) then
    return {'stale_replay', replayDigest, replayNonce}
  end
  return {replayOutcome, replayDigest, 'replayed'}
end

local fence = redis.call('GET', KEYS[6])
if not fence or tonumber(fence) ~= tonumber(ARGV[1]) then
  return {'nonce_fence', fence or ''}
end

local digest = redis.call('HGET', KEYS[1], 'digest')
if not digest then
  return {'missing', ''}
end
if digest ~= ARGV[8] then
  return {'conflict', digest}
end
if redis.call('EXISTS', KEYS[4]) ~= 1 or redis.call('EXISTS', KEYS[5]) ~= 1 then
  return {'corrupt_record'}
end

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local expiresAt = tonumber(redis.call('HGET', KEYS[1], 'expiresAt') or '0')
local outcome = 'ok'
local event = 'proposal.superseded'
if expiresAt <= now then
  outcome = 'expired'
  event = 'proposal.expired'
end

redis.call('HSET', KEYS[4], 'status', outcome == 'ok' and 'superseded' or 'expired', 'updatedAt', now)
redis.call('PEXPIRE', KEYS[4], ARGV[9])
redis.call('PEXPIRE', KEYS[5], ARGV[9])
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HSET', KEYS[7], 'digest', digest, 'outcome', outcome, 'nonce', ARGV[1])
redis.call('PEXPIRE', KEYS[7], ARGV[9])
redis.call('PEXPIRE', KEYS[8], ARGV[9])

if outcome == 'ok' then
  redis.call(
    'XADD',
    KEYS[2],
    'MAXLEN',
    '~',
    ARGV[10],
    '*',
    'event',
    event,
    'digest',
    digest,
    'chainId',
    ARGV[2],
    'safe',
    ARGV[3],
    'nonce',
    ARGV[1],
    'actor',
    ARGV[4],
    'roles',
    ARGV[5],
    'requestId',
    ARGV[6],
    'reason',
    ARGV[7]
  )
else
  redis.call(
    'XADD',
    KEYS[2],
    'MAXLEN',
    '~',
    ARGV[10],
    '*',
    'event',
    event,
    'digest',
    digest,
    'chainId',
    ARGV[2],
    'safe',
    ARGV[3],
    'nonce',
    ARGV[1],
    'actor',
    'system'
  )
end
return {outcome, digest, 'created'}
`;

const RECONCILE_NONCE_SCRIPT = `
local function keyType(key)
  return redis.call('TYPE', key)['ok']
end
local function validType(key, expected)
  local actual = keyType(key)
  return actual == 'none' or actual == expected
end
if not validType(KEYS[1], 'zset')
  or not validType(KEYS[2], 'stream')
  or not validType(KEYS[3], 'string') then
  return {'corrupt_type'}
end

local fence = redis.call('GET', KEYS[3])
if fence and tonumber(ARGV[2]) < tonumber(fence) then
  return {'nonce_regression', fence}
end

local staleNonces = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[2])
local items = {}
for _, nonce in ipairs(staleNonces) do
  local activeKey = ARGV[1] .. nonce
  if not validType(activeKey, 'hash') then
    return {'corrupt_type'}
  end
  local digest = redis.call('HGET', activeKey, 'digest')
  local proposalKey = redis.call('HGET', activeKey, 'proposalKey')
  local signatureKey = redis.call('HGET', activeKey, 'signatureKey')
  local proposalCountKey = ARGV[7] .. nonce
  if digest and (not proposalKey
    or not signatureKey
    or not validType(proposalCountKey, 'string')
    or redis.call('EXISTS', proposalKey) ~= 1
    or redis.call('EXISTS', signatureKey) ~= 1
    or not validType(proposalKey, 'hash')
    or not validType(signatureKey, 'hash')) then
    return {'corrupt_record'}
  end
  table.insert(items, {nonce, activeKey, digest, proposalKey, signatureKey, proposalCountKey})
end

local advanced = '0'
if not fence or tonumber(ARGV[2]) > tonumber(fence) then
  redis.call('SET', KEYS[3], ARGV[2])
  advanced = '1'
end

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local transitioned = 0
for _, item in ipairs(items) do
  local nonce = item[1]
  local activeKey = item[2]
  local digest = item[3]
  local proposalKey = item[4]
  local signatureKey = item[5]
  local proposalCountKey = item[6]
  if digest then
    local expiresAt = tonumber(redis.call('HGET', activeKey, 'expiresAt') or '0')
    local status = expiresAt <= now and 'expired' or 'stale'
    redis.call('HSET', proposalKey, 'status', status, 'updatedAt', now)
    redis.call('PEXPIRE', proposalKey, ARGV[5])
    redis.call('PEXPIRE', signatureKey, ARGV[5])
    redis.call('PEXPIRE', proposalCountKey, ARGV[5])
    redis.call(
      'XADD',
      KEYS[2],
      'MAXLEN',
      '~',
      ARGV[6],
      '*',
      'event',
      'proposal.' .. status,
      'digest',
      digest,
      'chainId',
      ARGV[3],
      'safe',
      ARGV[4],
      'nonce',
      nonce,
      'actor',
      'system'
    )
    redis.call('DEL', activeKey)
    transitioned = transitioned + 1
  end
  redis.call('ZREM', KEYS[1], nonce)
end
return {'ok', tostring(transitioned), advanced}
`;

const RECLASSIFY_SUPERSEDED_SCRIPT = `
local function keyType(key)
  return redis.call('TYPE', key)['ok']
end
local function validType(key, expected)
  local actual = keyType(key)
  return actual == 'none' or actual == expected
end
if not validType(KEYS[1], 'hash')
  or not validType(KEYS[2], 'stream')
  or not validType(KEYS[3], 'string') then
  return {'corrupt_type'}
end
if redis.call('EXISTS', KEYS[1]) ~= 1 then
  return {'corrupt_record'}
end
if tonumber(ARGV[5]) <= tonumber(ARGV[4]) then
  return {'invalid_advance'}
end

local fence = redis.call('GET', KEYS[3])
if fence and tonumber(ARGV[5]) < tonumber(fence) then
  return {'nonce_regression', fence}
end

local status = redis.call('HGET', KEYS[1], 'status')
if status == 'stale' then
  if not fence or tonumber(ARGV[5]) > tonumber(fence) then
    redis.call('SET', KEYS[3], ARGV[5])
  end
  return {'ok', 'replayed'}
end
if status ~= 'superseded' then
  return {'conflict', status or ''}
end

local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
if not fence or tonumber(ARGV[5]) > tonumber(fence) then
  redis.call('SET', KEYS[3], ARGV[5])
end
redis.call('HSET', KEYS[1], 'status', 'stale', 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call(
  'XADD',
  KEYS[2],
  'MAXLEN',
  '~',
  ARGV[7],
  '*',
  'event',
  'proposal.stale',
  'digest',
  ARGV[1],
  'chainId',
  ARGV[2],
  'safe',
  ARGV[3],
  'nonce',
  ARGV[4],
  'currentNonce',
  ARGV[5],
  'actor',
  'system',
  'reason',
  'nonce_advanced_after_supersede'
)
return {'ok', 'created'}
`;

export type RedisStorePolicy = {
  auditMaxLength: number;
  historyRetentionMs: number;
  maxProposalsPerNonce: number;
  minReplicas: number;
  waitTimeoutMs: number;
};

type MergeProposalInput = {
  actor: Actor;
  admissionId: string;
  canCreate: boolean;
  chainId: number;
  digest: Hex;
  proposalTtlMs: number;
  requestId: string;
  safeAddress: Address;
  signatures: VerifiedSignature[];
  txn: SafeTransaction;
};

function persistenceError(error: unknown): HttpError {
  return new HttpError(503, 'persistence_unavailable', 'durable proposal storage is unavailable', {
    cause: error instanceof Error ? error.message : String(error),
  });
}

export class RedisStagingStore {
  private readonly policy: RedisStorePolicy;
  private readonly prefix: string;
  private readonly redis: Redis;

  constructor(redis: Redis, prefix: string, policy: RedisStorePolicy) {
    this.redis = redis;
    this.prefix = prefix;
    this.policy = policy;
  }

  private safeKey(chainId: number, safeAddress: Address): string {
    return `${chainId}:${safeAddress.toLowerCase()}`;
  }

  private activeKey(safeKey: string, nonce: number): string {
    return `${this.prefix}:active:${safeKey}:${nonce}`;
  }

  private proposalKey(safeKey: string, digest: Hex): string {
    return `${this.prefix}:proposal:${safeKey}:${digest.toLowerCase()}`;
  }

  private signatureKey(safeKey: string, digest: Hex): string {
    return `${this.prefix}:signatures:${safeKey}:${digest.toLowerCase()}`;
  }

  private activeNonceIndexKey(safeKey: string): string {
    return `${this.prefix}:active-nonces:${safeKey}`;
  }

  private nonceFenceKey(safeKey: string): string {
    return `${this.prefix}:nonce-fence:${safeKey}`;
  }

  private proposalCountKey(safeKey: string, nonce: number): string {
    return `${this.prefix}:proposal-count:${safeKey}:${nonce}`;
  }

  private supersedeIdempotencyKey(safeKey: string, idempotencyKey: string): string {
    return `${this.prefix}:idempotency:supersede:${safeKey}:${idempotencyKey}`;
  }

  private auditKey(): string {
    return `${this.prefix}:audit`;
  }

  private durabilityMarkerKey(): string {
    return `${this.prefix}:durability-marker`;
  }

  private async eval(script: string, keys: string[], args: Array<string | number>): Promise<string[]> {
    try {
      if (this.policy.minReplicas === 0) {
        return (await this.redis.eval(script, keys.length, ...keys, ...args.map(String))) as string[];
      }

      const replies = await this.redis
        .pipeline()
        .eval(script, keys.length, ...keys, ...args.map(String))
        .set(this.durabilityMarkerKey(), randomUUID(), 'PX', 60_000)
        .call('WAIT', String(this.policy.minReplicas), String(this.policy.waitTimeoutMs))
        .exec();
      if (!replies || replies.length !== 3) throw new Error('Redis durability pipeline returned no result');
      for (const [error] of replies) {
        if (error) throw error;
      }
      const acknowledged = Number(replies[2][1]);
      if (acknowledged < this.policy.minReplicas) {
        throw new Error(`only ${acknowledged} Redis replicas acknowledged the write`);
      }
      return replies[0][1] as string[];
    } catch (error) {
      throw persistenceError(error);
    }
  }

  private async waitForDurability(): Promise<void> {
    if (this.policy.minReplicas === 0) return;
    try {
      const replies = await this.redis
        .pipeline()
        .set(this.durabilityMarkerKey(), randomUUID(), 'PX', 60_000)
        .call('WAIT', String(this.policy.minReplicas), String(this.policy.waitTimeoutMs))
        .exec();
      if (!replies || replies.length !== 2) throw new Error('Redis durability barrier returned no result');
      for (const [error] of replies) {
        if (error) throw error;
      }
      const acknowledged = Number(replies[1][1]);
      if (acknowledged < this.policy.minReplicas) {
        throw new Error(`only ${acknowledged} Redis replicas acknowledged the write`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw persistenceError(error);
    }
  }

  private protocolError(): HttpError {
    return new HttpError(503, 'persistence_protocol_error', 'durable proposal storage returned an unknown result');
  }

  async ping(): Promise<void> {
    try {
      if ((await this.redis.ping()) !== 'PONG') throw new Error('unexpected Redis ping response');
      await this.waitForDurability();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw persistenceError(error);
    }
  }

  async mergeProposal(input: MergeProposalInput): Promise<{ added: number; created: boolean }> {
    const safeKey = this.safeKey(input.chainId, input.safeAddress);
    const result = await this.eval(
      MERGE_PROPOSAL_SCRIPT,
      [
        this.activeKey(safeKey, input.txn._nonce),
        this.proposalKey(safeKey, input.digest),
        this.signatureKey(safeKey, input.digest),
        this.auditKey(),
        this.activeNonceIndexKey(safeKey),
        this.nonceFenceKey(safeKey),
        this.proposalCountKey(safeKey, input.txn._nonce),
      ],
      [
        input.digest,
        JSON.stringify(input.txn),
        input.txn._nonce,
        input.proposalTtlMs,
        input.canCreate ? 1 : 0,
        input.actor.subject,
        Array.from(input.actor.roles).sort().join(','),
        input.requestId,
        input.admissionId,
        input.signatures.length,
        input.chainId,
        input.safeAddress,
        this.policy.historyRetentionMs,
        this.policy.maxProposalsPerNonce,
        this.policy.auditMaxLength,
        ...input.signatures.flatMap(({ owner, signature }) => [owner.toLowerCase(), signature]),
      ]
    );

    switch (result[0]) {
      case 'ok':
        return { added: Number.parseInt(result[2], 10), created: result[1] === '1' };
      case 'conflict':
        throw new HttpError(409, 'nonce_conflict', 'a different proposal is already active at the current nonce', {
          activeDigest: result[1],
        });
      case 'admission_conflict':
        throw new HttpError(
          409,
          'admission_conflict',
          'the active transaction hash is already bound to a different admission'
        );
      case 'forbidden_create':
        throw new HttpError(403, 'proposer_role_required', 'the proposer role is required to create a proposal');
      case 'proposal_tombstoned':
        throw new HttpError(409, 'proposal_tombstoned', `this proposal is immutable and already ${result[1] || 'inactive'}`);
      case 'owner_conflict':
        throw new HttpError(409, 'owner_signature_conflict', `owner ${result[1]} already has a different signature`);
      case 'proposal_quota':
        throw new HttpError(429, 'proposal_quota_exceeded', 'proposal replacement quota is exhausted for this Safe nonce');
      case 'nonce_fence':
        throw new HttpError(409, 'safe_nonce_changed', 'the persisted Safe nonce changed while the proposal was validated');
      case 'corrupt_type':
      case 'corrupt_record':
        throw new HttpError(503, 'persistence_corrupt', 'durable proposal storage contains an invalid key type');
      default:
        throw this.protocolError();
    }
  }

  async getActive(chainId: number, safeAddress: Address, nonce: number): Promise<StoredProposal | null> {
    const safeKey = this.safeKey(chainId, safeAddress);
    const result = await this.eval(
      GET_ACTIVE_SCRIPT,
      [
        this.activeKey(safeKey, nonce),
        this.auditKey(),
        this.activeNonceIndexKey(safeKey),
        this.nonceFenceKey(safeKey),
        this.proposalCountKey(safeKey, nonce),
      ],
      [nonce, chainId, safeAddress, this.policy.historyRetentionMs, this.policy.auditMaxLength]
    );

    switch (result[0]) {
      case 'missing':
        return null;
      case 'expired':
        return null;
      case 'nonce_fence':
        throw new HttpError(409, 'safe_nonce_changed', 'the persisted Safe nonce changed while the proposal was read');
      case 'corrupt_type':
      case 'corrupt_record':
        throw new HttpError(503, 'persistence_corrupt', 'the active proposal record is incomplete or corrupt');
      case 'ok':
        break;
      default:
        throw this.protocolError();
    }

    const signatures: Hex[] = [];
    for (let index = 7; index < result.length; index += 2) {
      if (!result[index + 1]) {
        throw new HttpError(503, 'persistence_corrupt', 'the active proposal signature record is corrupt');
      }
      signatures.push(result[index + 1] as Hex);
    }

    try {
      return {
        admissionId: result[2],
        createdAt: Number.parseInt(result[3], 10),
        digest: result[1] as Hex,
        expiresAt: Number.parseInt(result[4], 10),
        sigs: signatures,
        status: 'active',
        txn: JSON.parse(result[5]) as SafeTransaction,
        updatedAt: Number.parseInt(result[6], 10),
      };
    } catch (error) {
      throw new HttpError(503, 'persistence_corrupt', 'the active proposal record is incomplete or corrupt', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async supersede(input: {
    actor: Actor;
    chainId: number;
    expectedDigest: Hex;
    idempotencyKey: string;
    nonce: number;
    reason: string;
    requestId: string;
    safeAddress: Address;
  }): Promise<{ digest: Hex; originalNonce: number }> {
    const safeKey = this.safeKey(input.chainId, input.safeAddress);
    const result = await this.eval(
      SUPERSEDE_SCRIPT,
      [
        this.activeKey(safeKey, input.nonce),
        this.auditKey(),
        this.activeNonceIndexKey(safeKey),
        this.proposalKey(safeKey, input.expectedDigest),
        this.signatureKey(safeKey, input.expectedDigest),
        this.nonceFenceKey(safeKey),
        this.supersedeIdempotencyKey(safeKey, input.idempotencyKey),
        this.proposalCountKey(safeKey, input.nonce),
      ],
      [
        input.nonce,
        input.chainId,
        input.safeAddress,
        input.actor.subject,
        Array.from(input.actor.roles).sort().join(','),
        input.requestId,
        input.reason,
        input.expectedDigest,
        this.policy.historyRetentionMs,
        this.policy.auditMaxLength,
      ]
    );

    switch (result[0]) {
      case 'ok':
        return { digest: result[1] as Hex, originalNonce: input.nonce };
      case 'stale_replay':
        return { digest: result[1] as Hex, originalNonce: Number.parseInt(result[2], 10) };
      case 'expired':
        throw new HttpError(409, 'proposal_expired', 'the proposal expired before it could be superseded');
      case 'missing':
        throw new HttpError(404, 'proposal_not_found', 'no active proposal exists');
      case 'conflict':
        throw new HttpError(409, 'supersede_conflict', 'the active proposal does not match expectedDigest', {
          activeDigest: result[1],
        });
      case 'idempotency_conflict':
        throw new HttpError(409, 'idempotency_conflict', 'this idempotency key is already bound to another digest');
      case 'nonce_fence':
        throw new HttpError(409, 'safe_nonce_changed', 'the persisted Safe nonce changed before supersession');
      case 'corrupt_type':
      case 'corrupt_record':
        throw new HttpError(503, 'persistence_corrupt', 'durable proposal storage contains an invalid record');
      default:
        throw this.protocolError();
    }
  }

  async reconcileCurrentNonce(chainId: number, safeAddress: Address, currentNonce: number): Promise<number> {
    const safeKey = this.safeKey(chainId, safeAddress);
    const result = await this.eval(
      RECONCILE_NONCE_SCRIPT,
      [this.activeNonceIndexKey(safeKey), this.auditKey(), this.nonceFenceKey(safeKey)],
      [
        `${this.prefix}:active:${safeKey}:`,
        currentNonce,
        chainId,
        safeAddress,
        this.policy.historyRetentionMs,
        this.policy.auditMaxLength,
        `${this.prefix}:proposal-count:${safeKey}:`,
      ]
    );

    switch (result[0]) {
      case 'ok':
        return Number.parseInt(result[1], 10);
      case 'nonce_regression':
        throw new HttpError(
          503,
          'safe_nonce_regression',
          'the RPC reported a Safe nonce below the persisted high-water mark'
        );
      case 'corrupt_type':
      case 'corrupt_record':
        throw new HttpError(503, 'persistence_corrupt', 'durable proposal storage contains an invalid key type');
      default:
        throw this.protocolError();
    }
  }

  async reclassifySupersededAsStale(
    chainId: number,
    safeAddress: Address,
    nonce: number,
    currentNonce: number,
    digest: Hex
  ): Promise<void> {
    const safeKey = this.safeKey(chainId, safeAddress);
    const result = await this.eval(
      RECLASSIFY_SUPERSEDED_SCRIPT,
      [this.proposalKey(safeKey, digest), this.auditKey(), this.nonceFenceKey(safeKey)],
      [digest, chainId, safeAddress, nonce, currentNonce, this.policy.historyRetentionMs, this.policy.auditMaxLength]
    );
    switch (result[0]) {
      case 'ok':
        return;
      case 'nonce_regression':
        throw new HttpError(
          503,
          'safe_nonce_regression',
          'the RPC reported a Safe nonce below the persisted high-water mark'
        );
      case 'invalid_advance':
        throw new HttpError(503, 'persistence_protocol_error', 'stale reclassification requires an advanced nonce');
      case 'conflict':
        throw new HttpError(409, 'proposal_state_changed', `proposal is already ${result[1] || 'unknown'}`);
      case 'corrupt_type':
      case 'corrupt_record':
        throw new HttpError(503, 'persistence_corrupt', 'durable proposal storage contains an invalid record');
      default:
        throw this.protocolError();
    }
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  forceDisconnect(): void {
    this.redis.disconnect();
  }
}
