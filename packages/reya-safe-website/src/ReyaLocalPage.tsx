'use client';

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@cannon/components/ui/alert';
import { Button } from '@cannon/components/ui/button';
import { createReyaLocalClients } from './clients';
import {
  makeStageableSafeTransaction,
  parseReyaPreview,
  ReyaPreview,
} from './preview';
import { ReyaLocalProfileConfig } from './profile-config';
import { readReyaSafeState } from './safe-state';
import { walletTypedData } from './wallet-request';
import { getAddress, isAddress } from 'viem';
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';

type SafeState = Awaited<ReturnType<typeof readReyaSafeState>>;
type Proposal = Awaited<
  ReturnType<ReturnType<typeof createReyaLocalClients>['staging']['current']>
>;

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
    'serviceCode' in error &&
    typeof error.serviceCode === 'string'
  ) {
    const serviceCode = error.serviceCode.toUpperCase();
    if (/^[A-Z0-9_]{1,64}$/.test(serviceCode)) {
      return `STAGING_${serviceCode}`;
    }
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

function sameTransaction(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function ReyaLocalPage({ config }: { config: ReyaLocalProfileConfig }) {
  const clients = useMemo(() => createReyaLocalClients(config), [config]);
  const [safeState, setSafeState] = useState<SafeState | null>(null);
  const [sourceDigest, setSourceDigest] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal>(null);
  const [preview, setPreview] = useState<ReyaPreview | null>(null);
  const [walletAddress, setWalletAddress] = useState<`0x${string}` | null>(
    null
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading Reya state…');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const [source, state, staged] = await Promise.all([
      clients.read.source.bundle({ commit: config.sourceCommit }),
      readReyaSafeState(clients.read.rpc, config.safeAddress),
      clients.staging.current(),
    ]);
    setSourceDigest(source.bundleSha256);
    setSafeState(state);
    setProposal(staged);
    setStatus('Source, Reya RPC, Safe and local staging are ready.');
    return { source, staged, state };
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
      const signing = clients.signing(async () => {
        throw new Error('WALLET_REQUEST_FORBIDDEN');
      });
      return signing.prepare({ txn: transaction }).safeTxHash;
    } catch {
      return null;
    }
  }, [clients, transaction]);

  const importPreview = async (event: ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setConfirmed(false);
    setPreview(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || file.size < 2 || file.size > 16 * 1024 * 1024) {
      setError('PREVIEW_REJECTED');
      return;
    }
    try {
      if (!sourceDigest) throw new Error('SOURCE_NOT_READY');
      const parsed = parseReyaPreview(await file.text(), {
        commit: config.sourceCommit,
        safeAddress: config.safeAddress,
      });
      if (parsed.sourceBundleSha256 !== sourceDigest) {
        throw new Error('SOURCE_DIGEST_MISMATCH');
      }
      setPreview(parsed);
      setStatus('Preview evidence loaded and bound to the source bundle.');
    } catch (cause) {
      setError(displayError(cause));
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

  const signAndStage = async () => {
    setBusy(true);
    setError(null);
    try {
      if (
        !confirmed ||
        !preview ||
        !walletAddress ||
        !transaction ||
        !safeTxHash
      ) {
        throw new Error('REVIEW_CONFIRMATION_REQUIRED');
      }
      const reviewedTransaction = transaction;
      const reviewedSafeTxHash = safeTxHash;
      const provider = (window as unknown as { ethereum?: EthereumProvider })
        .ethereum;
      if (!provider) throw new Error('INJECTED_WALLET_REQUIRED');
      const [chainId, accounts, current] = await Promise.all([
        provider.request({ method: 'eth_chainId' }),
        provider.request({ method: 'eth_accounts' }),
        refresh(),
      ]);
      if (
        chainId !== '0x6c1' ||
        !Array.isArray(accounts) ||
        accounts.length !== 1 ||
        typeof accounts[0] !== 'string' ||
        !isAddress(accounts[0]) ||
        getAddress(accounts[0]).toLowerCase() !== walletAddress ||
        !current.state.owners.includes(walletAddress)
      ) {
        throw new Error('WALLET_CONTEXT_CHANGED');
      }
      const txn = makeStageableSafeTransaction(preview, current.state.nonce);
      const signing = clients.signing(async (value) => {
        const signature = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [
            walletAddress,
            walletTypedData(value, walletAddress, config.safeAddress),
          ],
        });
        if (typeof signature !== 'string') {
          throw new Error('WALLET_REQUEST_REJECTED');
        }
        return signature;
      });
      const prepared = signing.prepare({ txn });
      if (
        current.source.bundleSha256 !== preview.sourceBundleSha256 ||
        !sameTransaction(reviewedTransaction, txn) ||
        prepared.safeTxHash !== reviewedSafeTxHash
      ) {
        setConfirmed(false);
        throw new Error('REVIEWED_TRANSACTION_CHANGED');
      }
      if (current.staged && !sameTransaction(current.staged.txn, txn)) {
        throw new Error('CURRENT_NONCE_PROPOSAL_CONFLICT');
      }
      const signed = await signing.sign({
        ownerAddress: walletAddress,
        prepared,
      });
      const staged = await clients.staging.submitSignature({
        signature: signed.signature,
        txn,
      });
      setProposal(staged.proposal);
      setConfirmed(false);
      setStatus(
        staged.created
          ? 'Signed proposal created in local staging.'
          : 'Owner signature added to the existing local proposal.'
      );
    } catch (cause) {
      setError(displayError(cause));
    } finally {
      setBusy(false);
    }
  };

  const stageBlockedReason = preview?.deployerPrerequisiteCount
    ? 'Preview contains deployer prerequisites and cannot be represented as one Safe proposal.'
    : !preview
    ? 'Import reviewed preview evidence first.'
    : !safeState
    ? 'Safe state is unavailable.'
    : !walletAddress
    ? 'Connect a current Safe owner.'
    : !confirmed
    ? 'Confirm the exact hash and calls.'
    : transaction === null || safeTxHash === null
    ? 'The preview cannot be encoded safely.'
    : null;

  return (
    <main className="min-h-screen bg-[#090b0f] text-slate-100">
      <div className="mx-auto max-w-6xl px-5 py-8 md:px-8">
        <header className="mb-8 border-b border-slate-800 pb-6">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400">
            Reya local QA · execution disabled
          </p>
          <h1 className="text-3xl font-semibold">Cannon Safe staging</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-400">
            Review a CID-verified Cannon simulation, sign its exact Safe
            payload, and store the approval in local Valkey. This profile has no
            transaction execution or broadcast method.
          </p>
        </header>

        {error && (
          <Alert variant="destructive" className="mb-6">
            <AlertTitle>Fail-closed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <section className="mb-6 grid gap-3 rounded-lg border border-slate-800 bg-slate-950 p-5 md:grid-cols-2">
          <div>
            <p className="text-xs text-slate-500">Network</p>
            <p>Reya Network · 1729</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Approved Safe</p>
            <code className="text-xs">{config.safeAddress}</code>
          </div>
          <div>
            <p className="text-xs text-slate-500">Source commit</p>
            <code className="text-xs">{config.sourceCommit}</code>
          </div>
          <div>
            <p className="text-xs text-slate-500">Source bundle</p>
            <code className="break-all text-xs">
              {sourceDigest ?? 'unavailable'}
            </code>
          </div>
          <div>
            <p className="text-xs text-slate-500">Safe state</p>
            <p className="text-sm">
              nonce {safeState?.nonce ?? '—'} · threshold{' '}
              {safeState?.threshold ?? '—'} of {safeState?.owners.length ?? '—'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Local proposal</p>
            <p className="text-sm">
              {proposal
                ? `${proposal.sigs.length} owner signature(s)`
                : 'none at current nonce'}
            </p>
          </div>
        </section>

        <section className="mb-6 rounded-lg border border-slate-800 bg-slate-950 p-5">
          <h2 className="mb-2 text-lg font-medium">1. Import preview</h2>
          <p className="mb-4 text-sm text-slate-400">
            Select the JSON produced by{' '}
            <code>pnpm --filter @reya/cannon-safe-ui preview:local</code>. The
            commit, Safe, chain and source-bundle digest must match.
          </p>
          <input
            aria-label="Cannon preview evidence"
            accept="application/json,.json"
            className="block w-full rounded border border-slate-700 bg-slate-900 p-2 text-sm"
            onChange={(event) => void importPreview(event)}
            type="file"
          />
          {preview && (
            <div className="mt-4 space-y-2 text-sm">
              <p>
                {preview.safeProposalCalls.length} ordered Safe call(s) ·{' '}
                {preview.deployerPrerequisiteCount} deployer prerequisite(s)
              </p>
              <p className="break-all text-xs text-slate-400">
                Previous artifact CID: {preview.previousDeployCid}
              </p>
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
                <code className="break-all text-xs">{safeTxHash ?? '—'}</code>
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
          <div className="mt-5">
            <Button
              onClick={() => void connectWallet()}
              type="button"
              variant="outline"
            >
              Connect injected owner wallet
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-amber-900/70 bg-amber-950/20 p-5">
          <h2 className="mb-2 text-lg font-medium">3. Sign and stage</h2>
          <p className="mb-4 text-sm text-amber-200">
            The signature is a genuine, portable Reya-mainnet Safe approval even
            though it is stored only in local Valkey. Do not approve the wallet
            prompt until every call and the Safe transaction hash have been
            independently reviewed.
          </p>
          <label className="mb-4 flex items-start gap-3 text-sm">
            <input
              checked={confirmed}
              className="mt-1"
              disabled={!transaction || !walletAddress}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              I reviewed the exact chain, Safe, nonce, ordered calls and Safe
              transaction hash shown above.
            </span>
          </label>
          <Button
            disabled={busy || stageBlockedReason !== null}
            onClick={() => void signAndStage()}
            type="button"
          >
            {busy ? 'Waiting for wallet…' : 'Sign and stage locally'}
          </Button>
          {stageBlockedReason && (
            <p className="mt-3 text-xs text-slate-400">{stageBlockedReason}</p>
          )}
        </section>

        <footer className="mt-6 text-xs text-slate-500">{status}</footer>
      </div>
    </main>
  );
}
