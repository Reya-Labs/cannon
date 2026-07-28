import { Router } from 'express';
import connectBusboy from 'connect-busboy';
import { getContentCID, getIpfsCid, parseIpfsCid, uncompress } from '@usecannon/builder/dist/src/ipfs';
import { RKEY_FRESH_UPLOAD_HASHES, RKEY_PKG_HASHES } from '../db';
import { InvalidUploadError, readRequestFile, UploadTooLargeError } from '../helpers/read-request-file';
import { DeploymentInfo } from '@usecannon/builder';
import { Response } from 'express';

import type { AddContext, RepoRequest } from '../types';
import { validateBearerToken } from '../helpers/validateBearerToken';

const RKEY_FRESH_GRACE_PERIOD = 5 * 60; // 5 minutes, or else we delete any uploaded artifacts from fresh

async function readUpload(req: RepoRequest, res: Response, ctx: AddContext) {
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

    console.error('upload read failed');
    res.status(400).end('invalid upload data');
    return null;
  }
}

// Middleware for handling regular file uploads
async function handleFileUpload(req: RepoRequest, res: Response, ctx: AddContext) {
  const file = await readUpload(req, res, ctx);
  if (!file) return;

  const cid = await getContentCID(file);
  const expectedCidQuery = req.query['expected-cid'];
  if (Array.isArray(expectedCidQuery)) {
    return res.status(400).end('expected-cid must be provided once');
  }
  const expectedCid = expectedCidQuery === undefined ? null : parseIpfsCid(expectedCidQuery);
  if (expectedCidQuery !== undefined && !expectedCid) {
    return res.status(400).end('invalid expected-cid');
  }
  if (expectedCid && expectedCid !== cid) {
    return res.status(422).end('upload CID does not match expected CID');
  }

  const exists = await ctx.objectStoreWrite.objectExists(cid);

  if (exists) {
    const existing = Buffer.from(await ctx.objectStoreWrite.getObject(cid));
    const existingCid = await getContentCID(existing);

    if (existingCid !== cid || !existing.equals(file)) {
      console.error(`stored object failed integrity verification for "${cid}"`);
      return res.status(409).end('stored artifact conflicts with upload');
    }

    return res.json({ Hash: cid }).end();
  }

  const now = Math.floor(Date.now() / 1000) + RKEY_FRESH_GRACE_PERIOD;

  const isSavable =
    expectedCid === cid ||
    (await ctx.rdb.zScore(RKEY_FRESH_UPLOAD_HASHES, cid)) !== null ||
    (await ctx.rdb.zScore(RKEY_PKG_HASHES, cid)) !== null;

  // if IPFS hash is not already allowed, lets see if this is a cannon package
  if (!isSavable) {
    try {
      const pkgData: DeploymentInfo = JSON.parse(uncompress(file));

      const miscIpfsHash = getIpfsCid(pkgData.miscUrl);

      if (!miscIpfsHash) {
        throw new Error(`Invalid miscUrl in package data for "${cid}"`);
      }

      // as a special step here, we also save the misc url (we dont want to save it anywhere else)
      await ctx.rdb.zAdd(RKEY_FRESH_UPLOAD_HASHES, { score: now, value: miscIpfsHash }, { NX: true });
    } catch (err) {
      // pkg is not savable
      console.log('cannon package upload rejected');
      return res.status(400).end('does not appear to be cannon package');
    }
  }

  // ensure the file is marked as a fresh upload
  await ctx.rdb.zAdd(RKEY_FRESH_UPLOAD_HASHES, { score: now, value: cid }, { NX: true });

  try {
    await ctx.objectStoreWrite.putObject(cid, file);
    return res.json({ Hash: cid }).end();
  } catch {
    console.error('cannon package upload to object storage failed');
    return res.status(500).end('file write error');
  }
}

export function add(ctx: AddContext) {
  const app: Router = Router();

  app.post(
    '/api/v0/add',
    (req, res, next) => validateBearerToken(req as RepoRequest, res, next, ctx),
    (req, res, next) => {
      const wrapWithDirectory = req.query['wrap-with-directory'];
      if (wrapWithDirectory === 'true' || (Array.isArray(wrapWithDirectory) && wrapWithDirectory.includes('true'))) {
        return res.status(501).end('directory uploads are disabled');
      }

      next();
    },
    connectBusboy({
      immediate: true,
      limits: {
        files: 1,
        fileSize: ctx.config.MAX_ARTIFACT_BYTES,
      },
    }),
    async (req: RepoRequest, res: Response) => handleFileUpload(req, res, ctx)
  );

  return app;
}
