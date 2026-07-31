import { deriveSafeTransaction } from './derive.mjs';
import { PreviewError, isPreviewError } from './errors.mjs';
import { confirmSafeDigest, readSafeState } from './safe-state.mjs';

const PREVIEW_DEADLINE_MS = 240_000;

/**
 * Shape every simulator must satisfy.
 *
 * A simulator receives only immutable, already-validated inputs and returns the
 * ordered Safe calls it observed. It is never handed a browser document, and it
 * never sees the Safe nonce, the derived transaction or the digest — those are
 * computed after it returns, from chain state, so a compromised simulator
 * cannot choose what a signer is asked to sign.
 *
 * @typedef {{
 *   simulate: (input: {
 *     commit: string,
 *     deploymentMode: 'cannonfile' | 'partial',
 *     partialDeployCid: string | null,
 *     previousPackageCid: string,
 *     safeAddress: string,
 *     signal: AbortSignal,
 *   }) => Promise<{
 *     deployerPrerequisites: readonly object[],
 *     evidence: object,
 *     safeAddress: string,
 *     safeProposalCalls: readonly object[],
 *   }>
 * }} PreviewSimulator
 */

function validateSimulation(simulation, request) {
  if (
    simulation === null ||
    typeof simulation !== 'object' ||
    !Array.isArray(simulation.safeProposalCalls) ||
    !Array.isArray(simulation.deployerPrerequisites) ||
    simulation.safeAddress !== request.safeAddress ||
    simulation.evidence === null ||
    typeof simulation.evidence !== 'object'
  ) {
    throw new PreviewError(502, 'PREVIEW_FAILED');
  }
  return simulation;
}

/**
 * Runs one authenticated production preview.
 *
 * The sequence is deliberate: simulate from immutable inputs, then read the
 * live Safe, then derive the transaction and digest locally, then have the Safe
 * contract confirm that digest. Every step the signature depends on happens
 * server-side.
 *
 * Only one preview runs at a time. A concurrent caller is rejected rather than
 * queued, so a burst can never exhaust the fork or RPC budget.
 *
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   rpcUrl: string,
 *   simulator: PreviewSimulator,
 * }} options
 */
export function createPreviewRunner({ fetchImpl, rpcUrl, simulator }) {
  if (
    typeof rpcUrl !== 'string' ||
    rpcUrl.length < 1 ||
    simulator === null ||
    typeof simulator !== 'object' ||
    typeof simulator.simulate !== 'function'
  ) {
    throw new Error('preview runner configuration is invalid');
  }
  let active = false;

  return Object.freeze({
    get busy() {
      return active;
    },
    async run(request) {
      if (active) throw new PreviewError(429, 'PREVIEW_BUSY');
      active = true;
      const deadline = AbortSignal.timeout(PREVIEW_DEADLINE_MS);
      try {
        const simulation = validateSimulation(
          await simulator.simulate({
            commit: request.commit,
            deploymentMode: request.deploymentMode,
            partialDeployCid: request.partialDeployCid,
            previousPackageCid: request.previousPackageCid,
            safeAddress: request.safeAddress,
            signal: deadline,
          }),
          request,
        );

        const safeState = await readSafeState({
          fetchImpl,
          safeAddress: request.safeAddress,
          url: rpcUrl,
        });
        const derived = deriveSafeTransaction(simulation, safeState.nonce);
        await confirmSafeDigest({
          expected: derived.safeTxHash,
          fetchImpl,
          safeAddress: request.safeAddress,
          txn: derived.txn,
          url: rpcUrl,
        });

        return Object.freeze({
          chainId: request.chainId,
          commit: request.commit,
          deployerPrerequisiteCount: simulation.deployerPrerequisites.length,
          derivation: 'server',
          evidence: simulation.evidence,
          partialDeployCid: request.partialDeployCid,
          previousPackageCid: request.previousPackageCid,
          safe: Object.freeze({
            address: request.safeAddress,
            nonce: safeState.nonce,
            owners: safeState.owners,
            threshold: safeState.threshold,
          }),
          safeProposalCalls: simulation.safeProposalCalls,
          safeTxHash: derived.safeTxHash,
          schemaVersion: 1,
          txn: derived.txn,
          type: 'reya-cannon-server-preview',
        });
      } catch (error) {
        if (isPreviewError(error)) throw error;
        throw new PreviewError(502, 'PREVIEW_FAILED');
      } finally {
        active = false;
      }
    },
  });
}
