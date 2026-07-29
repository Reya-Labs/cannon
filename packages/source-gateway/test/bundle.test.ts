import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeSourceBundle, SOURCE_REPOSITORY, SOURCE_ROOT } from '../src/bundle';
import { COMMIT } from './fixtures';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('source bundle', () => {
  it('emits only the deterministic reachable include closure', () => {
    const files = new Map([
      [SOURCE_ROOT, 'include = ["../core/mainnet.toml", "utils/constants.toml"]\nversion = "1"\n'],
      ['packages/tomls/src/core/mainnet.toml', 'include = ["configs/owner.toml"]\n'],
      ['packages/tomls/src/core/configs/owner.toml', '[invoke.owner]\ntarget = ["CoreProxy"]\n'],
      ['packages/tomls/src/omnibus/utils/constants.toml', '[var]\nvalue = "1"\n'],
      ['packages/tomls/src/unreachable.toml', 'secret = "not returned"\n'],
    ]);

    const encoded = encodeSourceBundle(COMMIT, files);

    expect(encoded.bundle).toMatchObject({
      commit: COMMIT,
      repository: SOURCE_REPOSITORY,
      root: SOURCE_ROOT,
      schemaVersion: 1,
    });
    expect(encoded.bundle.files.map(({ path }) => path)).toEqual([
      'packages/tomls/src/core/configs/owner.toml',
      'packages/tomls/src/core/mainnet.toml',
      SOURCE_ROOT,
      'packages/tomls/src/omnibus/utils/constants.toml',
    ]);
    expect(encoded.bundle.files[0].sha256).toBe(sha256(encoded.bundle.files[0].content));
    expect(encoded.etag).toBe(`"sha256-${encoded.bundle.bundleSha256}"`);
    expect(JSON.parse(encoded.body)).toEqual(encoded.bundle);
  });

  it.each([
    ['moving ref', 'main', new Map([[SOURCE_ROOT, 'version = "1"\n']])],
    ['missing root', COMMIT, new Map()],
    ['escaping include', COMMIT, new Map([[SOURCE_ROOT, 'include = ["../../../../secret.toml"]\n']])],
    [
      'include cycle',
      COMMIT,
      new Map([
        [SOURCE_ROOT, 'include = ["cycle.toml"]\n'],
        ['packages/tomls/src/omnibus/cycle.toml', 'include = ["reya_network.toml"]\n'],
      ]),
    ],
    ['malformed TOML', COMMIT, new Map([[SOURCE_ROOT, 'include = [\n']])],
    ['missing include', COMMIT, new Map([[SOURCE_ROOT, 'include = ["missing.toml"]\n']])],
  ] as const)('rejects %s', (_name, commit, files) => {
    expect(() => encodeSourceBundle(commit, files)).toThrow();
  });
});
