import { REYA_CHAIN_ID } from '../config.mjs';
import { isPreviewError, PreviewError } from '../errors.mjs';
import { createArtifactReader, MAX_ARTIFACT_BYTES } from './artifacts.mjs';
import { validatePreviewEngine } from './engine.mjs';
import { createPreviewFork } from './fork.mjs';
import { createPreviewRegistry } from './registry.mjs';
import { createSourceBundleReader, SOURCE_GIT_URL } from './source.mjs';

export const PREVIEW_PACKAGE_NAME = 'reya-omnibus';
export const PREVIEW_PACKAGE_PRESET = 'main';

const CID_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const VERSION_PATTERN =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/;

function reject() {
  throw new PreviewError(502, 'PREVIEW_FAILED');
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

/**
 * Reads the previous package's own identity out of its artifact.
 *
 * The registry entry a preview is diffed against is derived from the pinned
 * CID, never the other way round: the request names a CID, the CID names a
 * package. A caller therefore cannot ask for one version and be given another
 * one's calls.
 */
function previousPackageReference(deployment) {
  if (
    !isPlainObject(deployment) ||
    !isPlainObject(deployment.def) ||
    deployment.def.name !== PREVIEW_PACKAGE_NAME ||
    deployment.def.preset !== PREVIEW_PACKAGE_PRESET ||
    typeof deployment.def.version !== 'string' ||
    !VERSION_PATTERN.test(deployment.def.version) ||
    deployment.chainId !== REYA_CHAIN_ID ||
    deployment.status !== 'complete'
  ) {
    reject();
  }
  return `${PREVIEW_PACKAGE_NAME}:${deployment.def.version}@${PREVIEW_PACKAGE_PRESET}`;
}

function validateEngineResult(result, request) {
  if (
    !isPlainObject(result) ||
    result.type !== 'reya-cannon-read-only-preview' ||
    result.chainId !== REYA_CHAIN_ID ||
    result.commit !== request.commit ||
    result.safeAddress !== request.safeAddress ||
    result.previousPackageCid !== request.previousPackageCid ||
    result.partialDeployCid !== request.partialDeployCid ||
    !Array.isArray(result.safeProposalCalls) ||
    result.safeProposalCalls.length < 1 ||
    !Array.isArray(result.deployerPrerequisites) ||
    !Array.isArray(result.simulationTransactions) ||
    !isPlainObject(result.cannon)
  ) {
    reject();
  }
  return result;
}

/**
 * Builds the fork-backed production simulator.
 *
 * What it does, in order, is the whole of its security story:
 *
 * 1. read the pinned `reya-deployments` source bundle and re-hash it;
 * 2. assemble the Cannon definition from those exact bytes;
 * 3. read the previous package artifact, CID-verified, and take the package
 *    reference from the artifact rather than from the request;
 * 4. start a disposable Anvil fork of Reya Network, pinned to one block, with
 *    the credentialed upstream hidden behind a loopback proxy;
 * 5. run the reviewed read-only Cannon build against that fork;
 * 6. fail closed if a pruned-state rejection was seen at any point.
 *
 * What it never does is equally load-bearing: it is not given the Safe nonce,
 * it does not derive a transaction, and it does not compute a digest. Those
 * happen in `preview-runner.mjs` *after* this returns, from chain state, so a
 * simulator that had been subverted still cannot choose what an owner signs.
 *
 * @param {{
 *   artifactOrigin: string,
 *   engine: object,
 *   fetchImpl?: typeof fetch,
 *   mainnetRpcUrl: string,
 *   opRpcUrl: string,
 *   rpcUrl: string,
 *   sourceOrigin: string,
 *   startFork?: typeof createPreviewFork,
 * }} options
 * @returns {import('../preview-runner.mjs').PreviewSimulator}
 */
export function createForkSimulator({
  artifactOrigin,
  engine,
  fetchImpl,
  mainnetRpcUrl,
  opRpcUrl,
  rpcUrl,
  sourceOrigin,
  startFork = createPreviewFork,
}) {
  const capability = validatePreviewEngine(engine);
  if (
    typeof rpcUrl !== 'string' ||
    rpcUrl.length < 1 ||
    typeof startFork !== 'function'
  ) {
    throw new Error('fork simulator configuration is invalid');
  }
  const source = createSourceBundleReader({
    fetchImpl,
    origin: sourceOrigin,
  });

  return Object.freeze({
    async simulate({
      commit,
      deploymentMode,
      partialDeployCid,
      previousPackageCid,
      safeAddress,
      signal,
    }) {
      // The runner already validated these. Re-checking them is cheap and
      // keeps the simulator honest as a unit: it never widens its own inputs.
      if (
        typeof commit !== 'string' ||
        !COMMIT_PATTERN.test(commit) ||
        !['cannonfile', 'partial'].includes(deploymentMode) ||
        (partialDeployCid !== null &&
          (typeof partialDeployCid !== 'string' ||
            !CID_PATTERN.test(partialDeployCid))) ||
        (deploymentMode === 'partial') !== (partialDeployCid !== null) ||
        typeof previousPackageCid !== 'string' ||
        !CID_PATTERN.test(previousPackageCid) ||
        partialDeployCid === previousPackageCid ||
        typeof safeAddress !== 'string' ||
        !ADDRESS_PATTERN.test(safeAddress)
      ) {
        throw new PreviewError(400, 'INVALID_REQUEST');
      }

      const bundle = await source.bundle({ commit, signal });
      const definition = capability.assembleDefinition(bundle);

      const reader = createArtifactReader({
        fetchImpl,
        getContentCid: capability.getContentCid,
        origin: artifactOrigin,
      });
      const allowedCids = new Set(
        partialDeployCid === null
          ? [previousPackageCid]
          : [previousPackageCid, partialDeployCid],
      );
      const { loader } = capability.createEphemeralOverlay({
        allowedCids,
        baseLoader: capability.createArtifactLoader({
          maximumBytes: MAX_ARTIFACT_BYTES,
          readArtifact: (cid) => reader.read(cid, { signal }),
        }),
      });

      const previousDeployment = await loader.read(
        `ipfs://${previousPackageCid}`,
      );
      const previousFullPackageRef =
        previousPackageReference(previousDeployment);
      const startingDeployment =
        partialDeployCid === null
          ? previousDeployment
          : await loader.read(`ipfs://${partialDeployCid}`);

      const registry = createPreviewRegistry({
        allowedCids,
        fetchImpl,
        mainnetRpcUrl,
        opRpcUrl,
        previousPackage: {
          cid: previousPackageCid,
          fullPackageRef: previousFullPackageRef,
        },
        signal,
      });
      // Nothing after this point is cheap: an Anvil process gets started and a
      // Cannon build runs. If the run has already spent its deadline reading
      // source and artifacts, stop here rather than beginning work whose result
      // cannot be delivered.
      if (signal?.aborted) reject();

      let fork;
      try {
        fork = await startFork({
          fetchImpl,
          safeAddress,
          signal,
          upstreamRpcUrl: rpcUrl,
        });
        let result;
        try {
          result = validateEngineResult(
            await capability.runReadOnlyPreview({
              artifactLoader: loader,
              commit,
              definition,
              deploymentMode,
              partialDeployCid,
              previousPackageCid,
              registry,
              rpc: Object.freeze({ request: fork.request }),
              safeAddress,
              sourceGitUrl: SOURCE_GIT_URL,
              startingDeployment,
            }),
            { commit, partialDeployCid, previousPackageCid, safeAddress },
          );
        } catch (error) {
          // A build failure must never hide a pinned-state failure: the build
          // failed *because* the chain could not serve what it pinned, and that
          // is the fact the caller needs.
          if (fork.prunedState) {
            throw new PreviewError(503, 'RPC_PINNED_STATE_UNAVAILABLE');
          }
          throw error;
        }
        // Checked on the success path too. A build that read partly-pruned
        // state can still "succeed"; that answer would be a reproducibility
        // claim the chain cannot support, so the whole request fails rather
        // than being returned with a caveat.
        if (fork.prunedState) {
          throw new PreviewError(503, 'RPC_PINNED_STATE_UNAVAILABLE');
        }

        return Object.freeze({
          deployerPrerequisites: result.deployerPrerequisites,
          evidence: Object.freeze({
            artifactReads: reader.reads,
            cannon: result.cannon,
            deployerAddress: result.deployerAddress,
            deployerStartingNonce: result.deployerStartingNonce,
            deploymentMode,
            forkBlock: Object.freeze({
              blockHash: fork.forkBlock.blockHash,
              blockNumber: fork.forkBlock.blockNumber,
            }),
            mode: 'fork-pinned-head',
            previousPackageRef: previousFullPackageRef,
            simulationTransactionCount: result.simulationTransactions.length,
            source: Object.freeze({
              bundleSha256: bundle.bundleSha256,
              commit: bundle.commit,
              fileCount: bundle.files.length,
              repository: bundle.repository,
              root: bundle.root,
            }),
          }),
          safeAddress,
          safeProposalCalls: result.safeProposalCalls,
        });
      } catch (error) {
        if (isPreviewError(error)) throw error;
        reject();
      } finally {
        // Disposal must not replace the failure being reported: `stop()` kills
        // a child process and closes a server, either of which can reject, and
        // that rejection would reach the caller as an unmapped error in place
        // of RPC_PINNED_STATE_UNAVAILABLE or PREVIEW_FAILED.
        await fork?.stop().catch(() => undefined);
      }
    },
  });
}
