import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';

export type ArchiveEntry = {
  body?: Buffer | string;
  name: string;
  type?: 'directory' | 'file' | 'symlink';
};

type ResponseOptions = NonNullable<ConstructorParameters<typeof Response>[1]>;

export async function archive(commit: string, entries: ArchiveEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const completed = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    pack.on('end', () => resolve(gzipSync(Buffer.concat(chunks))));
    pack.on('error', reject);
  });

  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '');
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          linkname: entry.type === 'symlink' ? 'target' : undefined,
          name: `${entry.name}`.replaceAll('<commit>', commit),
          size: entry.type === 'directory' || entry.type === 'symlink' ? 0 : body.length,
          type: entry.type ?? 'file',
        },
        entry.type === 'directory' || entry.type === 'symlink' ? undefined : body,
        (error) => (error ? reject(error) : resolve())
      );
    });
  }
  pack.finalize();
  return completed;
}

export function archiveResponse(bytes: Buffer, init: ResponseOptions = {}): Response {
  return new Response(bytes, {
    ...init,
    headers: {
      'content-length': String(bytes.length),
      'content-type': 'application/gzip',
      ...init.headers,
    },
    status: init.status ?? 200,
  });
}

export const COMMIT = '2b10669075b91eb8db781d199292f30c52f8e994';
export const ROOT = `reya-deployments-${COMMIT}`;
export const ROOT_TOML = `${ROOT}/packages/tomls/src/omnibus/reya_network.toml`;
