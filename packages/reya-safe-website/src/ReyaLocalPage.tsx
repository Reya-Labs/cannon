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
import { readReyaSafeState } from './safe-state';
import { getAddress, isAddress } from 'viem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type SafeState = Awaited<ReturnType<typeof readReyaSafeState>>;

type EthereumProvider = {
  request(input: {
    method: string;
    params?: readonly unknown[] | object;
  }): Promise<unknown>;
};

function displayError(error: unknown): string {
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
  const [sourceDigest, setSourceDigest] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReyaPreview | null>(null);
  const [deploymentSourceInput, setDeploymentSourceInput] = useState('');
  const [previousPackageInput, setPreviousPackageInput] = useState(
    'reya-omnibus:latest@main'
  );
  const [previewEvidence, setPreviewEvidence] = useState<File | null>(null);
  const [resolvedDeployment, setResolvedDeployment] =
    useState<ResolvedDeploymentSource | null>(null);
  const [resolvedPrevious, setResolvedPrevious] =
    useState<ResolvedArtifactInput | null>(null);
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(
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
    setSourceDigest(source.bundleSha256);
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

  const resetPreview = () => {
    setError(null);
    setPreview(null);
    setResolvedDeployment(null);
    setResolvedPrevious(null);
  };

  const invalidatePreview = () => {
    formRevision.current += 1;
    resetPreview();
    setStatus('Inputs changed. Generate a new preview before review.');
  };

  const previewTransactions = async () => {
    const revision = formRevision.current;
    const deploymentInput = deploymentSourceInput.trim();
    const previousInput = previousPackageInput.trim();
    const file = previewEvidence;
    setBusy(true);
    resetPreview();
    if (!file || file.size < 2 || file.size > 16 * 1024 * 1024) {
      setError('PREVIEW_REJECTED');
      setBusy(false);
      return;
    }
    try {
      if (!sourceDigest) throw new Error('SOURCE_NOT_READY');
      const [deployment, previous] = await Promise.all([
        resolveDeploymentSourceInput({
          artifacts: clients.read.artifacts,
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
      const parsed = parseReyaPreview(await file.text(), {
        commit: config.sourceCommit,
        previousDeployCid: previous.cid,
        safeAddress: config.safeAddress,
      });
      if (parsed.sourceBundleSha256 !== sourceDigest) {
        throw new Error('SOURCE_DIGEST_MISMATCH');
      }
      if (revision !== formRevision.current) {
        throw new Error('PREVIEW_INPUT_CHANGED');
      }
      setResolvedDeployment(deployment);
      setResolvedPrevious(previous);
      setPreview(parsed);
      setStatus(
        deployment.inputKind === 'cannonfile'
          ? 'Imported preview evidence passed structural and public-provenance checks for review.'
          : 'Deployment CID validated for plumbing QA. Imported preview evidence remains review-only.'
      );
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  const connectWallet = async () => {
    setError(null);
    try {
      const provider = (window as unknown as { ethereum?: EthereumProvider })
        .ethereum;
      if (!provider) throw new Error('INJECTED_WALLET_REQUIRED');
      const [chainId, accounts] = await Promise.all([
        provider.request({ method: 'eth_chainId' }),
        provider.request({ method: 'eth_requestAccounts' }),
      ]);
      if (
        chainId !== '0x6c1' ||
        !Array.isArray(accounts) ||
        accounts.length !== 1 ||
        typeof accounts[0] !== 'string' ||
        !isAddress(accounts[0])
      ) {
        throw new Error('WALLET_CONTEXT_REJECTED');
      }
      const address = getAddress(accounts[0]).toLowerCase() as `0x${string}`;
      if (!safeState?.owners.includes(address)) {
        throw new Error('WALLET_IS_NOT_CURRENT_SAFE_OWNER');
      }
      setWalletAddress(address);
      setStatus('A current Safe owner wallet is connected.');
    } catch (cause) {
      setWalletAddress(null);
      setError(displayError(cause));
    }
  };

  return (
    <main className="min-h-screen bg-[#090b0f] text-slate-100">
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-8">
        <header className="mb-6 flex flex-col justify-between gap-3 border-b border-slate-800 pb-5 md:flex-row md:items-end">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
              Reya · Cannon Safe staging
            </p>
            <h1 className="text-2xl font-semibold">Queue Deployment</h1>
            <p className="mt-2 text-xs text-slate-500">
              This review-only profile has no signing, staging, execution or
              broadcast method.
            </p>
          </div>
          <div className="text-xs text-slate-500 md:text-right">
            <p>Review only · signing disabled · publishing disabled</p>
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
                Enter Cannonfile URL or deployment data IPFS hash
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
                  placeholder={`${immutableCannonfileUrl(
                    config.sourceCommit
                  )} or ipfs://Qm…`}
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
                    : `${resolvedDeployment.descriptor.packageRef} · ${resolvedDeployment.cid}`}
                </span>
              )}
            </label>

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

            <label className="block">
              <span className="mb-2 block text-sm font-medium">
                Local preview evidence
              </span>
              <input
                aria-label="Cannon preview evidence"
                accept="application/json,.json"
                className="block w-full rounded-lg border border-slate-700 bg-[#090b0f] p-3 text-sm"
                disabled={busy}
                onChange={(event) => {
                  setPreviewEvidence(event.target.files?.[0] ?? null);
                  invalidatePreview();
                }}
                type="file"
              />
              <span className="mt-2 block text-xs text-slate-500">
                Temporary local-QA bridge: select the JSON produced by{' '}
                <code>pnpm --filter @reya/cannon-safe-ui preview:local</code>.
                This imported file is review-only: the production preview worker
                must recompute and authenticate the result before any signing or
                staging capability is enabled.
              </span>
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
                  previousPackageInput.trim() === '' ||
                  previewEvidence === null
                }
                onClick={() => void previewTransactions()}
                type="button"
              >
                {busy
                  ? 'Resolving and verifying…'
                  : 'Preview Transactions to Queue'}
              </Button>
            </div>
          </div>

          {preview && (
            <div className="mt-8 space-y-3 border-t border-slate-800 pt-6 text-sm">
              {resolvedDeployment?.inputKind === 'cid' && (
                <Alert className="border-amber-800 bg-amber-950/30 text-amber-100">
                  <AlertTitle>Read-only CID validation</AlertTitle>
                  <AlertDescription>
                    The imported local preview is bound to the pinned source
                    commit, not this deployment-data CID. Review is available,
                    but signing stays disabled until the preview worker emits
                    evidence bound to the exact CID.
                  </AlertDescription>
                </Alert>
              )}
              <p>
                {preview.safeProposalCalls.length} ordered Safe call(s) ·{' '}
                {preview.deployerPrerequisiteCount} deployer prerequisite(s)
              </p>
              <dl className="grid gap-3 rounded-lg border border-slate-800 bg-[#090b0f] p-4 text-xs md:grid-cols-2">
                <div>
                  <dt className="text-slate-500">Source commit</dt>
                  <dd className="break-all">{config.sourceCommit}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Previous package</dt>
                  <dd className="break-all">
                    {resolvedPrevious?.descriptor.packageRef ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Previous CID</dt>
                  <dd className="break-all">{preview.previousDeployCid}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Chain · Safe · nonce</dt>
                  <dd className="break-all">
                    1729 · {config.safeAddress} · {safeState?.nonce ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Simulation</dt>
                  <dd className="text-amber-300">
                    imported review-only evidence
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Safe transaction hash</dt>
                  <dd className="break-all">{safeTxHash ?? '—'}</dd>
                </div>
              </dl>
              <ol className="max-h-64 space-y-2 overflow-auto">
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
                        <dt className="text-slate-500">
                          Calldata ({(call.data.length - 2) / 2} bytes)
                        </dt>
                        <dd className="max-h-36 overflow-auto rounded bg-slate-950 p-2">
                          <code className="break-all">{call.data}</code>
                        </dd>
                      </div>
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
              <h2 className="mb-2 text-lg font-medium">2. Review payload</h2>
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
              <p className="mb-4 text-sm text-amber-200">
                Disabled in this slice. Imported local preview JSON is not a
                trusted authorization input, even when its public provenance
                fields and schema are valid. The production preview worker must
                recompute the calls and bind authenticated evidence to the
                source and deployment CID before this control can be activated.
              </p>
              <Button disabled type="button">
                Sign and stage unavailable
              </Button>
            </section>
          </>
        )}

        <footer className="mt-6 text-xs text-slate-500">{status}</footer>
      </div>
    </main>
  );
}
