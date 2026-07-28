import { importer } from 'ipfs-unixfs-importer';
import { fixedSize } from 'ipfs-unixfs-importer/chunker';
import pako from 'pako';

const KUBO_CHUNK_SIZE = 262_144;

const noBlockstore = {
  put: async (cid: Parameters<Parameters<typeof importer>[1]['put']>[0]) => cid,
} as Parameters<typeof importer>[1];

/**
 * Deflate a UTF-8 artifact string.
 *
 * @param data - The string to compress.
 * @returns The compressed artifact bytes.
 */
export function compress(data: string) {
  return pako.deflate(data);
}

/**
 * Inflate compressed artifact bytes into their UTF-8 string representation.
 *
 * @param data - Bytes produced by {@link compress}.
 * @returns The decompressed string.
 * @throws If the bytes are not a valid deflate stream.
 */
export function uncompress(data: any) {
  return pako.inflate(data, { to: 'string' });
}

/**
 * Calculate the CID produced by Kubo's default `add` settings for a single file.
 *
 * The explicit options are part of Cannon's persisted artifact contract. Changing
 * any of them changes artifact keys and must be handled as a data migration.
 *
 * @param value - UTF-8 text or the exact artifact bytes to address.
 * @returns The Kubo-compatible CIDv0 string.
 * @throws If UnixFS import does not produce a root CID.
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

/**
 * Encode a JSON artifact and return its content-addressed Cannon URL.
 *
 * @param content - A JSON-serializable artifact. Falsy values represent no artifact.
 * @returns An `ipfs://` CID URL, or `null` when no content is supplied.
 * @throws If JSON serialization, compression, or CID calculation fails.
 */
export async function getContentUrl(content?: any): Promise<string | null> {
  if (!content) return null;
  const buffer = compress(JSON.stringify(content));
  const cid = await getContentCID(buffer);
  return `ipfs://${cid}`;
}

const STRICT_CID_REGEX = /^(?<cid>[a-zA-Z0-9]{46})$/;

/**
 * Parse a bare, shape-valid Cannon CID.
 *
 * @param cid - Candidate value.
 * @returns The trimmed 46-character CID, or `null` for a prefixed or malformed value.
 */
export function parseIpfsCid(cid: any) {
  if (typeof cid !== 'string' || !cid) return null;
  return cid.trim().match(STRICT_CID_REGEX)?.groups?.cid || null;
}

const CID_REGEX = /^(?:ipfs:\/\/)?(?<cid>[a-zA-Z0-9]{46})$/;

/**
 * Parse a bare CID or an `ipfs://` Cannon URL.
 *
 * @param str - Candidate value.
 * @returns The trimmed 46-character CID, or `null` when the input shape is invalid.
 */
export function getIpfsCid(str: any): string | null {
  if (typeof str !== 'string' || !str) return null;
  return str.trim().match(CID_REGEX)?.groups?.cid || null;
}

/**
 * Normalize a bare CID or Cannon URL to its `ipfs://` form.
 *
 * @param str - Candidate bare CID or `ipfs://` URL.
 * @returns The normalized URL, or `null` when the input shape is invalid.
 */
export function getIpfsUrl(str: any): string | null {
  const cid = getIpfsCid(str);
  return cid ? `ipfs://${cid}` : null;
}

/**
 * Require and extract a shape-valid CID from a bare value or Cannon URL.
 *
 * @param str - Candidate bare CID or `ipfs://` URL.
 * @returns The extracted 46-character CID.
 * @throws If the input is not a supported CID shape.
 */
export function extractValidCid(str: any): string {
  const cid = getIpfsCid(str);
  if (!cid) throw new Error(`Invalid CID ${str}`);
  return cid;
}
