import path from 'node:path';
import { createLocalAnvilFork } from '../test-support/local-anvil-fork.mjs';
import { prepareLocalQaRuntime } from '../test-support/local-qa-provenance.mjs';
import {
  LOCAL_QA_BASELINE,
  LOCAL_QA_FIXTURE_PATH,
  LOCAL_QA_PARTIAL_DEPLOYMENTS,
  LOCAL_QA_SAFE_ADDRESS,
  LOCAL_QA_SOURCE,
  loadLocalQaResolutionManifest,
} from '../test-support/local-qa-resolution.mjs';
import { loadLocalSourceBundle } from '../test-support/local-source-bundle.mjs';

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const REQUEST_KEYS = Object.freeze([
  'chainId',
  'commit',
  'partialDeployCid',
  'previousPackageCid',
  'safeAddress',
]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function absolutePath(value, key) {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    value.includes('\0')
  ) {
    throw new Error(`${key} must be an absolute path`);
  }
  return path.normalize(value);
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function loadInteractiveLocalPreviewConfig(env = process.env) {
  return Object.freeze({
    artifactCache: absolutePath(
      required(env, 'REYA_LOCAL_ARTIFACT_CACHE'),
      'REYA_LOCAL_ARTIFACT_CACHE'
    ),
    sourceRepository: absolutePath(
      required(env, 'REYA_LOCAL_SOURCE_REPOSITORY'),
      'REYA_LOCAL_SOURCE_REPOSITORY'
    ),
  });
}

export function parseInteractivePreviewRequest(encoded, expected) {
  if (
    typeof encoded !== 'string' ||
    encoded.length < 2 ||
    encoded.length > 1_024
  ) {
    throw Object.assign(new Error('interactive preview request is invalid'), {
      status: 400,
    });
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw Object.assign(new Error('interactive preview request is invalid'), {
      status: 400,
    });
  }
  if (
    !isPlainObject(value) ||
    JSON.stringify(Object.keys(value)) !== JSON.stringify(REQUEST_KEYS) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string') ||
    JSON.stringify(value) !== encoded ||
    value.chainId !== 1729 ||
    !COMMIT_PATTERN.test(value.commit) ||
    (value.partialDeployCid !== null &&
      !CID_PATTERN.test(value.partialDeployCid)) ||
    value.previousPackageCid !== expected.previousPackageCid ||
    !CID_PATTERN.test(value.previousPackageCid) ||
    value.safeAddress !== expected.safeAddress ||
    !ADDRESS_PATTERN.test(value.safeAddress)
  ) {
    throw Object.assign(new Error('interactive preview request is invalid'), {
      status: 400,
    });
  }
  const partial =
    value.partialDeployCid === null
      ? null
      : expected.partialDeployments.find(
          ({ deployCid }) => deployCid === value.partialDeployCid
        );
  if (
    (partial === null && value.commit !== expected.defaultCommit) ||
    (value.partialDeployCid !== null &&
      (partial === undefined || value.commit !== partial.source.commit))
  ) {
    throw Object.assign(new Error('interactive preview request is invalid'), {
      status: 400,
    });
  }
  return value;
}

async function prepareContext({ artifactCache, signal, sourceRepository }) {
  const manifest = await loadLocalQaResolutionManifest(LOCAL_QA_FIXTURE_PATH);
  const cannonSource = await prepareLocalQaRuntime({ signal });
  const [
    { createReadOnlyArtifactLoader },
    { assembleCannonDefinition },
    { createEphemeralArtifactOverlay },
    { runReadOnlyPreview },
    { loadVerifiedLocalArtifactCache },
    { createLocalQaRegistry },
  ] = await Promise.all([
    import('./runtime/artifact-loader.mjs'),
    import('./runtime/assemble-definition.mjs'),
    import('./runtime/ephemeral-artifact-overlay.mjs'),
    import('./runtime/preview-engine.mjs'),
    import('../test-support/local-artifact-cache.mjs'),
    import('../test-support/local-qa-registry.mjs'),
  ]);
  const [sourceBundle, verifiedArtifactCache] = await Promise.all([
    loadLocalSourceBundle({
      commit: manifest.source.commit,
      expectedBundleSha256: manifest.source.bundleSha256,
      repositoryPath: sourceRepository,
    }),
    loadVerifiedLocalArtifactCache({
      cacheDir: artifactCache,
      manifestSha256: manifest.manifestSha256,
    }),
  ]);
  const verifiedCids = new Set(
    verifiedArtifactCache.inventory.artifacts.map(({ cid }) => cid)
  );
  return Object.freeze({
    cannonSource,
    createEphemeralArtifactOverlay,
    createLocalQaRegistry,
    assembleCannonDefinition,
    definition: assembleCannonDefinition(sourceBundle),
    manifest,
    readOnlyArtifactLoader: createReadOnlyArtifactLoader({
      maximumBytes: 50 * 1024 * 1024,
      readArtifact: verifiedArtifactCache.readArtifact,
    }),
    sourceBundle,
    runReadOnlyPreview,
    verifiedArtifactCache,
    verifiedCids,
  });
}

/**
 * Creates the local interactive preview boundary used by the browser QA
 * profile. The browser controls no filesystem path, RPC URL, signer or import
 * resolution. One preview may run at a time and every run receives a new
 * ephemeral artifact overlay and disposable latest-state Anvil fork.
 */
export function createInteractiveLocalPreviewRunner({
  artifactCache,
  rpcUrl,
  safeAddress,
  sourceCommit,
  sourceRepository,
}) {
  if (
    sourceCommit !== LOCAL_QA_SOURCE.commit ||
    safeAddress !== LOCAL_QA_SAFE_ADDRESS ||
    typeof rpcUrl !== 'string' ||
    rpcUrl.length < 1
  ) {
    throw new Error('interactive preview configuration is invalid');
  }
  const paths = Object.freeze({
    artifactCache: absolutePath(artifactCache, 'REYA_LOCAL_ARTIFACT_CACHE'),
    sourceRepository: absolutePath(
      sourceRepository,
      'REYA_LOCAL_SOURCE_REPOSITORY'
    ),
  });
  const lifecycle = new AbortController();
  let active = false;
  let prepared;

  const context = () => {
    prepared ??= prepareContext({
      ...paths,
      signal: lifecycle.signal,
    });
    return prepared;
  };

  return Object.freeze({
    allowsSourceCommit(commit) {
      return (
        commit === sourceCommit ||
        LOCAL_QA_PARTIAL_DEPLOYMENTS.some(
          ({ source }) => source.commit === commit
        )
      );
    },
    close() {
      lifecycle.abort(new Error('interactive preview runner stopped'));
    },
    async run(encoded) {
      if (lifecycle.signal.aborted) {
        throw new Error('interactive preview runner stopped');
      }
      if (active) {
        throw Object.assign(
          new Error('interactive preview is already running'),
          {
            status: 409,
          }
        );
      }
      active = true;
      let fork;
      try {
        const request = parseInteractivePreviewRequest(encoded, {
          defaultCommit: sourceCommit,
          partialDeployments: LOCAL_QA_PARTIAL_DEPLOYMENTS,
          previousPackageCid: LOCAL_QA_BASELINE.deployCid,
          safeAddress,
        });
        const loaded = await context();
        if (
          loaded.manifest.source.commit !== sourceCommit ||
          loaded.manifest.safeAddress !== safeAddress
        ) {
          throw new Error('interactive preview fixture binding is invalid');
        }
        const { loader: artifactLoader } =
          loaded.createEphemeralArtifactOverlay({
            allowedCids: loaded.verifiedCids,
            baseLoader: loaded.readOnlyArtifactLoader,
          });
        const startingDeployCid =
          request.partialDeployCid ?? request.previousPackageCid;
        const startingDeployment = await artifactLoader.read(
          `ipfs://${startingDeployCid}`
        );
        const partialBinding =
          request.partialDeployCid === null
            ? null
            : loaded.manifest.partialDeployments.find(
                ({ deployCid }) => deployCid === request.partialDeployCid
              );
        if (request.partialDeployCid !== null && partialBinding === undefined) {
          throw new Error(
            'interactive preview partial deployment is not pinned'
          );
        }
        const sourceBinding = partialBinding?.source ?? loaded.manifest.source;
        const sourceBundle =
          partialBinding === null
            ? loaded.sourceBundle
            : await loadLocalSourceBundle({
                commit: sourceBinding.commit,
                expectedBundleSha256: sourceBinding.bundleSha256,
                repositoryPath: paths.sourceRepository,
              });
        const definition =
          partialBinding === null
            ? loaded.definition
            : loaded.assembleCannonDefinition(sourceBundle);
        if (
          partialBinding !== null &&
          JSON.stringify(startingDeployment.def) !== JSON.stringify(definition)
        ) {
          throw new Error(
            'interactive preview partial deployment definition mismatch'
          );
        }
        const registry = loaded.createLocalQaRegistry({
          manifest: loaded.manifest,
          verifiedCids: loaded.verifiedCids,
        });
        fork = await createLocalAnvilFork({
          forkMode: 'interactive-latest',
          safeAddress,
          signal: lifecycle.signal,
          upstreamRpcUrl: rpcUrl,
        });
        const result = await loaded.runReadOnlyPreview({
          artifactLoader,
          commit: request.commit,
          definition,
          deploymentMode:
            request.partialDeployCid === null ? 'cannonfile' : 'partial',
          partialDeployCid: request.partialDeployCid,
          previousPackageCid: request.previousPackageCid,
          registry,
          rpc: Object.freeze({ request: fork.request }),
          safeAddress,
          sourceGitUrl: sourceBinding.gitUrl,
          startingDeployment,
        });
        return Object.freeze({
          ...result,
          qaEvidence: Object.freeze({
            artifactCount:
              loaded.verifiedArtifactCache.inventory.artifacts.length,
            artifactInventorySha256:
              loaded.verifiedArtifactCache.inventory.inventorySha256,
            bundleSha256: sourceBundle.bundleSha256,
            cannonSource: loaded.cannonSource,
            forkBlock: fork.forkBlock,
            manifestSha256: loaded.manifest.manifestSha256,
            mode: 'interactive-current-state',
          }),
        });
      } finally {
        await fork?.stop();
        active = false;
      }
    },
  });
}
