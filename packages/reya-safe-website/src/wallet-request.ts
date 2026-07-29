const REQUEST_KEYS = Object.freeze(['account', 'domain', 'message', 'primaryType', 'types']);

const EIP712_DOMAIN_TYPES = Object.freeze([
  Object.freeze({ name: 'chainId', type: 'uint256' }),
  Object.freeze({ name: 'verifyingContract', type: 'address' }),
]);

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('WALLET_REQUEST_REJECTED');
  }
  return value as Record<string, unknown>;
}

export function walletTypedData(value: unknown, expectedAccount: `0x${string}`, expectedSafeAddress: `0x${string}`): string {
  const request = exactRecord(value, REQUEST_KEYS);
  const domain = exactRecord(request.domain, ['chainId', 'verifyingContract']);
  const types = exactRecord(request.types, ['SafeTx']);
  exactRecord(request.message, [
    'baseGas',
    'data',
    'gasPrice',
    'gasToken',
    'nonce',
    'operation',
    'refundReceiver',
    'safeTxGas',
    'to',
    'value',
  ]);
  if (
    request.account !== expectedAccount ||
    request.primaryType !== 'SafeTx' ||
    domain.chainId !== 1729 ||
    domain.verifyingContract !== expectedSafeAddress ||
    !Array.isArray(types.SafeTx)
  ) {
    throw new Error('WALLET_REQUEST_REJECTED');
  }
  return JSON.stringify(
    {
      domain,
      message: request.message,
      primaryType: request.primaryType,
      types: {
        EIP712Domain: EIP712_DOMAIN_TYPES,
        SafeTx: types.SafeTx,
      },
    },
    (_key, nested) => (typeof nested === 'bigint' ? nested.toString(10) : nested)
  );
}
