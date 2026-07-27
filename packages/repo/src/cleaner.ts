import _ from 'lodash';
import { uncompress } from '@usecannon/artifact-codec';
import {
  getDb,
  RKEY_FRESH_UPLOAD_HASHES,
  RKEY_PKG_HASHES,
  RKEY_EXTRA_HASHES,
  RKEY_LAST_UPDATED,
  RKEY_FEES_PAID,
} from './db';
import type { CannonPackageArtifact } from './types';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readLegacyIpfsArtifact(ipfsUrl: string, cid: string, timeout: number): Promise<CannonPackageArtifact> {
  const url = new URL(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, ipfsUrl.replace('+ipfs', ''));
  let response: globalThis.Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`failed to read "${cid}" from the legacy IPFS endpoint: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`failed to read "${cid}" from the legacy IPFS endpoint: HTTP ${response.status}`);
  }

  try {
    return JSON.parse(uncompress(new Uint8Array(await response.arrayBuffer()))) as CannonPackageArtifact;
  } catch (error) {
    throw new Error(`failed to decode "${cid}" from the legacy IPFS endpoint: ${errorMessage(error)}`);
  }
}

export async function deleteLegacyIpfsPin(ipfsUrl: string, cid: string, timeout: number): Promise<void> {
  const url = new URL(`/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, ipfsUrl.replace('+ipfs', ''));
  let response: globalThis.Response;

  try {
    response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new Error(`failed to remove "${cid}" from the legacy IPFS endpoint: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`failed to remove "${cid}" from the legacy IPFS endpoint: HTTP ${response.status}`);
  }
}

export async function cleanUnregisteredIpfs(
  redisUrl: string,
  indexerUrl: string,
  ipfsUrl: string,
  gracePeriod: number,
  minFees: { startTimestamp: number; requiredFee: bigint }[]
) {
  const now = Math.floor(Date.now() / 1000);
  const rdb = await getDb(redisUrl);
  const indexerRdb = await getDb(indexerUrl);

  console.log('[init] clean cycle');
  const expired = await rdb.zRangeWithScores(RKEY_FRESH_UPLOAD_HASHES, 0, now - gracePeriod, { BY: 'SCORE' });

  for (const artifact of expired) {
    const readBatch = indexerRdb.multi();
    readBatch.get(RKEY_LAST_UPDATED);
    readBatch.zRange(RKEY_FEES_PAID, artifact.value, '+', { LIMIT: { offset: 0, count: 1 } });
    const [indexerLastUpdated, feesRecord]: [number, string] = (await readBatch.exec()) as any;

    if (indexerLastUpdated < artifact.score) {
      // artifact cannot be calculated yet, because we havent scanned that far on-chain
      continue;
    }

    const [urlRef, , feePaid] = feesRecord.split('#');
    const ipfsHash = _.last(urlRef.split('://'))!;
    if (BigInt(feePaid) > _.sortedIndexBy(minFees, { startTimestamp: artifact.score, requiredFee: 0n }, 'score')) {
      console.log(`[keep] ${artifact.value}`);
      try {
        // TODO: also keep the misc url
        const miscUrl = (await readLegacyIpfsArtifact(ipfsUrl, ipfsHash, 10000)).miscUrl;
        const miscIpfsHash = _.last(miscUrl.split('://'))!;

        const batch = rdb.multi();
        batch.zAdd(RKEY_PKG_HASHES, { score: artifact.score, value: ipfsHash });
        batch.zRem(RKEY_FRESH_UPLOAD_HASHES, miscIpfsHash);
        batch.zAdd(RKEY_EXTRA_HASHES, { score: artifact.score, value: miscIpfsHash });
        await batch.exec();
      } catch (err) {
        console.log(`[fail] did not keep upload hash: ${err}`);
      }
    } else {
      console.log(`[wipe] ${artifact.value}`);
      try {
        await deleteLegacyIpfsPin(ipfsUrl, ipfsHash, 10000);
      } catch (err) {
        console.log(`[fail] did not delete upload hash: ${err}`);
        continue;
      }
    }

    await rdb.zRem(RKEY_FRESH_UPLOAD_HASHES, artifact.value);
  }

  console.log('[done] clean cycle');
}
