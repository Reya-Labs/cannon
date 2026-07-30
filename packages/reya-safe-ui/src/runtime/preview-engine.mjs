import {
  build as cannonBuild,
  ChainBuilderRuntime,
  ChainDefinition,
  createInitialContext,
  Events,
  getContractDefinitionFromPath,
  getContractFromPath,
  loadPrecompiles,
} from '@usecannon/builder';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  custom,
  decodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  toFunctionSelector,
  toFunctionSignature,
} from 'viem';

const CHAIN_ID = 1729;
const CANNON_VERSION = '2.26.1';
const STATE_FORMAT_VERSION = 7;
export const LOCAL_QA_DEPLOYER_ADDRESS =
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_URL_PATTERN = /^ipfs:\/\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const PREVIEW_KEYS = Object.freeze([
  'artifactLoader',
  'commit',
  'definition',
  'deploymentMode',
  'partialDeployCid',
  'previousPackageCid',
  'registry',
  'rpc',
  'safeAddress',
  'sourceGitUrl',
  'startingDeployment',
]);
const REYA_CHAIN = Object.freeze({
  id: CHAIN_ID,
  name: 'Reya Network',
  nativeCurrency: Object.freeze({
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  }),
  rpcUrls: Object.freeze({
    default: Object.freeze({ http: Object.freeze([]) }),
  }),
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function canonicalAddress(value, label) {
  if (
    typeof value !== 'string' ||
    !ADDRESS_PATTERN.test(value) ||
    value === `0x${'0'.repeat(40)}`
  ) {
    throw new Error(`${label} is invalid`);
  }
  return getAddress(value);
}

function canonicalHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new Error('preview transaction hash is invalid');
  }
  return value;
}

function validateStartingDeployment(
  value,
  { commit, definition, deploymentMode, sourceGitUrl }
) {
  if (
    !isPlainObject(value) ||
    value.status !== (deploymentMode === 'partial' ? 'partial' : 'complete') ||
    value.chainId !== CHAIN_ID ||
    typeof value.generator !== 'string' ||
    value.generator.length < 1 ||
    value.generator.length > 128 ||
    !CID_URL_PATTERN.test(value.miscUrl) ||
    !isPlainObject(value.def) ||
    value.def.name !== 'reya-omnibus' ||
    typeof value.def.version !== 'string' ||
    !VERSION_PATTERN.test(value.def.version) ||
    value.def.preset !== 'main' ||
    !isPlainObject(value.state) ||
    !isPlainObject(value.options) ||
    !isPlainObject(value.meta)
  ) {
    throw new Error('preview starting deployment is invalid');
  }
  if (
    deploymentMode === 'partial' &&
    (JSON.stringify(value.def) !== JSON.stringify(definition) ||
      value.meta.gitUrl !== sourceGitUrl ||
      value.meta.commitHash !== commit)
  ) {
    throw new Error('preview partial deployment provenance is invalid');
  }
  return value;
}

function snapshotDecodedValue(value, depth = 0) {
  if (depth > 16) {
    throw new Error('preview decoded calldata is too deeply nested');
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > 2 * 512 * 1024) {
      throw new Error('preview decoded calldata string is too large');
    }
    return /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase() : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 16_384) {
      throw new Error('preview decoded calldata array is too large');
    }
    return Object.freeze(
      value.map((item) => snapshotDecodedValue(item, depth + 1))
    );
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    if (
      keys.length > 256 ||
      keys.some(
        (key) =>
          !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(key) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
      )
    ) {
      throw new Error('preview decoded calldata object is invalid');
    }
    return Object.freeze(
      Object.fromEntries(
        keys.map((key) => [key, snapshotDecodedValue(value[key], depth + 1)])
      )
    );
  }
  throw new Error('preview decoded calldata value is invalid');
}

function canonicalDecodedCall(value, data) {
  if (value === null) return null;
  if (
    !exactKeys(value, ['arguments', 'function', 'selector']) ||
    typeof value.function !== 'string' ||
    value.function.length < 3 ||
    value.function.length > 1024 ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*\(/.test(value.function) ||
    !value.function.endsWith(')') ||
    /[\s\u0000-\u001f\u007f]/.test(value.function) ||
    typeof value.selector !== 'string' ||
    !/^0x[0-9a-f]{8}$/.test(value.selector) ||
    value.selector !== data.slice(0, 10) ||
    !Array.isArray(value.arguments)
  ) {
    throw new Error('preview decoded calldata is invalid');
  }
  let expectedSelector;
  try {
    expectedSelector = toFunctionSelector(value.function).toLowerCase();
  } catch {
    throw new Error('preview decoded calldata is invalid');
  }
  if (expectedSelector !== value.selector || value.arguments.length > 256) {
    throw new Error('preview decoded calldata is invalid');
  }
  const decoded = Object.freeze({
    arguments: snapshotDecodedValue(value.arguments),
    function: value.function,
    selector: value.selector,
  });
  if (JSON.stringify(decoded).length > 2 * 512 * 1024) {
    throw new Error('preview decoded calldata is too large');
  }
  return decoded;
}

export function createInvokeDecoders(config, context) {
  if (!Array.isArray(config?.target) || config.target.length < 1) {
    throw new Error('preview invoke metadata is invalid');
  }
  let customAbi = null;
  if (typeof config.abi === 'string') {
    customAbi = config.abi.startsWith('[')
      ? JSON.parse(config.abi)
      : getContractDefinitionFromPath(context, config.abi)?.abi ?? null;
  }
  return Object.freeze(
    config.target.map((target) => {
      const resolvedContract = isAddress(target)
        ? customAbi
          ? { abi: customAbi, address: target }
          : null
        : getContractFromPath(context, target);
      const contract =
        resolvedContract && customAbi
          ? { ...resolvedContract, abi: customAbi }
          : resolvedContract;
      if (!contract || !Array.isArray(contract.abi)) {
        throw new Error('preview invoke ABI is unavailable');
      }
      return Object.freeze({
        abi: contract.abi,
        address: getAddress(contract.address).toLowerCase(),
        expectedFunction: config.func,
      });
    })
  );
}

export function decodeCapturedCall({ decoders, step, transaction }) {
  if (!step.startsWith('invoke.')) return null;
  if (
    !Array.isArray(decoders) ||
    typeof transaction?.input !== 'string' ||
    !HEX_PATTERN.test(transaction.input) ||
    transaction.input.length < 10 ||
    transaction.to === null ||
    transaction.to === undefined
  ) {
    throw new Error('preview invoke decode context is invalid');
  }
  const selector = transaction.input.slice(0, 10);
  const target = getAddress(transaction.to).toLowerCase();
  const decodedCandidates = new Map();
  for (const decoder of decoders) {
    if (decoder.address !== target) continue;
    const matches = decoder.abi.filter(
      (item) =>
        item?.type === 'function' &&
        toFunctionSelector(item).toLowerCase() === selector
    );
    for (const item of matches) {
      const signature = toFunctionSignature(item);
      const cannonSignature = `${item.name}(${item.inputs
        .map(({ type }) => type)
        .join(',')})`;
      if (
        decoder.expectedFunction !== item.name &&
        decoder.expectedFunction !== cannonSignature &&
        decoder.expectedFunction !== signature
      ) {
        continue;
      }
      const decoded = decodeFunctionData({
        abi: [item],
        data: transaction.input,
      });
      const candidate = canonicalDecodedCall(
        {
          arguments: [...(decoded.args ?? [])],
          function: signature,
          selector,
        },
        transaction.input
      );
      decodedCandidates.set(JSON.stringify(candidate), candidate);
    }
  }
  if (decodedCandidates.size !== 1) {
    throw new Error('preview invoke calldata is not uniquely decodable');
  }
  return [...decodedCandidates.values()][0];
}

function canonicalCall(
  { decoded, hash, receipt, step, transaction },
  sequence,
  safeAddress,
  deployerAddress
) {
  const senderRole = isAddressEqual(transaction?.from, safeAddress)
    ? 'safe'
    : isAddressEqual(transaction?.from, deployerAddress)
    ? 'deployer'
    : null;
  if (
    typeof step !== 'string' ||
    step.length < 1 ||
    step.length > 512 ||
    !transaction ||
    !receipt ||
    typeof transaction.input !== 'string' ||
    !HEX_PATTERN.test(transaction.input) ||
    typeof transaction.value !== 'bigint' ||
    transaction.value < 0n ||
    typeof receipt.gasUsed !== 'bigint' ||
    receipt.gasUsed < 0n ||
    receipt.status !== 'success' ||
    receipt.transactionHash !== hash ||
    transaction.hash !== hash ||
    !isAddressEqual(receipt.from, transaction.from) ||
    (receipt.to === null || receipt.to === undefined) !==
      (transaction.to === null || transaction.to === undefined) ||
    (receipt.to !== null &&
      receipt.to !== undefined &&
      !isAddressEqual(receipt.to, transaction.to)) ||
    senderRole === null ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    (senderRole === 'safe' &&
      (transaction.to === null || transaction.to === undefined))
  ) {
    throw new Error(
      'preview transaction is outside the approved signer contract'
    );
  }
  const to =
    transaction.to === null || transaction.to === undefined
      ? null
      : getAddress(transaction.to).toLowerCase();
  const decodedCall = canonicalDecodedCall(decoded ?? null, transaction.input);
  if (step.startsWith('invoke.') && decodedCall === null) {
    throw new Error('preview invoke calldata is not decoded');
  }
  return Object.freeze({
    data: transaction.input,
    decoded: decodedCall,
    from: getAddress(transaction.from).toLowerCase(),
    gasUsed: receipt.gasUsed.toString(),
    sequence,
    senderRole,
    step,
    to,
    transactionHash: canonicalHash(hash),
    value: transaction.value.toString(),
  });
}

/**
 * Validates captured build transactions and returns the ordered, non-signable
 * preview contract. Transaction hashes are included only as local simulation
 * evidence; this is not a Safe transaction hash.
 */
export function createPreviewResult({
  calls,
  commit,
  deployerAddress,
  deployerStartingNonce,
  partialDeployCid,
  previousPackageCid,
  safeAddress,
}) {
  if (
    !Array.isArray(calls) ||
    calls.length < 1 ||
    calls.length > 4_096 ||
    !COMMIT_PATTERN.test(commit) ||
    (partialDeployCid !== null && !CID_V0_PATTERN.test(partialDeployCid)) ||
    !CID_V0_PATTERN.test(previousPackageCid) ||
    typeof deployerStartingNonce !== 'string' ||
    !/^(?:0|[1-9][0-9]*)$/.test(deployerStartingNonce)
  ) {
    throw new Error('preview result framing is invalid');
  }
  const safe = canonicalAddress(safeAddress, 'preview Safe address');
  const deployer = canonicalAddress(
    deployerAddress,
    'preview deployer address'
  );
  if (isAddressEqual(safe, deployer)) {
    throw new Error('preview Safe and deployer must be distinct');
  }
  const hashes = new Set();
  const simulationTransactions = calls.map((call, sequence) => {
    const canonical = canonicalCall(call, sequence, safe, deployer);
    if (hashes.has(canonical.transactionHash)) {
      throw new Error('preview captured a duplicate transaction');
    }
    hashes.add(canonical.transactionHash);
    return canonical;
  });
  const safeProposalCalls = simulationTransactions.filter(
    ({ senderRole }) => senderRole === 'safe'
  );
  if (safeProposalCalls.length < 1) {
    throw new Error('preview captured no Safe proposal calls');
  }
  const deployerPrerequisites = simulationTransactions.filter(
    ({ senderRole }) => senderRole === 'deployer'
  );

  return Object.freeze({
    schemaVersion: 4,
    type: 'reya-cannon-read-only-preview',
    commit,
    cannon: Object.freeze({
      stateFormatVersion: STATE_FORMAT_VERSION,
      version: CANNON_VERSION,
    }),
    chainId: CHAIN_ID,
    safeAddress: safe.toLowerCase(),
    deployerAddress: deployer.toLowerCase(),
    deployerStartingNonce,
    partialDeployCid,
    previousPackageCid,
    deployerPrerequisites: Object.freeze(deployerPrerequisites),
    safeProposalCalls: Object.freeze(safeProposalCalls),
    simulationTransactions: Object.freeze(simulationTransactions),
  });
}

/**
 * Executes one fail-closed Cannon upgrade simulation against a disposable
 * EIP-1193 fork. Only the configured Reya Safe and the fixed local-QA deployer
 * are permitted. Deployer transactions are reported as prerequisites and are
 * never represented as Safe proposal calls.
 *
 * The caller owns the fork lifecycle and must supply a registry seeded from a
 * validated immutable local-QA resolution manifest plus a CID-verifying,
 * read-only artifact loader. All build outputs are written only to an
 * ephemeral in-memory loader.
 */
export async function runReadOnlyPreview(options) {
  if (!exactKeys(options, PREVIEW_KEYS)) {
    throw new Error('preview engine options are invalid');
  }
  const {
    artifactLoader,
    commit,
    definition,
    deploymentMode,
    partialDeployCid,
    previousPackageCid,
    registry,
    rpc,
    safeAddress,
    sourceGitUrl,
    startingDeployment,
  } = options;
  if (
    !COMMIT_PATTERN.test(commit) ||
    !['cannonfile', 'partial'].includes(deploymentMode) ||
    (partialDeployCid !== null && !CID_V0_PATTERN.test(partialDeployCid)) ||
    (deploymentMode === 'partial') !== (partialDeployCid !== null) ||
    !CID_V0_PATTERN.test(previousPackageCid) ||
    !isPlainObject(definition) ||
    typeof sourceGitUrl !== 'string' ||
    sourceGitUrl.length < 1 ||
    sourceGitUrl.length > 256 ||
    !isPlainObject(startingDeployment) ||
    registry === null ||
    typeof registry !== 'object' ||
    typeof registry.getUrl !== 'function' ||
    artifactLoader === null ||
    typeof artifactLoader !== 'object' ||
    typeof artifactLoader.read !== 'function' ||
    typeof artifactLoader.put !== 'function' ||
    rpc === null ||
    typeof rpc !== 'object' ||
    typeof rpc.request !== 'function'
  ) {
    throw new Error('preview engine options are invalid');
  }
  validateStartingDeployment(startingDeployment, {
    commit,
    definition,
    deploymentMode,
    sourceGitUrl,
  });
  const safe = canonicalAddress(safeAddress, 'preview Safe address');
  const deployer = canonicalAddress(
    LOCAL_QA_DEPLOYER_ADDRESS,
    'preview deployer address'
  );
  const captured = [];
  let currentRuntime;
  const request = createOrderedRpcRequest({
    captured,
    currentStep: () => currentRuntime?.currentStep ?? '',
    rpc,
  });
  const transport = custom({
    request,
  });
  const publicClient = createPublicClient({
    chain: REYA_CHAIN,
    transport,
  });
  const testClient = createTestClient({
    chain: REYA_CHAIN,
    mode: 'anvil',
    transport,
  });
  const safeWallet = createWalletClient({
    account: safe,
    chain: REYA_CHAIN,
    transport,
  });
  const deployerWallet = createWalletClient({
    account: deployer,
    chain: REYA_CHAIN,
    transport,
  });
  try {
    await loadPrecompiles(testClient);
  } catch (error) {
    throw new Error('preview precompile setup failed', { cause: error });
  }
  let deployerStartingNonce;
  try {
    deployerStartingNonce = (
      await publicClient.getTransactionCount({ address: deployer })
    ).toString();
  } catch (error) {
    throw new Error('preview deployer nonce read failed', { cause: error });
  }

  const approvedSigner = async (requested) => {
    if (isAddressEqual(requested, safe)) {
      return Object.freeze({ address: safe, wallet: safeWallet });
    }
    if (isAddressEqual(requested, deployer)) {
      return Object.freeze({ address: deployer, wallet: deployerWallet });
    }
    throw new Error('preview requested an unapproved signer');
  };
  const skipped = [];
  const decoderByStep = new Map();
  const runtime = new ChainBuilderRuntime(
    {
      allowPartialDeploy: false,
      chainId: CHAIN_ID,
      getDefaultSigner: async () =>
        Object.freeze({ address: deployer, wallet: deployerWallet }),
      getSigner: approvedSigner,
      provider: publicClient,
      snapshots: false,
    },
    registry,
    {
      ipfs: artifactLoader,
    },
    'ipfs'
  );
  currentRuntime = runtime;
  runtime.on(Events.SkipDeploy, (step, error) => {
    skipped.push(
      `${String(step)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
  runtime.on(
    Events.PostStepExecute,
    (type, label, config, context, _result, depth) => {
      if (type === 'invoke' && depth === 0) {
        decoderByStep.set(
          `${type}.${label}`,
          createInvokeDecoders(config, context)
        );
      }
    }
  );

  await runtime.restoreMisc(startingDeployment.miscUrl);
  const chainDefinition = new ChainDefinition(definition);
  const context = await createInitialContext(
    chainDefinition,
    startingDeployment.meta ?? {},
    CHAIN_ID,
    startingDeployment.options ?? {},
    deployer
  );
  try {
    await cannonBuild(
      runtime,
      chainDefinition,
      structuredClone(startingDeployment.state ?? {}),
      context
    );
  } catch (error) {
    throw new Error(
      `preview build failed at ${runtime.currentStep ?? 'unknown step'}`,
      { cause: error }
    );
  } finally {
    currentRuntime = undefined;
  }
  if (skipped.length > 0) {
    throw new Error(`preview skipped deployment steps: ${skipped.join('; ')}`);
  }

  const calls = [];
  for (const capturedTransaction of captured) {
    const [transaction, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: capturedTransaction.hash }),
      publicClient.getTransactionReceipt({ hash: capturedTransaction.hash }),
    ]);
    calls.push({
      ...capturedTransaction,
      decoded: decodeCapturedCall({
        decoders: decoderByStep.get(capturedTransaction.step),
        step: capturedTransaction.step,
        transaction,
      }),
      receipt,
      transaction,
    });
  }
  return createPreviewResult({
    calls,
    commit,
    deployerAddress: deployer.toLowerCase(),
    deployerStartingNonce,
    partialDeployCid,
    previousPackageCid,
    safeAddress: safe.toLowerCase(),
  });
}

export function createOrderedRpcRequest({ captured, currentStep, rpc }) {
  if (
    !Array.isArray(captured) ||
    typeof currentStep !== 'function' ||
    rpc === null ||
    typeof rpc !== 'object' ||
    typeof rpc.request !== 'function'
  ) {
    throw new Error('preview capture transport options are invalid');
  }
  return async (request) => {
    if (request?.method !== 'eth_sendTransaction') {
      return rpc.request(request);
    }
    const sequence = captured.length;
    captured.push(undefined);
    const step = currentStep();
    const result = await rpc.request(request);
    captured[sequence] = Object.freeze({
      hash: canonicalHash(result),
      step,
    });
    return result;
  };
}
