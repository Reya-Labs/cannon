import { describe, expect, it } from 'vitest';
import { fetchTomlArchive } from '../src/archive';
import { encodeSourceBundle, SOURCE_ROOT } from '../src/bundle';
import { COMMIT } from './fixtures';

const network = process.env.RUN_NETWORK_TESTS === '1' ? describe : describe.skip;

network('real pinned public repository archive', () => {
  it('loads the complete reachable Reya Network include graph', async () => {
    const files = await fetchTomlArchive(COMMIT);
    const encoded = encodeSourceBundle(COMMIT, files);

    expect(encoded.bundle.commit).toBe(COMMIT);
    expect(encoded.bundle.root).toBe(SOURCE_ROOT);
    expect(encoded.bundle.files).toHaveLength(372);
    expect(encoded.bundle.bundleSha256).toBe('d5fd78c3d3774a4b0d51ee570a436ebbde72f415829650c64b99711daa74c689');
    expect(encoded.bundle.files.some(({ path }) => path === SOURCE_ROOT)).toBe(true);
    expect(encoded.bundle.files.every(({ path }) => path.startsWith('packages/tomls/src/'))).toBe(true);
  }, 30_000);
});
