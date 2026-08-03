import { SIMULATOR_MODES } from './config.mjs';
import { PreviewError } from './errors.mjs';
import { createForkSimulator } from './simulator/fork-simulator.mjs';

export { SIMULATOR_MODES };

/**
 * Selects the preview simulator for this process.
 *
 * `disabled` keeps the worker dormant: the route stays authenticated, bounded
 * and fail-closed, and OP alias resolution — which needs no fork — still
 * serves. It remains the default, so activating the fork simulator is an
 * explicit deployment decision rather than a consequence of upgrading.
 *
 * `fork` runs the reviewed read-only Cannon build against a disposable Anvil
 * fork of Reya Network, reading source from the cluster-internal gateway and
 * artifacts from the CID-verified facade. It requires the Cannon engine to be
 * present in the image and the Foundry runtime to be installed; both fail
 * closed rather than degrading.
 *
 * @param {{
 *   artifactOrigin?: string,
 *   engine?: object,
 *   fetchImpl?: typeof fetch,
 *   mainnetRpcUrl?: string,
 *   mode: string,
 *   opRpcUrl?: string,
 *   rpcUrl?: string,
 *   sourceOrigin?: string,
 * }} options
 * @returns {import('./preview-runner.mjs').PreviewSimulator}
 */
export function createSimulator({ mode, ...options }) {
  if (!SIMULATOR_MODES.includes(mode)) {
    throw new Error(
      `PREVIEW_SIMULATOR_MODE must be one of: ${SIMULATOR_MODES.join(', ')}`,
    );
  }
  if (mode === 'fork') {
    return createForkSimulator(options);
  }
  return Object.freeze({
    async simulate() {
      throw new PreviewError(503, 'PREVIEW_FAILED');
    },
  });
}
