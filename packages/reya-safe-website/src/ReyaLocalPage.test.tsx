// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReyaLocalPage } from './ReyaLocalPage';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SAFE = '0x1111111111111111111111111111111111111111' as const;
const CID = 'QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn';
const CANNONFILE =
  `https://github.com/Reya-Labs/reya-deployments/blob/${COMMIT}/` +
  'packages/tomls/src/omnibus/reya_network.toml';

const mocks = vi.hoisted(() => ({
  generatePreview: vi.fn(),
  loadDeployment: vi.fn(),
  loadPrevious: vi.fn(),
  parsePreview: vi.fn(),
}));

vi.mock('./clients', () => ({
  createReyaLocalClients: () => ({
    preview: {
      generate: mocks.generatePreview,
    },
    read: {
      artifacts: {},
      registry: {},
      rpc: {},
      source: {
        bundle: vi.fn(async () => ({
          bundleSha256: 'a'.repeat(64),
          commit: COMMIT,
          files: [],
        })),
      },
    },
  }),
}));

vi.mock('@reya/cannon-safe-ui/safe-review', () => ({
  prepareReyaSafeTransaction: () => ({
    safeTxHash: `0x${'b'.repeat(64)}`,
  }),
}));

vi.mock('./safe-state', () => ({
  readReyaSafeState: vi.fn(async () => ({
    nonce: 7,
    owners: [SAFE],
    threshold: 1,
  })),
}));

vi.mock('./deployment-input', () => ({
  immutableCannonfileUrl: () => CANNONFILE,
  normalizeArtifactCid: (value: string) =>
    value === CID || value === `ipfs://${CID}` ? CID : null,
  resolveArtifactInput: mocks.loadPrevious,
  resolveDeploymentSourceInput: mocks.loadDeployment,
}));

vi.mock('./preview', () => ({
  makeStageableSafeTransaction: () => ({
    _nonce: 7,
    baseGas: '0',
    data: '0x1234',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    operation: '1',
    refundReceiver: SAFE,
    safeTxGas: '42',
    to: '0x2222222222222222222222222222222222222222',
    value: '0',
  }),
  parseReyaPreview: mocks.parsePreview,
}));

afterEach(cleanup);

describe('Reya Queue Deployment page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadPrevious.mockResolvedValue({
      cid: CID,
      descriptor: {
        cannonfileUrl: null,
        cid: CID,
        packageRef: 'reya-omnibus:1.2.3@main',
        sourceCommit: null,
        status: 'complete',
        version: '1.2.3',
      },
      inputKind: 'op-registry',
    });
    mocks.generatePreview.mockResolvedValue('{}');
    mocks.parsePreview.mockReturnValue({
      commit: COMMIT,
      deployerPrerequisiteCount: 0,
      partialDeployCid: null,
      previousPackageCid: CID,
      safeAddress: SAFE,
      safeProposalCalls: [
        {
          data: '0x1234',
          from: SAFE,
          gasUsed: '42',
          senderRole: 'safe',
          sequence: 0,
          step: 'Review one call',
          to: '0x3333333333333333333333333333333333333333',
          transactionHash: `0x${'c'.repeat(64)}`,
          value: '0',
        },
      ],
      sourceBundleSha256: 'a'.repeat(64),
    });
  });

  it('locks the form during resolution and invalidates review when an input changes', async () => {
    let finishDeployment!: (value: unknown) => void;
    mocks.loadDeployment.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDeployment = resolve;
        })
    );

    render(
      <ReyaLocalPage
        config={{
          chainId: 1729,
          ingressOrigin: 'http://127.0.0.1:8787',
          safeAddress: SAFE,
          sourceCommit: COMMIT,
        }}
      />
    );

    await screen.findByText('Source, Reya RPC and Safe reads are ready.');
    const deploymentInput = screen.getByLabelText(
      'Deployment data'
    ) as HTMLInputElement;
    const previousInput = screen.getByLabelText(
      'Previous package'
    ) as HTMLInputElement;
    fireEvent.change(deploymentInput, { target: { value: CANNONFILE } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview Transactions to Queue' })
    );

    await waitFor(() => {
      expect(deploymentInput.disabled).toBe(true);
      expect(previousInput.disabled).toBe(true);
    });

    await act(async () => {
      finishDeployment({
        cannonfileUrl: CANNONFILE,
        cid: null,
        descriptor: null,
        inputKind: 'cannonfile',
        sourceCommit: COMMIT,
      });
    });

    await screen.findByText(
      '1 ordered Safe call(s) · 0 deployer prerequisite(s)'
    );
    expect(mocks.generatePreview).toHaveBeenCalledWith({
      commit: COMMIT,
      partialDeployCid: null,
      previousPackageCid: CID,
    });
    expect(screen.queryByLabelText('Cannon preview evidence')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Sign and stage unavailable',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);

    fireEvent.change(deploymentInput, {
      target: { value: `ipfs://${CID}` },
    });

    expect(
      screen.queryByText('1 ordered Safe call(s) · 0 deployer prerequisite(s)')
    ).toBeNull();
    expect(
      screen.getByText('Inputs changed. Generate a new preview before review.')
    ).toBeTruthy();
  });

  it('resumes a partial deployment CID and checks an optional pinned Cannonfile', async () => {
    mocks.loadDeployment.mockResolvedValue({
      cannonfileUrl: null,
      cid: CID,
      descriptor: {
        cannonfileUrl: CANNONFILE,
        cid: CID,
        packageRef: 'reya-omnibus:1.2.4@main',
        sourceCommit: COMMIT,
        status: 'partial',
        version: '1.2.4',
      },
      inputKind: 'cid',
      sourceCommit: COMMIT,
    });
    mocks.parsePreview.mockReturnValue({
      commit: COMMIT,
      deployerPrerequisiteCount: 0,
      partialDeployCid: CID,
      previousPackageCid: CID,
      safeAddress: SAFE,
      safeProposalCalls: [
        {
          data: '0x1234',
          from: SAFE,
          gasUsed: '42',
          senderRole: 'safe',
          sequence: 0,
          step: 'Review one call',
          to: '0x3333333333333333333333333333333333333333',
          transactionHash: `0x${'c'.repeat(64)}`,
          value: '0',
        },
      ],
      sourceBundleSha256: 'a'.repeat(64),
    });

    render(
      <ReyaLocalPage
        config={{
          chainId: 1729,
          ingressOrigin: 'http://127.0.0.1:8787',
          safeAddress: SAFE,
          sourceCommit: COMMIT,
        }}
      />
    );
    await screen.findByText('Source, Reya RPC and Safe reads are ready.');
    fireEvent.change(screen.getByLabelText('Deployment data'), {
      target: { value: `ipfs://${CID}` },
    });
    const comparison = screen.getByLabelText('Comparison Cannonfile');
    fireEvent.change(comparison, { target: { value: CANNONFILE } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Preview Transactions to Queue' })
    );

    await screen.findByText('Partial deployment CID');
    expect(mocks.loadDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        comparisonCannonfileUrl: CANNONFILE,
        input: `ipfs://${CID}`,
      })
    );
    expect(mocks.generatePreview).toHaveBeenCalledWith({
      commit: COMMIT,
      partialDeployCid: CID,
      previousPackageCid: CID,
    });
  });
});
