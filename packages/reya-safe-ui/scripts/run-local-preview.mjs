import { randomBytes } from 'node:crypto';
import {
  link,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCAL_QA_FIXTURE_PATH,
  loadLocalQaResolutionManifest,
} from '../test-support/local-qa-resolution.mjs';
import { prepareLocalQaRuntime } from '../test-support/local-qa-provenance.mjs';
import { loadLocalSourceBundle } from '../test-support/local-source-bundle.mjs';

const ARGUMENT_KEYS = Object.freeze([
  'artifactCache',
  'forkBlockHash',
  'forkBlockNumber',
  'manifest',
  'output',
  'sourceRepository',
]);

function exactKeys(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return (
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string')
  );
}

function absolutePath(value, label) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  ) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.normalize(value);
}

export function parseLocalPreviewArguments(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('local preview arguments are invalid');
  }
  const parsed = {
    artifactCache: undefined,
    forkBlockHash: undefined,
    forkBlockNumber: undefined,
    manifest: LOCAL_QA_FIXTURE_PATH,
    output: undefined,
    sourceRepository: undefined,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== 'string' ||
      typeof value !== 'string' ||
      !flag.startsWith('--') ||
      value.startsWith('--')
    ) {
      throw new Error('local preview arguments are invalid');
    }
    const key = {
      '--artifact-cache': 'artifactCache',
      '--fork-block-hash': 'forkBlockHash',
      '--fork-block-number': 'forkBlockNumber',
      '--manifest': 'manifest',
      '--output': 'output',
      '--source-repository': 'sourceRepository',
    }[flag];
    if (!key || seen.has(key)) {
      throw new Error('local preview arguments are invalid');
    }
    seen.add(key);
    parsed[key] =
      key === 'forkBlockHash' || key === 'forkBlockNumber'
        ? value
        : absolutePath(value, flag);
  }
  if (
    !exactKeys(parsed, ARGUMENT_KEYS) ||
    parsed.artifactCache === undefined ||
    parsed.sourceRepository === undefined
  ) {
    throw new Error('local preview requires source and artifact paths');
  }
  if (
    (parsed.forkBlockHash === undefined) !==
      (parsed.forkBlockNumber === undefined) ||
    (parsed.forkBlockHash !== undefined &&
      !/^0x[0-9a-f]{64}$/.test(parsed.forkBlockHash)) ||
    (parsed.forkBlockNumber !== undefined &&
      !/^(?:0|[1-9][0-9]*)$/.test(parsed.forkBlockNumber))
  ) {
    throw new Error('local preview fork block is invalid');
  }
  return Object.freeze(parsed);
}

function upstreamRpcUrl(env) {
  const value = env.REYA_CANNON_QA_RPC_URL;
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error('REYA_CANNON_QA_RPC_URL is required');
  }
  return value;
}

async function writeAtomicCreateOnly(target, encoded) {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  await writeFile(temporary, encoded, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function runLocalPreview({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const lifecycle = new AbortController();
  let fork;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    lifecycle.abort(new Error('local preview was interrupted'));
    void fork?.stop();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const args = parseLocalPreviewArguments(argv);
    const manifest = await loadLocalQaResolutionManifest(args.manifest);
    const cannonSource = await prepareLocalQaRuntime({
      signal: lifecycle.signal,
    });
    const [
      { createReadOnlyArtifactLoader },
      { assembleCannonDefinition },
      { createEphemeralArtifactOverlay },
      { runReadOnlyPreview },
      { createLocalAnvilFork },
      { loadVerifiedLocalArtifactCache },
      { createLocalQaRegistry },
    ] = await Promise.all([
      import('../src/runtime/artifact-loader.mjs'),
      import('../src/runtime/assemble-definition.mjs'),
      import('../src/runtime/ephemeral-artifact-overlay.mjs'),
      import('../src/runtime/preview-engine.mjs'),
      import('../test-support/local-anvil-fork.mjs'),
      import('../test-support/local-artifact-cache.mjs'),
      import('../test-support/local-qa-registry.mjs'),
    ]);
    const [sourceBundle, artifactCache] = await Promise.all([
      loadLocalSourceBundle({
        commit: manifest.source.commit,
        expectedBundleSha256: manifest.source.bundleSha256,
        repositoryPath: args.sourceRepository,
      }),
      loadVerifiedLocalArtifactCache({
        cacheDir: args.artifactCache,
        manifestSha256: manifest.manifestSha256,
      }),
    ]);
    const definition = assembleCannonDefinition(sourceBundle);
    const verifiedCids = new Set(
      artifactCache.inventory.artifacts.map(({ cid }) => cid)
    );
    const readOnlyArtifactLoader = createReadOnlyArtifactLoader({
      maximumBytes: 50 * 1024 * 1024,
      readArtifact: artifactCache.readArtifact,
    });
    const { loader: artifactLoader } = createEphemeralArtifactOverlay({
      allowedCids: verifiedCids,
      baseLoader: readOnlyArtifactLoader,
    });
    const previousDeployment = await artifactLoader.read(
      `ipfs://${manifest.baseline.deployCid}`
    );
    const registry = createLocalQaRegistry({
      manifest,
      verifiedCids,
    });
    fork = await createLocalAnvilFork({
      forkBlock:
        args.forkBlockNumber === undefined
          ? undefined
          : Object.freeze({
              blockHash: args.forkBlockHash,
              blockNumber: args.forkBlockNumber,
            }),
      safeAddress: manifest.safeAddress,
      signal: lifecycle.signal,
      upstreamRpcUrl: upstreamRpcUrl(env),
    });

    let result;
    try {
      result = await runReadOnlyPreview({
        artifactLoader,
        commit: manifest.source.commit,
        definition,
        previousDeployment,
        previousDeployCid: manifest.baseline.deployCid,
        registry,
        rpc: Object.freeze({ request: fork.request }),
        safeAddress: manifest.safeAddress,
      });
    } catch (error) {
      if (interrupted) {
        throw new Error('local preview was interrupted', { cause: error });
      }
      throw error;
    }
    await fork.stop();
    if (interrupted) throw new Error('local preview was interrupted');

    const output = Object.freeze({
      ...result,
      qaEvidence: Object.freeze({
        artifactCount: artifactCache.inventory.artifacts.length,
        artifactInventorySha256: artifactCache.inventory.inventorySha256,
        bundleSha256: sourceBundle.bundleSha256,
        cannonSource,
        forkBlock: fork.forkBlock,
        manifestSha256: manifest.manifestSha256,
        mode: 'non-signable-local-qa',
      }),
    });
    const encoded = `${JSON.stringify(output, null, 2)}\n`;
    if (args.output) {
      await writeAtomicCreateOnly(args.output, encoded);
    }
    return Object.freeze({ encoded, result: output });
  } catch (error) {
    if (interrupted && error?.message !== 'local preview was interrupted') {
      throw new Error('local preview was interrupted', { cause: error });
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await fork?.stop();
  }
}

export function localPreviewFailureCode(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current === null ||
      typeof current !== 'object' ||
      seen.has(current)
    ) {
      break;
    }
    seen.add(current);
    const message =
      current instanceof Error && typeof current.message === 'string'
        ? current.message
        : '';
    if (message === 'local fork upstream cannot serve finalized state') {
      return 'RPC_PINNED_STATE_UNAVAILABLE';
    }
    if (message === 'local preview was interrupted') {
      return 'LOCAL_PREVIEW_INTERRUPTED';
    }
    if (message.startsWith('local QA provenance rejected:')) {
      return 'CANNON_PROVENANCE_FAILED';
    }
    if (
      message === 'local fork upstream reported the wrong chain' ||
      message === 'local fork reported the wrong chain'
    ) {
      return 'RPC_CHAIN_MISMATCH';
    }
    if (
      message === 'local fork failed to start' ||
      message === 'local fork exited before startup' ||
      message === 'local fork startup timed out'
    ) {
      return 'ANVIL_STARTUP_FAILED';
    }
    if (message === 'preview precompile setup failed') {
      return 'PRECOMPILE_SETUP_FAILED';
    }
    if (message.startsWith('preview build failed at ')) {
      return 'CANNON_BUILD_FAILED';
    }
    current = current.cause;
  }
  return 'LOCAL_PREVIEW_FAILED';
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const { encoded } = await runLocalPreview();
    process.stdout.write(encoded);
  } catch (error) {
    const code = localPreviewFailureCode(error);
    process.stderr.write(
      `Local Reya Cannon preview failed: ${code}\n`
    );
    process.exitCode = code === 'LOCAL_PREVIEW_INTERRUPTED' ? 130 : 1;
  }
}
