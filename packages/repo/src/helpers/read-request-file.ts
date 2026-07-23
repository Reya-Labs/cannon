import 'connect-busboy';
import consumers from 'stream/consumers';

import type { RepoRequest } from '../types';

export class UploadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`upload exceeds the ${maxBytes} byte limit`);
    this.name = 'UploadTooLargeError';
  }
}

export class InvalidUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUploadError';
  }
}

export async function readRequestFile(req: RepoRequest, maxBytes: number) {
  if (!req.busboy) return null;

  return new Promise<Buffer | null>((resolve, reject) => {
    let filePromise: Promise<Buffer> | undefined;
    let settled = false;

    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    req.busboy.on('file', (_, fileStream) => {
      if (filePromise) {
        fileStream.resume();
        fail(new InvalidUploadError('exactly one file must be uploaded'));
        return;
      }

      let hitSizeLimit = false;
      fileStream.once('limit', () => {
        hitSizeLimit = true;
      });

      filePromise = consumers.buffer(fileStream).then((file) => {
        if (hitSizeLimit || fileStream.truncated || file.length > maxBytes) {
          throw new UploadTooLargeError(maxBytes);
        }

        return file;
      });

      void filePromise.catch((err) => {
        fail(err instanceof Error ? err : new Error('Could not read file'));
      });
    });

    req.busboy.once('filesLimit', () => {
      fail(new InvalidUploadError('exactly one file must be uploaded'));
    });

    req.busboy.once('error', fail);

    req.busboy.once('finish', async () => {
      if (settled) return;

      try {
        const file = filePromise ? await filePromise : null;
        settled = true;
        resolve(file);
      } catch (err) {
        fail(err instanceof Error ? err : new Error('Could not read file'));
      }
    });
  });
}
