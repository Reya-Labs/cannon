'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@cannon/components/ui/alert';
import { Button } from '@cannon/components/ui/button';
import { prepareReyaSafeTransaction } from '@reya/cannon-safe-ui/safe-review';
import { createReyaLocalClients } from './clients';
import {
  immutableCannonfileUrl,
  normalizeArtifactCid,
  ResolvedArtifactInput,
  ResolvedDeploymentSource,
  resolveArtifactInput,
  resolveDeploymentSourceInput,
} from './deployment-input';
import {
  makeStageableSafeTransaction,
  parseReyaPreview,
  ReyaPreview,
} from './preview';
import { ReyaLocalProfileConfig } from './profile-config';
import { createReviewExport } from './review-export';
import { readReyaSafeState } from './safe-state';
import { walletTypedData } from './wallet-request';
import { getAddress, isAddress } from 'viem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SafeState = Awaited<ReturnType<typeof readReyaSafeState>>;

type EthereumProvider = {
  on?(event: 'accountsChanged' | 'chainChanged', listener: () => void): void;
  removeListener?(
    event: 'accountsChanged' | 'chainChanged',
    listener: () => void
  ): void;
  request(input: {
    method: string;
    params?: readonly unknown[] | object;
  }): Promise<unknown>;
};

type StagedProposal = Readonly<{
  created: boolean;
  signatureCount: number;
  safeTxHash: `0x${string}`;
}>;

function displayError(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'serviceCode' in error &&
    typeof error.serviceCode === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.serviceCode)
  ) {
    return `STAGING_${error.serviceCode.toUpperCase()}`;
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{1,64}$/.test(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)) {
    return error.message;
  }
  return 'LOCAL_QA_FAILED';
}

export function ReyaLocalPage({ config }: { config: ReyaLocalProfileConfig }) {
  const clients = useMemo(() => createReyaLocalClients(config), [config]);
  const [safeState, setSafeState] = useState<SafeState | null>(null);
  const [preview, setPreview] = useState<ReyaPreview | null>(null);
  const [deploymentSourceInput, setDeploymentSourceInput] = useState('');
  const [comparisonCannonfileInput, setComparisonCannonfileInput] =
    useState('');
  const [previousPackageInput, setPreviousPackageInput] = useState(
    'reya-omnibus:latest@main'
  );
  const [resolvedDeployment, setResolvedDeployment] =
    useState<ResolvedDeploymentSource | null>(null);
  const [resolvedPrevious, setResolvedPrevious] =
    useState<ResolvedArtifactInput | null>(null);
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(
    null
  );
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [stagedProposal, setStagedProposal] = useState<StagedProposal | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading Reya state…');
  const [error, setError] = useState<string | null>(null);
  const formRevision = useRef(0);

  const refresh = useCallback(async () => {
    setError(null);
    const [source, state] = await Promise.all([
      clients.read.source.bundle({ commit: config.sourceCommit }),
      readReyaSafeState(clients.read.rpc, config.safeAddress),
    ]);
    setSafeState(state);
    setStatus('Source, Reya RPC and Safe reads are ready.');
    return { source, state };
  }, [clients, config]);

  useEffect(() => {
    void refresh().catch((cause) => {
      setStatus('Local profile is not ready.');
      setError(displayError(cause));
    });
  }, [refresh]);

  useEffect(() => {
    const provider = (window as unknown as { ethereum?: EthereumProvider })
      .ethereum;
    if (!provider?.on || !provider.removeListener) return;
    const invalidateWallet = () => {
      setWalletAddress(null);
      setReviewAcknowledged(false);
      setStagedProposal(null);
      setStatus('Wallet context changed. Connect and review again.');
    };
    provider.on('accountsChanged', invalidateWallet);
    provider.on('chainChanged', invalidateWallet);
    return () => {
      provider.removeListener?.('accountsChanged', invalidateWallet);
      provider.removeListener?.('chainChanged', invalidateWallet);
    };
  }, []);

  const transaction = useMemo(() => {
    if (!preview || !safeState) return null;
    try {
      return makeStageableSafeTransaction(preview, safeState.nonce);
    } catch {
      return null;
    }
  }, [preview, safeState]);

  const safeTxHash = useMemo(() => {
    if (!transaction) return null;
    try {
      return prepareReyaSafeTransaction({
        safeAddress: config.safeAddress,
        txn: transaction,
      }).safeTxHash;
    } catch {
      return null;
    }
  }, [config.safeAddress, transaction]);

  const reviewExport = useMemo(() => {
    if (
      !preview ||
      !transaction ||
      !safeTxHash ||
      !resolvedDeployment ||
      !resolvedPrevious
    ) {
      return null;
    }
    try {
      return createReviewExport({
        deployment: resolvedDeployment,
        preview,
        previous: resolvedPrevious,
        safeTxHash,
        transaction,
      });
    } catch {
      return null;
    }
  }, [preview, resolvedDeployment, resolvedPrevious, safeTxHash, transaction]);

  const resetPreview = () => {
    setError(null);
    setPreview(null);
    setResolvedDeployment(null);
    setResolvedPrevious(null);
    setReviewAcknowledged(false);
    setStagedProposal(null);
  };

  const invalidatePreview = () => {
    formRevision.current += 1;
    resetPreview();
    setStatus('Inputs changed. Generate a new preview before review.');
  };

  const generateCurrentPreview = async (revision: number) => {
    const deploymentInput = deploymentSourceInput.trim();
    const comparisonCannonfileUrl = comparisonCannonfileInput.trim();
    const previousInput = previousPackageInput.trim();
    const [deployment, previous] = await Promise.all([
      resolveDeploymentSourceInput({
        artifacts: clients.read.artifacts,
        comparisonCannonfileUrl,
        expectedCommit: config.sourceCommit,
        input: deploymentInput,
      }),
      resolveArtifactInput({
        artifacts: clients.read.artifacts,
        input: previousInput,
        registry: clients.read.registry,
        requireComplete: true,
      }),
    ]);
    const source = await clients.read.source.bundle({
      commit: deployment.sourceCommit,
    });
    const generated = await clients.preview.generate({
      commit: deployment.sourceCommit,
      partialDeployCid: deployment.cid,
      previousPackageCid: previous.cid,
    });
    const parsed = parseReyaPreview(generated, {
      commit: deployment.sourceCommit,
      partialDeployCid: deployment.cid,
      previousPackageCid: previous.cid,
      safeAddress: config.safeAddress,
      sourceBundleSha256: source.bundleSha256,
    });
    const state = await readReyaSafeState(clients.read.rpc, config.safeAddress);
    if (revision !== formRevision.current) {
      throw new Error('PREVIEW_INPUT_CHANGED');
    }
    const nextTransaction =
      parsed.deployerPrerequisiteCount === 0
        ? makeStageableSafeTransaction(parsed, state.nonce)
        : null;
    const nextSafeTxHash = nextTransaction
      ? prepareReyaSafeTransaction({
          safeAddress: config.safeAddress,
          txn: nextTransaction,
        }).safeTxHash
      : null;
    const nextReview =
      nextTransaction && nextSafeTxHash
        ? createReviewExport({
            deployment,
            preview: parsed,
            previous,
            safeTxHash: nextSafeTxHash,
            transaction: nextTransaction,
          })
        : null;
    return Object.freeze({
      deployment,
      preview: parsed,
      previous,
      review: nextReview,
      safeState: state,
      safeTxHash: nextSafeTxHash,
      transaction: nextTransaction,
    });
  };

  const applyGeneratedPreview = (
    generated: Awaited<ReturnType<typeof generateCurrentPreview>>
  ) => {
    setResolvedDeployment(generated.deployment);
    setResolvedPrevious(generated.previous);
    setPreview(generated.preview);
    setSafeState(generated.safeState);
  };

  const previewTransactions = async () => {
    const revision = formRevision.current;
    setBusy(true);
    resetPreview();
    try {
      const generated = await generateCurrentPreview(revision);
      applyGeneratedPreview(generated);
      setStatus('Generated a current-state local Cannon preview for review.');
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  const currentWallet = async (
    provider: EthereumProvider,
    state: SafeState,
    requestAccess: boolean
  ): Promise<`0x${string}`> => {
    const accounts = await provider.request({
      method: requestAccess ? 'eth_requestAccounts' : 'eth_accounts',
    });
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (
      chainId !== '0x6c1' ||
      !Array.isArray(accounts) ||
      accounts.length < 1 ||
      typeof accounts[0] !== 'string' ||
      !isAddress(accounts[0])
    ) {
      throw new Error('WALLET_CONTEXT_REJECTED');
    }
    const address = getAddress(accounts[0]).toLowerCase() as `0x${string}`;
    if (!state.owners.includes(address)) {
      throw new Error('WALLET_IS_NOT_CURRENT_SAFE_OWNER');
    }
    return address;
  };

  const connectWallet = async () => {
    setError(null);
    try {
      const provider = (window as unknown as { ethereum?: EthereumProvider })
        .ethereum;
      if (!provider) throw new Error('INJECTED_WALLET_REQUIRED');
      if (!safeState) throw new Error('SAFE_STATE_UNAVAILABLE');
      const address = await currentWallet(provider, safeState, true);
      setWalletAddress(address);
      setReviewAcknowledged(false);
      setStagedProposal(null);
      setStatus('A current Safe owner wallet is connected.');
    } catch (cause) {
      setWalletAddress(null);
      setError(displayError(cause));
    }
  };

  const downloadReview = () => {
    if (!reviewExport) {
      setError('REVIEW_EXPORT_UNAVAILABLE');
      return;
    }
    const url = URL.createObjectURL(
      new Blob([reviewExport.json], { type: 'application/json' })
    );
    try {
      const anchor = document.createElement('a');
      anchor.download = reviewExport.filename;
      anchor.href = url;
      anchor.rel = 'noopener';
      anchor.click();
      setStatus('Downloaded a review-only Cannon Safe snapshot.');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const signAndStage = async () => {
    const activation = clients.activation;
    const provider = (window as unknown as { ethereum?: EthereumProvider })
      .ethereum;
    const reviewed = reviewExport;
    const revision = formRevision.current;
    setError(null);
    setStagedProposal(null);
    if (!activation) {
      setError('LOCAL_STAGING_DISABLED');
      return;
    }
    if (!provider || !walletAddress || !reviewAcknowledged || !reviewed) {
      setError('SIGNING_PREREQUISITES_MISSING');
      return;
    }

    setBusy(true);
    try {
      const regenerated = await generateCurrentPreview(revision);
      applyGeneratedPreview(regenerated);
      if (
        !regenerated.review ||
        !regenerated.transaction ||
        regenerated.review.json !== reviewed.json
      ) {
        setReviewAcknowledged(false);
        throw new Error('PREVIEW_CHANGED_REVIEW_REQUIRED');
      }
      const ownerAddress = await currentWallet(
        provider,
        regenerated.safeState,
        false
      );
      if (ownerAddress !== walletAddress) {
        setWalletAddress(null);
        setReviewAcknowledged(false);
        throw new Error('WALLET_CONTEXT_REJECTED');
      }
      const signing = activation.createSigningClient(async (request) => {
        const encoded = walletTypedData(
          request,
          ownerAddress,
          config.safeAddress
        );
        const signature = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [ownerAddress, encoded],
        });
        if (typeof signature !== 'string') {
          throw new Error('WALLET_REQUEST_FAILED');
        }
        return signature;
      });
      const prepared = signing.prepare({ txn: regenerated.transaction });
      if (prepared.safeTxHash !== reviewed.value.safe.transactionHash) {
        setReviewAcknowledged(false);
        throw new Error('PREVIEW_CHANGED_REVIEW_REQUIRED');
      }
      const signed = await signing.sign({
        ownerAddress,
        prepared,
      });
      if (signed.safeTxHash !== reviewed.value.safe.transactionHash) {
        throw new Error('SIGNATURE_REJECTED');
      }
      const result = await activation.staging.submitSignature({
        signature: signed.signature,
        txn: regenerated.transaction,
      });
      setStagedProposal(
        Object.freeze({
          created: result.created,
          safeTxHash: signed.safeTxHash,
          signatureCount: result.proposal.sigs.length,
        })
      );
      setStatus(
        result.created
          ? 'Created the local canary Safe proposal.'
          : 'Added this owner signature to the local canary Safe proposal.'
      );
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#090b0f] text-slate-100">
      <div className="mx-auto max-w-[96rem] px-5 py-8 md:px-8">
        <header className="mb-6 flex flex-col justify-between gap-3 border-b border-slate-800 pb-5 md:flex-row md:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
              Reya · Cannon Safe staging
            </p>
            <h1 className="text-2xl font-semibold">Queue Deployment</h1>
            <p className="mt-2 text-xs text-slate-500">
              {config.stagingEnabled
                ? 'Local canary signing and proposal staging are enabled. Execution and broadcast remain unavailable.'
                : 'This review-only profile has no signing, staging, execution or broadcast method.'}
            </p>
          </div>
          <div className="text-xs text-slate-500 md:text-right">
            <p>
              {config.stagingEnabled
                ? 'Local canary · staging enabled · execution disabled'
                : 'Review only · signing disabled · publishing disabled'}
            </p>
            <p className="mt-1">
              Safe nonce {safeState?.nonce ?? '—'} · threshold{' '}
              {safeState?.threshold ?? '—'} of {safeState?.owners.length ?? '—'}{' '}
            </p>
          </div>
        </header>

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>Fail-closed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-950 p-6 md:p-8">
          <div className="space-y-6">
            <label className="block">
              <span className="mb-2 block text-sm font-medium">
                Enter Cannonfile URL or partial deployment CID
              </span>
              <span className="relative block">
                <input
                  aria-label="Deployment data"
                  className="block w-full rounded-lg border border-slate-700 bg-[#090b0f] px-4 py-3 pr-12 text-sm outline-none focus:border-slate-400"
                  disabled={busy}
                  onChange={(event) => {
                    setDeploymentSourceInput(event.target.value);
                    invalidatePreview();
                  }}
                  placeholder={immutableCannonfileUrl(config.sourceCommit)}
                  spellCheck={false}
                  value={deploymentSourceInput}
                />
                {resolvedDeployment && (
                  <span
                    aria-label="Deployment data resolved"
                    className="absolute right-4 top-3 text-emerald-400"
                  >
                    ✓
                  </span>
                )}
              </span>
              {resolvedDeployment && (
                <span className="mt-2 block break-all text-xs text-slate-400">
                  {resolvedDeployment.inputKind === 'cannonfile'
                    ? `Pinned source · ${resolvedDeployment.cannonfileUrl}`
                    : `Partial ${resolvedDeployment.descriptor.packageRef} · ${resolvedDeployment.cid}`}
                </span>
              )}
              <span className="mt-2 block text-xs text-slate-500">
                A Cannonfile starts from the previous complete package. A
                partial deployment CID resumes the exact state produced by the
                EOA deployment and authenticates its pinned source commit.
              </span>
            </label>

            {normalizeArtifactCid(deploymentSourceInput.trim()) !== null && (
              <label className="block">
                <span className="mb-2 block text-sm font-medium">
                  Cannonfile (Optional)
                </span>
                <input
                  aria-label="Comparison Cannonfile"
                  className="block w-full rounded-lg border border-slate-700 bg-[#090b0f] px-4 py-3 text-sm outline-none focus:border-slate-400"
                  disabled={busy}
                  onChange={(event) => {
                    setComparisonCannonfileInput(event.target.value);
                    invalidatePreview();
                  }}
                  placeholder="Pinned Reya deployments Cannonfile URL"
                  spellCheck={false}
                  value={comparisonCannonfileInput}
                />
                <span className="mt-2 block text-xs text-slate-500">
                  Optional review aid. If supplied, it must exactly match the
                  source repository and commit embedded in the partial
                  deployment artifact.
                </span>
              </label>
            )}

            <label className="block">
              <span className="mb-2 block text-sm font-medium">
                Previous Package
              </span>
              <span className="relative block">
                <input
                  aria-label="Previous package"
                  className="block w-full rounded-lg border border-slate-700 bg-[#090b0f] px-4 py-3 pr-12 text-sm outline-none focus:border-slate-400"
                  disabled={busy}
                  onChange={(event) => {
                    setPreviousPackageInput(event.target.value);
                    invalidatePreview();
                  }}
                  placeholder="reya-omnibus:latest@main or ipfs://Qm…"
                  spellCheck={false}
                  value={previousPackageInput}
                />
                {resolvedPrevious && (
                  <span
                    aria-label="Previous package resolved"
                    className="absolute right-4 top-3 text-emerald-400"
                  >
                    ✓
                  </span>
                )}
              </span>
              <span className="mt-2 block text-xs text-slate-500">
                OP Mainnet aliases are resolved once per preview and pinned to
                the exact version and CID shown here. Exact CID input bypasses
                OP.
              </span>
              {resolvedPrevious && (
                <span className="mt-2 block break-all text-xs text-slate-300">
                  Resolved {resolvedPrevious.descriptor.packageRef} ·{' '}
                  {resolvedPrevious.cid}
                </span>
              )}
            </label>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                disabled={busy}
                onClick={() => void connectWallet()}
                type="button"
                variant="outline"
              >
                {walletAddress ? 'Owner wallet connected' : 'Connect wallet'}
              </Button>
              <Button
                className="flex-1"
                disabled={
                  busy ||
                  deploymentSourceInput.trim() === '' ||
                  previousPackageInput.trim() === ''
                }
                onClick={() => void previewTransactions()}
                type="button"
              >
                {busy
                  ? 'Building and simulating…'
                  : 'Preview Transactions to Queue'}
              </Button>
            </div>
          </div>

          {preview && (
            <div className="mt-8 space-y-3 border-t border-slate-800 pt-6 text-sm">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p>
                  {preview.safeProposalCalls.length} ordered Safe call(s) ·{' '}
                  {preview.deployerPrerequisiteCount} deployer prerequisite(s)
                </p>
                <Button
                  disabled={!reviewExport}
                  onClick={downloadReview}
                  type="button"
                  variant="outline"
                >
                  Download review JSON
                </Button>
              </div>
              <dl className="grid gap-3 rounded-lg border border-slate-800 bg-[#090b0f] p-4 text-xs md:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Source commit</dt>
                  <dd className="break-all">{preview.commit}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Previous package</dt>
                  <dd className="break-all">
                    {resolvedPrevious?.descriptor.packageRef ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Previous package CID</dt>
                  <dd className="break-all">{preview.previousPackageCid}</dd>
                </div>
                {preview.partialDeployCid && (
                  <div>
                    <dt className="text-slate-500">Partial deployment CID</dt>
                    <dd className="break-all">{preview.partialDeployCid}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-slate-500">Chain · Safe · nonce</dt>
                  <dd className="break-all">
                    1729 · {config.safeAddress} · {safeState?.nonce ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Simulation</dt>
                  <dd className="text-amber-300">
                    automatic current-state local build
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Safe transaction hash</dt>
                  <dd className="break-all">{safeTxHash ?? '—'}</dd>
                </div>
              </dl>
              <ol aria-label="Ordered Safe calls" className="space-y-2">
                {preview.safeProposalCalls.map((call) => (
                  <li
                    className="rounded border border-slate-800 bg-slate-900 p-3"
                    key={call.transactionHash}
                  >
                    <p>
                      #{call.sequence} {call.step}
                    </p>
                    <dl className="mt-2 grid gap-2 text-xs">
                      <div>
                        <dt className="text-slate-500">Target</dt>
                        <dd>
                          <code className="break-all">{call.to}</code>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Value</dt>
                        <dd>
                          <code>{call.value}</code>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">
                          Simulation transaction
                        </dt>
                        <dd>
                          <code className="break-all">
                            {call.transactionHash}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Decoded calldata</dt>
                        {call.decoded ? (
                          <dd
                            aria-label={`Decoded calldata for ${call.step}`}
                            className="mt-1 space-y-2 rounded bg-slate-950 p-2"
                          >
                            <code className="break-all text-cyan-200">
                              {call.decoded.function}
                            </code>
                            <ol className="space-y-2">
                              {call.decoded.arguments.map((argument, index) => (
                                <li key={index}>
                                  <span className="text-slate-500">
                                    Argument {index}
                                  </span>
                                  <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-slate-200">
                                    <code>
                                      {JSON.stringify(argument, null, 2)}
                                    </code>
                                  </pre>
                                </li>
                              ))}
                            </ol>
                          </dd>
                        ) : (
                          <dd className="text-slate-500">
                            No ABI decode is available for this action type.
                          </dd>
                        )}
                      </div>
                      <details>
                        <summary className="cursor-pointer text-slate-500">
                          Calldata ({(call.data.length - 2) / 2} bytes)
                        </summary>
                        <div className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-2">
                          <code className="break-all">{call.data}</code>
                        </div>
                      </details>
                    </dl>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>

        {preview && (
          <>
            <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950 p-5">
              <h2 className="mb-2 text-lg font-medium">
                2. Safe transaction to sign
              </h2>
              <p className="mb-4 text-sm text-slate-400">
                The calls above are wrapped into this single Safe transaction.
                The wallet must sign the exact hash shown here.
              </p>
              <dl className="grid gap-3 text-sm md:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Current Safe nonce</dt>
                  <dd>{transaction?._nonce ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Safe transaction hash</dt>
                  <dd>
                    <code className="break-all text-xs">
                      {safeTxHash ?? '—'}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Multicall target</dt>
                  <dd>
                    <code className="text-xs">{transaction?.to ?? '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Operation</dt>
                  <dd>DELEGATECALL ({transaction?.operation ?? '—'})</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Value</dt>
                  <dd>
                    <code>{transaction?.value ?? '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Safe transaction gas</dt>
                  <dd>
                    <code>{transaction?.safeTxGas ?? '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Wallet</dt>
                  <dd>
                    {walletAddress ? (
                      <code className="text-xs">{walletAddress}</code>
                    ) : (
                      'not connected'
                    )}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-5">
              <h2 className="mb-2 text-lg font-medium">3. Sign and stage</h2>
              {config.stagingEnabled ? (
                <>
                  <p className="mb-4 text-sm text-amber-200">
                    Local canary only. Before the wallet opens, the source,
                    artifacts, ordered calls, Safe state and transaction hash
                    are regenerated and must exactly match this review. Staging
                    stores a proposal signature; it cannot execute or broadcast
                    the Safe transaction.
                  </p>
                  <label className="mb-4 flex items-start gap-3 text-sm">
                    <input
                      checked={reviewAcknowledged}
                      className="mt-1"
                      disabled={busy || !transaction || !walletAddress}
                      onChange={(event) => {
                        setReviewAcknowledged(event.target.checked);
                        setStagedProposal(null);
                      }}
                      type="checkbox"
                    />
                    <span>
                      I reviewed the ordered calls and Safe transaction hash{' '}
                      <code className="break-all text-xs">
                        {safeTxHash ?? '—'}
                      </code>
                    </span>
                  </label>
                  <Button
                    disabled={
                      busy ||
                      !reviewAcknowledged ||
                      !walletAddress ||
                      !transaction ||
                      !reviewExport
                    }
                    onClick={() => void signAndStage()}
                    type="button"
                  >
                    {busy ? 'Revalidating…' : 'Sign and stage local proposal'}
                  </Button>
                  {stagedProposal && (
                    <div className="mt-4 rounded border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
                      {stagedProposal.created
                        ? 'Local proposal created'
                        : 'Signature added'}{' '}
                      · {stagedProposal.signatureCount} signature(s) ·{' '}
                      <code className="break-all text-xs">
                        {stagedProposal.safeTxHash}
                      </code>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="mb-4 text-sm text-amber-200">
                    Disabled in this profile. Enable the explicit local canary
                    only with the fixed staging backend and trusted ingress.
                  </p>
                  <Button disabled type="button">
                    Sign and stage unavailable
                  </Button>
                </>
              )}
            </section>
          </>
        )}

        <footer className="mt-6 text-xs text-slate-500">{status}</footer>
      </div>
    </main>
  );
}
