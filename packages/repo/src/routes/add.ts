import { Router } from 'express';
import connectBusboy from 'connect-busboy';
import { getContentCID, getIpfsCid, uncompress } from '@usecannon/builder/dist/src/ipfs';
import { RKEY_FRESH_UPLOAD_HASHES, RKEY_PKG_HASHES } from '../db';
import { InvalidUploadError, readRequestFile, UploadTooLargeError } from '../helpers/read-request-file';
import { DeploymentInfo } from '@usecannon/builder';
import * as unzipper from 'unzipper';
import { Readable } from 'stream';
import { posix } from 'node:path';
import { Response } from 'express';

import type { RepoContext, RepoRequest } from '../types';
import { validateBearerToken } from '../helpers/validateBearerToken';

const RKEY_FRESH_GRACE_PERIOD = 5 * 60; // 5 minutes, or else we delete any uploaded artifacts from fresh

function validateArchivePath(path: string) {
  const normalizedPath = posix.normalize(path.replace(/\\/g, '/'));

  if (
    !normalizedPath ||
    normalizedPath === '.' ||
    normalizedPath === '..' ||
    normalizedPath.startsWith('../') ||
    posix.isAbsolute(normalizedPath) ||
    normalizedPath.includes('\0')
  ) {
    throw new InvalidUploadError('archive contains an invalid path');
  }

  return normalizedPath;
}

async function readArchiveEntry(entry: unzipper.Entry, maxBytes: number) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of entry) {
    const data = Buffer.from(chunk);
    totalBytes += data.length;

    if (totalBytes > maxBytes) {
      throw new UploadTooLargeError(maxBytes);
    }

    chunks.push(data);
  }

  return Buffer.concat(chunks, totalBytes);
}

async function readUpload(req: RepoRequest, res: Response, ctx: RepoContext) {
  try {
    const file = await readRequestFile(req, ctx.config.MAX_ARTIFACT_BYTES);

    if (!file) {
      res.status(400).end('no upload data');
      return null;
    }

    return file;
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      res.status(413).end('upload too large');
      return null;
    }

    if (err instanceof InvalidUploadError) {
      res.status(400).end('invalid upload data');
      return null;
    }

    console.error('upload read error', err);
    res.status(400).end('invalid upload data');
    return null;
  }
}

// Middleware for handling regular file uploads
async function handleFileUpload(req: RepoRequest, res: Response, ctx: RepoContext) {
  const file = await readUpload(req, res, ctx);
  if (!file) return;

  const cid = await getContentCID(file);

  const exists = await ctx.s3.objectExists(cid);

  if (exists) {
    const existing = Buffer.from(await ctx.s3.getObject(cid));
    const existingCid = await getContentCID(existing);

    if (existingCid !== cid || !existing.equals(file)) {
      console.error(`stored object failed integrity verification for "${cid}"`);
      return res.status(409).end('stored artifact conflicts with upload');
    }

    return res.json({ Hash: cid }).end();
  }

  const now = Math.floor(Date.now() / 1000) + RKEY_FRESH_GRACE_PERIOD;

  const isSavable =
    (await ctx.rdb.zScore(RKEY_FRESH_UPLOAD_HASHES, cid)) !== null || (await ctx.rdb.zScore(RKEY_PKG_HASHES, cid)) !== null;

  // if IPFS hash is not already allowed, lets see if this is a cannon package
  if (!isSavable) {
    try {
      const pkgData: DeploymentInfo = JSON.parse(uncompress(file));

      const miscIpfsHash = getIpfsCid(pkgData.miscUrl);

      if (!miscIpfsHash) {
        throw new Error(`Invalid miscUrl in package data for "${cid}": "${pkgData.miscUrl}"`);
      }

      // as a special step here, we also save the misc url (we dont want to save it anywhere else)
      await ctx.rdb.zAdd(RKEY_FRESH_UPLOAD_HASHES, { score: now, value: miscIpfsHash }, { NX: true });
    } catch (err) {
      // pkg is not savable
      console.log('cannon package reading fail', err);
      return res.status(400).end('does not appear to be cannon package');
    }
  }

  // ensure the file is marked as a fresh upload
  await ctx.rdb.zAdd(RKEY_FRESH_UPLOAD_HASHES, { score: now, value: cid }, { NX: true });

  try {
    await ctx.s3.putObject(cid, file);
    return res.json({ Hash: cid }).end();
  } catch (err) {
    console.error('cannon package upload to S3 fail', err);
    return res.status(500).end('file write error');
  }
}

// Middleware for handling folder uploads
async function handleFolderUpload(req: RepoRequest, res: Response, ctx: RepoContext) {
  const zipFile = await readUpload(req, res, ctx);
  if (!zipFile) return;

  try {
    const zipStream = Readable.from(zipFile);
    const directory = zipStream.pipe(unzipper.Parse({ forceStream: true }));

    // Collect files first to ensure we have all entries before sending
    const files: { path: string; content: Buffer }[] = [];
    let extractedBytes = 0;

    for await (const entry of directory) {
      if (entry.type === 'Directory') {
        entry.autodrain();
        continue;
      }

      if (files.length >= ctx.config.MAX_ARCHIVE_FILES) {
        throw new UploadTooLargeError(ctx.config.MAX_ARCHIVE_EXTRACTED_BYTES);
      }

      const path = validateArchivePath(entry.path);
      const content = await readArchiveEntry(entry, ctx.config.MAX_ARCHIVE_EXTRACTED_BYTES - extractedBytes);
      extractedBytes += content.length;
      files.push({ path, content });
    }

    console.log(`Processing ${files.length} files from zip`);

    // Create a single FormData for all files
    const formData = new FormData();

    // Add each file to the form data with filepath option
    files.forEach((file) => {
      const blob = new Blob([file.content]);
      formData.append('file', blob, file.path);
    });

    // For Pinata, we use their specific API endpoint
    const pinataUrl = new URL('/pinning/pinFileToIPFS', ctx.config.PINATA_URL);

    console.log('Calling Pinata URL:', pinataUrl.toString());

    // Add JWT authentication header
    const response = await fetch(pinataUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.config.PINATA_API_JWT}`,
      },
      body: formData,
      signal: AbortSignal.timeout(ctx.config.UPSTREAM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Pinata error response:', errorText);
      throw new Error(`Pinata request failed: ${response.statusText} - ${errorText}`);
    }

    // Parse Pinata response
    const result = await response.json();
    const rootHash = result.IpfsHash;

    return res.json({ 'Build hash': rootHash }).end();
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return res.status(413).end('archive too large');
    }

    if (err instanceof InvalidUploadError) {
      return res.status(400).end('invalid archive');
    }

    console.error('Folder upload error:', err);
    return res.status(500).end('folder upload error');
  }
}

export function add(ctx: RepoContext) {
  const app: Router = Router();

  app.post(
    '/api/v0/add',
    (req, res, next) => validateBearerToken(req as RepoRequest, res, next, ctx),
    connectBusboy({
      immediate: true,
      limits: {
        files: 1,
        fileSize: ctx.config.MAX_ARTIFACT_BYTES,
      },
    }),
    async (req: RepoRequest, res: Response) => {
      const wrapWithDirectory = req.query['wrap-with-directory'] !== undefined;

      if (wrapWithDirectory) {
        return handleFolderUpload(req, res, ctx);
      } else {
        return handleFileUpload(req, res, ctx);
      }
    }
  );

  return app;
}
