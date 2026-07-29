import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  concat,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  stringToHex,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createReyaSafeSigningClient,
  REYA_CHAIN_ID,
  ReyaReadClientError,
  SAFE_TX_TYPES,
} from '../src/clients/index.mjs';
import { SAFE_ADDRESS } from '../test-support/client-fixtures.mjs';

const OWNER = privateKeyToAccount(
  `0x${'01'.padStart(64, '0')}`
);
const OTHER_OWNER = privateKeyToAccount(
  `0x${'02'.padStart(64, '0')}`
);
const TRANSACTION = Object.freeze({
  _nonce: 7,
  baseGas: '11',
  data: '0x1234',
  gasPrice: '13',
  gasToken: '0x0000000000000000000000000000000000000000',
  operation: '1',
  refundReceiver: SAFE_ADDRESS,
  safeTxGas: '17',
  to: '0x2222222222222222222222222222222222222222',
  value: '19',
});
const SAFE_TX_TYPE =
  'SafeTx(address to,uint256 value,bytes data,uint8 operation,' +
  'uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,' +
  'address refundReceiver,uint256 nonce)';
const DOMAIN_TYPE =
  'EIP712Domain(uint256 chainId,address verifyingContract)';

function assertClientError(code) {
  return (error) => {
    assert.ok(error instanceof ReyaReadClientError);
    assert.equal(error.code, code);
    return true;
  };
}

function signingClient(signTypedData, overrides = {}) {
  return createReyaSafeSigningClient({
    safeAddress: SAFE_ADDRESS,
    signTypedData,
    ...overrides,
  });
}

function independentSafeHash(txn) {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(stringToHex(DOMAIN_TYPE)),
        BigInt(REYA_CHAIN_ID),
        SAFE_ADDRESS,
      ]
    )
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        keccak256(stringToHex(SAFE_TX_TYPE)),
        txn.to,
        BigInt(txn.value),
        keccak256(txn.data),
        Number(txn.operation),
        BigInt(txn.safeTxGas),
        BigInt(txn.baseGas),
        BigInt(txn.gasPrice),
        txn.gasToken,
        txn.refundReceiver,
        BigInt(txn._nonce),
      ]
    )
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

test('prepares the exact immutable Safe EIP-712 payload and independently verified hash', () => {
  let walletCalls = 0;
  const client = signingClient(async () => {
    walletCalls += 1;
    throw new Error('must not sign during preparation');
  });
  const mutable = { ...TRANSACTION };
  const prepared = client.prepare({ txn: mutable });
  mutable.data = '0xdead';

  assert.equal(client.chainId, REYA_CHAIN_ID);
  assert.equal(client.safeAddress, SAFE_ADDRESS);
  assert.equal(prepared.safeTxHash, independentSafeHash(TRANSACTION));
  assert.deepEqual(prepared.txn, TRANSACTION);
  assert.equal(prepared.typedData.domain.chainId, REYA_CHAIN_ID);
  assert.equal(
    prepared.typedData.domain.verifyingContract,
    SAFE_ADDRESS
  );
  assert.equal(prepared.typedData.primaryType, 'SafeTx');
  assert.deepEqual(prepared.typedData.types.SafeTx, SAFE_TX_TYPES);
  assert.deepEqual(prepared.typedData.message, {
    baseGas: 11n,
    data: '0x1234',
    gasPrice: 13n,
    gasToken: '0x0000000000000000000000000000000000000000',
    nonce: 7n,
    operation: 1,
    refundReceiver: SAFE_ADDRESS,
    safeTxGas: 17n,
    to: '0x2222222222222222222222222222222222222222',
    value: 19n,
  });
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.txn));
  assert.ok(Object.isFrozen(prepared.typedData));
  assert.ok(Object.isFrozen(prepared.typedData.domain));
  assert.ok(Object.isFrozen(prepared.typedData.message));
  assert.ok(Object.isFrozen(prepared.typedData.types));
  assert.ok(Object.isFrozen(SAFE_TX_TYPES));
  assert.ok(SAFE_TX_TYPES.every(Object.isFrozen));
  assert.equal(walletCalls, 0);
});

test('signs only a prepared payload and binds the recovered owner and hash', async () => {
  const walletRequests = [];
  const client = signingClient(async (request) => {
    walletRequests.push(request);
    const { account, ...typedData } = request;
    assert.equal(account, OWNER.address.toLowerCase());
    return OWNER.signTypedData(typedData);
  });
  const prepared = client.prepare({ txn: TRANSACTION });

  const result = await client.sign({
    ownerAddress: OWNER.address.toLowerCase(),
    prepared,
  });

  assert.equal(result.safeTxHash, prepared.safeTxHash);
  assert.match(result.signature, /^0x[0-9a-f]{128}(?:1b|1c)$/);
  assert.equal(result.signer, OWNER.address.toLowerCase());
  assert.ok(Object.isFrozen(result));
  assert.equal(walletRequests.length, 1);
  assert.deepEqual(Object.keys(walletRequests[0]), [
    'account',
    'domain',
    'message',
    'primaryType',
    'types',
  ]);
  assert.equal('chain' in walletRequests[0], false);
});

test('normalizes wallet recovery IDs 0 and 1 to the backend EOA signature contract', async () => {
  const client = signingClient(async (request) => {
    const { account: _account, ...typedData } = request;
    const signature = await OWNER.signTypedData(typedData);
    const bytes = hexToBytes(signature);
    assert.ok(bytes[64] === 27 || bytes[64] === 28);
    bytes[64] -= 27;
    return toHex(bytes);
  });
  const prepared = client.prepare({ txn: TRANSACTION });

  const result = await client.sign({
    ownerAddress: OWNER.address.toLowerCase(),
    prepared,
  });

  assert.match(result.signature, /^0x[0-9a-f]{128}(?:1b|1c)$/);
});

test('rejects a wallet signature recovered to a different owner', async () => {
  const client = signingClient(async (request) => {
    const { account: _account, ...typedData } = request;
    return OTHER_OWNER.signTypedData(typedData);
  });
  const prepared = client.prepare({ txn: TRANSACTION });

  await assert.rejects(
    () =>
      client.sign({
        ownerAddress: OWNER.address.toLowerCase(),
        prepared,
      }),
    assertClientError('SIGNATURE_REJECTED')
  );
});

test('rejects compact, malformed, and unsupported-version signatures', async () => {
  const signatures = [
    `0x${'11'.repeat(64)}`,
    `0x${'11'.repeat(64)}02`,
    'not-a-signature',
  ];
  const client = signingClient(async () => signatures.shift());
  const prepared = client.prepare({ txn: TRANSACTION });

  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(
      () =>
        client.sign({
          ownerAddress: OWNER.address.toLowerCase(),
          prepared,
        }),
      assertClientError('SIGNATURE_REJECTED')
    );
  }
});

test('sanitizes wallet failures and permits a later explicit retry', async () => {
  let calls = 0;
  const client = signingClient(async (request) => {
    calls += 1;
    if (calls === 1) throw new Error('wallet provider secret');
    const { account: _account, ...typedData } = request;
    return OWNER.signTypedData(typedData);
  });
  const prepared = client.prepare({ txn: TRANSACTION });
  const input = {
    ownerAddress: OWNER.address.toLowerCase(),
    prepared,
  };

  await assert.rejects(
    () => client.sign(input),
    (error) => {
      assertClientError('WALLET_REQUEST_FAILED')(error);
      assert.equal(
        error.message,
        'The Safe owner wallet request failed.'
      );
      assert.equal(error.message.includes('secret'), false);
      return true;
    }
  );
  const result = await client.sign(input);
  assert.equal(result.signer, OWNER.address.toLowerCase());
  assert.equal(calls, 2);
});

test('allows only one in-flight wallet signing request per client', async () => {
  let release;
  let calls = 0;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const client = signingClient(async (request) => {
    calls += 1;
    await waiting;
    const { account: _account, ...typedData } = request;
    return OWNER.signTypedData(typedData);
  });
  const prepared = client.prepare({ txn: TRANSACTION });
  const input = {
    ownerAddress: OWNER.address.toLowerCase(),
    prepared,
  };
  const first = client.sign(input);

  await assert.rejects(
    () => client.sign(input),
    assertClientError('SIGNING_IN_PROGRESS')
  );
  assert.equal(calls, 1);
  release();
  await first;
});

test('rejects forged, cross-client, and accessor-backed prepared input without a wallet call', async () => {
  let calls = 0;
  const signTypedData = async () => {
    calls += 1;
    throw new Error('must not sign');
  };
  const first = signingClient(signTypedData);
  const second = signingClient(signTypedData);
  const prepared = first.prepare({ txn: TRANSACTION });
  let reads = 0;
  const accessor = { ownerAddress: OWNER.address.toLowerCase() };
  Object.defineProperty(accessor, 'prepared', {
    enumerable: true,
    get() {
      reads += 1;
      return prepared;
    },
  });

  for (const input of [
    {
      ownerAddress: OWNER.address.toLowerCase(),
      prepared: {
        safeTxHash: prepared.safeTxHash,
        txn: prepared.txn,
        typedData: prepared.typedData,
      },
    },
    {
      ownerAddress: OWNER.address.toLowerCase(),
      prepared,
    },
    accessor,
  ]) {
    await assert.rejects(
      () => second.sign(input),
      assertClientError('INVALID_INPUT')
    );
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('rejects configurable chains, targets, account formats, and transaction accessors', async () => {
  const signer = async () => {
    throw new Error('must not sign');
  };
  for (const options of [
    {
      chainId: REYA_CHAIN_ID,
      safeAddress: SAFE_ADDRESS,
      signTypedData: signer,
    },
    {
      rpcUrl: 'https://rpc.example',
      safeAddress: SAFE_ADDRESS,
      signTypedData: signer,
    },
    {
      safeAddress: SAFE_ADDRESS.toUpperCase(),
      signTypedData: signer,
    },
    {
      safeAddress: SAFE_ADDRESS,
      signTypedData: null,
    },
  ]) {
    assert.throws(
      () => createReyaSafeSigningClient(options),
      assertClientError('INVALID_CONFIGURATION')
    );
  }

  const client = signingClient(signer);
  const transactionInput = {};
  let reads = 0;
  Object.defineProperty(transactionInput, 'txn', {
    enumerable: true,
    get() {
      reads += 1;
      return TRANSACTION;
    },
  });
  assert.throws(
    () => client.prepare(transactionInput),
    assertClientError('INVALID_INPUT')
  );
  assert.equal(reads, 0);

  const prepared = client.prepare({ txn: TRANSACTION });
  await assert.rejects(
    () =>
      client.sign({
        ownerAddress: OWNER.address,
        prepared,
      }),
    assertClientError('INVALID_INPUT')
  );
});
