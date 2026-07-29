import { PackageReference } from '@usecannon/builder';

const CID_URL_PATTERN = /^ipfs:\/\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

function key(reference, chainId) {
  if (
    typeof reference !== 'string' ||
    !Number.isSafeInteger(chainId) ||
    chainId < 1
  ) {
    throw new Error('local QA registry lookup is invalid');
  }
  let canonical;
  try {
    canonical = new PackageReference(reference).fullPackageRef;
  } catch {
    throw new Error('local QA registry lookup is invalid');
  }
  return `${chainId}:${canonical}`;
}

/**
 * Creates a manifest-seeded registry with an ephemeral build overlay.
 *
 * Package reads have no fallback. Writes are process-local and may point only
 * at a CID produced by the preview's ephemeral content-addressed overlay or
 * already present in the verified artifact cache.
 */
export function createLocalQaRegistry({ manifest, verifiedCids }) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    !Array.isArray(manifest.resolutions) ||
    manifest.baseline === null ||
    typeof manifest.baseline !== 'object' ||
    !(verifiedCids instanceof Set)
  ) {
    throw new Error('local QA registry options are invalid');
  }
  const base = new Map();
  for (const resolution of [manifest.baseline, ...manifest.resolutions]) {
    const registryKey = key(
      resolution.fullPackageRef,
      resolution.chainId
    );
    if (base.has(registryKey) || !verifiedCids.has(resolution.deployCid)) {
      throw new Error('local QA registry manifest is invalid');
    }
    base.set(registryKey, `ipfs://${resolution.deployCid}`);
  }
  const overlay = new Map();

  return Object.freeze({
    getLabel() {
      return 'manifest plus ephemeral preview overlay';
    },
    async getAllUrls() {
      return new Set([...base.values(), ...overlay.values()]);
    },
    async getMetaUrl() {
      return null;
    },
    async getUrl(reference, chainId) {
      const registryKey = key(reference, chainId);
      const url = overlay.get(registryKey) ?? base.get(registryKey) ?? null;
      return Object.freeze({
        mutability: url ? 'version' : '',
        url,
      });
    },
    async publish(packageNames, chainId, url) {
      if (
        !Array.isArray(packageNames) ||
        packageNames.length < 1 ||
        packageNames.length > 32 ||
        typeof url !== 'string' ||
        !CID_URL_PATTERN.test(url) ||
        !verifiedCids.has(url.slice('ipfs://'.length))
      ) {
        throw new Error('local QA registry write is outside the ephemeral contract');
      }
      const registryKeys = packageNames.map((reference) =>
        key(reference, chainId)
      );
      if (new Set(registryKeys).size !== registryKeys.length) {
        throw new Error('local QA registry write contains duplicate references');
      }
      const receipts = [];
      for (const registryKey of registryKeys) {
        overlay.set(registryKey, url);
        receipts.push(`local-${receipts.length + 1}`);
      }
      return receipts;
    },
  });
}
