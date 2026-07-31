import { PreviewError } from './errors.mjs';

export const SIMULATOR_MODES = Object.freeze(['disabled']);

/**
 * Selects the preview simulator for this process.
 *
 * The worker ships dormant, matching the rest of the Reya Cannon signer plane:
 * the route exists, is authenticated, bounded and fail-closed, but no
 * simulation runs until a simulator mode is implemented and explicitly
 * selected. A disabled worker still resolves OP package aliases, which needs no
 * fork.
 *
 * The fork-backed simulator — a disposable Anvil fork of Reya Network running
 * the Cannon build against the source gateway and the GCS-backed artifact
 * facade — lands as its own change so that the derivation boundary above can be
 * reviewed on its own terms.
 *
 * @param {{mode: string}} options
 * @returns {import('./preview-runner.mjs').PreviewSimulator}
 */
export function createSimulator({ mode }) {
  if (!SIMULATOR_MODES.includes(mode)) {
    throw new Error(
      `PREVIEW_SIMULATOR_MODE must be one of: ${SIMULATOR_MODES.join(', ')}`,
    );
  }
  return Object.freeze({
    async simulate() {
      throw new PreviewError(503, 'PREVIEW_FAILED');
    },
  });
}
