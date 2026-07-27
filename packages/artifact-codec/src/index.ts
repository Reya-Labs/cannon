import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import pako from 'pako';

const KUBO_CHUNK_SIZE = 262_144;

const noBlockstore = {
  put: async (cid: Parameters<Parameters<typeof importer>[1]['put']>[0]) => cid,
} as Parameters<typeof importer>[1];

export function compress(data: string) {
  return pako.deflate(data);
}

export function uncompress(data: any) {
  return pako.inflate(data, { to: 'string' });
}

/**
 * Calculate the CID produced by Kubo's default `add` settings for a single file.
 *
 * The explicit options are part of Cannon's persisted artifact contract. Changing
 * any of them changes artifact keys and must be handled as a data migration.
 */
export async function getContentCID(value: string | Uint8Array): Promise<string> {
  const content = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  let rootCid: string | undefined;

  for await (const entry of importer([{ content }], noBlockstore, {
    profile: 'unixfs-v0-2015',
    cidVersion: 0,
    rawLeaves: false,
    reduceSingleLeafToSelf: true,
    chunker: fixedSize({ chunkSize: KUBO_CHUNK_SIZE }),
  })) {
    rootCid = entry.cid.toString();
  }

  if (!rootCid) {
    throw new Error('artifact CID calculation produced no root');
  }

  return rootCid;
}

export async function getContentUrl(content?: any): Promise<string | null> {
  if (!content) return null;
  const buffer = compress(JSON.stringify(content));
  const cid = await getContentCID(buffer);
  return `ipfs://${cid}`;
}

const STRICT_CID_REGEX = /^(?<cid>[a-zA-Z0-9]{46})$/;
export function parseIpfsCid(cid: any) {
  if (typeof cid !== 'string' || !cid) return null;
  return cid.trim().match(STRICT_CID_REGEX)?.groups?.cid || null;
}

const CID_REGEX = /^(?:ipfs:\/\/)?(?<cid>[a-zA-Z0-9]{46})$/;
export function getIpfsCid(str: any): string | null {
  if (typeof str !== 'string' || !str) return null;
  return str.trim().match(CID_REGEX)?.groups?.cid || null;
}

export function getIpfsUrl(str: any): string | null {
  const cid = getIpfsCid(str);
  return cid ? `ipfs://${cid}` : null;
}

export function extractValidCid(str: any): string {
  const cid = getIpfsCid(str);
  if (!cid) throw new Error(`Invalid CID ${str}`);
  return cid;
}
