import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { getContentCID } from '@usecannon/artifact-codec';
import {
  immutableCannonfileUrl,
  loadDeploymentDescriptor,
  normalizeArtifactCid,
  resolveArtifactInput,
  resolveDeploymentSourceInput,
} from './deployment-input';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

async function artifact(status: 'complete' | 'partial' = 'complete') {
  const bytes = deflateSync(
    JSON.stringify({
      chainId: 1729,
      def: {
        name: 'reya-omnibus',
        preset: 'main',
        version: '1.2.3',
      },
      meta: {
        commitHash: COMMIT,
        gitUrl: 'https://github.com/Reya-Labs/reya-deployments',
      },
      status,
    })
  );
  return { bytes, cid: await getContentCID(bytes) };
}

describe('queue deployment input', () => {
  it('normalizes only exact CIDv0 input', () => {
    const cid = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
    expect(normalizeArtifactCid(cid)).toBe(cid);
    expect(normalizeArtifactCid(`ipfs://${cid}`)).toBe(cid);
    expect(normalizeArtifactCid(`https://repo.usecannon.com/${cid}`)).toBeNull();
    expect(normalizeArtifactCid('bafybeigdyrzt')).toBeNull();
  });

  it('loads and validates one CID-bound Reya deployment descriptor', async () => {
    const value = await artifact();
    const artifacts = {
      cat: vi.fn(async () => value.bytes),
    };
    await expect(
      loadDeploymentDescriptor(artifacts, value.cid, {
        requireComplete: true,
      })
    ).resolves.toEqual({
      cannonfileUrl: null,
      cid: value.cid,
      packageRef: 'reya-omnibus:1.2.3@main',
      sourceCommit: null,
      status: 'complete',
      version: '1.2.3',
    });
    expect(artifacts.cat).toHaveBeenCalledWith({ cid: value.cid });
  });

  it('resolves an OP alias once and exposes its exact CID and version', async () => {
    const value = await artifact();
    const registry = {
      resolve: vi.fn(async () => ({
        cid: value.cid,
        mutability: 'tag' as const,
        packageRef: 'reya-omnibus:latest@main',
      })),
    };
    const result = await resolveArtifactInput({
      artifacts: { cat: vi.fn(async () => value.bytes) },
      input: 'reya-omnibus:latest@main',
      registry,
      requireComplete: true,
    });
    expect(result).toEqual({
      cid: value.cid,
      descriptor: {
        cannonfileUrl: null,
        cid: value.cid,
        packageRef: 'reya-omnibus:1.2.3@main',
        sourceCommit: null,
        status: 'complete',
        version: '1.2.3',
      },
      inputKind: 'op-registry',
    });
    expect(registry.resolve).toHaveBeenCalledOnce();
  });

  it('binds an exact OP version alias to the artifact declaration', async () => {
    const value = await artifact();
    const registry = {
      resolve: vi.fn(async () => ({
        cid: value.cid,
        mutability: 'version' as const,
        packageRef: 'reya-omnibus:1.2.4@main',
      })),
    };
    await expect(
      resolveArtifactInput({
        artifacts: { cat: vi.fn(async () => value.bytes) },
        input: 'reya-omnibus:1.2.4@main',
        registry,
      })
    ).rejects.toThrow('OP_ALIAS_ARTIFACT_MISMATCH');
  });

  it('binds latest and exact-version aliases to their expected registry mutability', async () => {
    const value = await artifact();
    for (const [input, mutability] of [
      ['reya-omnibus:latest@main', 'version'],
      ['reya-omnibus:1.2.3@main', 'tag'],
    ] as const) {
      await expect(
        resolveArtifactInput({
          artifacts: { cat: vi.fn(async () => value.bytes) },
          input,
          registry: {
            resolve: vi.fn(async () => ({
              cid: value.cid,
              mutability,
              packageRef: input,
            })),
          },
        })
      ).rejects.toThrow('OP_ALIAS_MUTABILITY_MISMATCH');
    }
  });

  it('uses exact CID fallback without touching OP', async () => {
    const value = await artifact('partial');
    const registry = { resolve: vi.fn() };
    const result = await resolveArtifactInput({
      artifacts: { cat: vi.fn(async () => value.bytes) },
      input: `ipfs://${value.cid}`,
      registry,
    });
    expect(result.cid).toBe(value.cid);
    expect(result.inputKind).toBe('cid');
    expect(result.descriptor.status).toBe('partial');
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('keeps deployment-source modes separate from previous-package aliases', async () => {
    const cannonfileUrl = immutableCannonfileUrl(COMMIT);
    const artifacts = { cat: vi.fn() };
    await expect(
      resolveDeploymentSourceInput({
        artifacts,
        expectedCommit: COMMIT,
        input: cannonfileUrl,
      })
    ).resolves.toEqual({
      cannonfileUrl,
      cid: null,
      descriptor: null,
      inputKind: 'cannonfile',
      sourceCommit: COMMIT,
    });
    expect(artifacts.cat).not.toHaveBeenCalled();

    await expect(
      resolveDeploymentSourceInput({
        artifacts,
        expectedCommit: COMMIT,
        input: 'reya-omnibus:latest@main',
      })
    ).rejects.toThrow('DEPLOYMENT_SOURCE_INVALID');
  });

  it('validates exact-CID deployment sources through the artifact loader', async () => {
    const value = await artifact('partial');
    const result = await resolveDeploymentSourceInput({
      artifacts: { cat: vi.fn(async () => value.bytes) },
      expectedCommit: COMMIT,
      input: `ipfs://${value.cid}`,
    });
    expect(result).toEqual({
      cannonfileUrl: null,
      cid: value.cid,
      descriptor: {
        cannonfileUrl: immutableCannonfileUrl(COMMIT),
        cid: value.cid,
        packageRef: 'reya-omnibus:1.2.3@main',
        sourceCommit: COMMIT,
        status: 'partial',
        version: '1.2.3',
      },
      inputKind: 'cid',
      sourceCommit: COMMIT,
    });
  });

  it('authenticates partial deployment provenance and optional Cannonfile comparison', async () => {
    const value = await artifact('partial');
    const cannonfileUrl = immutableCannonfileUrl(COMMIT);
    await expect(
      resolveDeploymentSourceInput({
        artifacts: { cat: vi.fn(async () => value.bytes) },
        comparisonCannonfileUrl: cannonfileUrl,
        expectedCommit: 'fedcba9876543210fedcba9876543210fedcba98',
        input: value.cid,
      })
    ).resolves.toMatchObject({
      cid: value.cid,
      inputKind: 'cid',
      sourceCommit: COMMIT,
    });
    await expect(
      resolveDeploymentSourceInput({
        artifacts: { cat: vi.fn(async () => value.bytes) },
        comparisonCannonfileUrl: immutableCannonfileUrl('fedcba9876543210fedcba9876543210fedcba98'),
        expectedCommit: COMMIT,
        input: value.cid,
      })
    ).rejects.toThrow('CANNONFILE_PROVENANCE_MISMATCH');
  });

  it('rejects a complete artifact or untrusted provenance as a deployment checkpoint', async () => {
    const complete = await artifact('complete');
    await expect(
      resolveDeploymentSourceInput({
        artifacts: { cat: vi.fn(async () => complete.bytes) },
        expectedCommit: COMMIT,
        input: complete.cid,
      })
    ).rejects.toThrow('DEPLOYMENT_SOURCE_REQUIRES_PARTIAL_ARTIFACT');

    const encoded = deflateSync(
      JSON.stringify({
        chainId: 1729,
        def: {
          name: 'reya-omnibus',
          preset: 'main',
          version: '1.2.3',
        },
        meta: {
          commitHash: COMMIT,
          gitUrl: 'https://attacker.example/reya-deployments',
        },
        status: 'partial',
      })
    );
    const cid = await getContentCID(encoded);
    await expect(
      resolveDeploymentSourceInput({
        artifacts: { cat: vi.fn(async () => encoded) },
        expectedCommit: COMMIT,
        input: cid,
      })
    ).rejects.toThrow('ARTIFACT_PROVENANCE_REJECTED');
  });

  it('rejects incomplete previous packages, oversized versions and CID mismatches', async () => {
    const value = await artifact('partial');
    await expect(
      loadDeploymentDescriptor({ cat: vi.fn(async () => value.bytes) }, value.cid, { requireComplete: true })
    ).rejects.toThrow('ARTIFACT_SCHEMA_REJECTED');
    await expect(
      loadDeploymentDescriptor(
        {
          cat: vi.fn(async () => new Uint8Array([1, 2, 3])),
        },
        value.cid
      )
    ).rejects.toThrow('ARTIFACT_UNAVAILABLE');

    const oversizedVersionBytes = deflateSync(
      JSON.stringify({
        chainId: 1729,
        def: {
          name: 'reya-omnibus',
          preset: 'main',
          version: `1.2.3-${'a'.repeat(27)}`,
        },
        status: 'complete',
      })
    );
    const oversizedVersionCid = await getContentCID(oversizedVersionBytes);
    await expect(
      loadDeploymentDescriptor(
        {
          cat: vi.fn(async () => oversizedVersionBytes),
        },
        oversizedVersionCid
      )
    ).rejects.toThrow('ARTIFACT_SCHEMA_REJECTED');
  });

  it('classifies OP unknown and unavailable failures without exposing provider details', async () => {
    const artifacts = { cat: vi.fn() };
    for (const [code, expected] of [
      ['OP_ALIAS_UNKNOWN', 'OP_ALIAS_UNKNOWN'],
      ['REQUEST_FAILED', 'OP_REGISTRY_UNAVAILABLE'],
    ] as const) {
      await expect(
        resolveArtifactInput({
          artifacts,
          input: 'reya-omnibus:latest@main',
          registry: {
            resolve: vi.fn(async () => {
              throw Object.assign(new Error('provider private-token'), {
                code,
              });
            }),
          },
        })
      ).rejects.toThrow(expected);
    }
    expect(artifacts.cat).not.toHaveBeenCalled();
  });
});
