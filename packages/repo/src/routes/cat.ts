import { Response as ExpressResponse, Router } from 'express';
import _ from 'lodash';
import { getContentCID, parseIpfsCid, uncompress } from '@usecannon/builder/dist/src/ipfs';
import { RKEY_FRESH_UPLOAD_HASHES, RKEY_PKG_HASHES, RKEY_EXTRA_HASHES } from '../db';
import { RepoContext } from '../types';

async function readBoundedResponse(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('upstream artifact exceeds size limit');
  }

  if (!response.body) {
    throw new Error('upstream response has no body');
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of response.body) {
    const data = Buffer.from(chunk);
    totalBytes += data.length;

    if (totalBytes > maxBytes) {
      throw new Error('upstream artifact exceeds size limit');
    }

    chunks.push(data);
  }

  return Buffer.concat(chunks, totalBytes);
}

async function readStoredArtifact(ctx: RepoContext, cid: string) {
  if (!(await ctx.s3.objectExists(cid))) {
    return null;
  }

  const data = Buffer.from(await ctx.s3.getObject(cid));
  const actualCid = await getContentCID(data);

  if (actualCid !== cid) {
    throw new Error(`stored artifact CID mismatch: requested "${cid}", computed "${actualCid}"`);
  }

  return data;
}

function sendArtifact(res: ExpressResponse, data: Buffer) {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', data.length);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  return res.end(data);
}

export function cat(ctx: RepoContext) {
  const app: Router = Router();

  app.head('/api/v0/cat', async (req, res) => {
    const cid = parseIpfsCid(req.query.arg);

    if (!cid) {
      return res.status(400).end();
    }

    try {
      if (!(await ctx.s3.objectExists(cid))) return res.status(404).end();
      return res.status(200).end();
    } catch (err) {
      console.error('stored artifact availability check failed', err);
      return res.status(502).end();
    }
  });

  app.post('/api/v0/cat', async (req, res) => {
    const cid = parseIpfsCid(req.query.arg);

    if (!cid) {
      // the exact error message for this 400 error is necessary for backwards compatibility
      return res.status(400).end('argument "ipfs-path" is required');
    }

    try {
      const data = await readStoredArtifact(ctx, cid);
      if (data) return sendArtifact(res, data);
    } catch (err) {
      console.error('stored artifact integrity check failed', err);
      return res.status(502).end('stored artifact integrity check failed');
    }

    const batch = ctx.rdb.multi();
    batch.zScore(RKEY_FRESH_UPLOAD_HASHES, cid);
    batch.zScore(RKEY_PKG_HASHES, cid);
    batch.zScore(RKEY_EXTRA_HASHES, cid);

    try {
      const ipfsUrl = new URL(`/api/v0/cat?arg=${cid}`, ctx.config.IPFS_URL);
      const [upstreamRes, existsResult] = await Promise.all([
        fetch(ipfsUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(ctx.config.UPSTREAM_TIMEOUT_MS),
        }),
        batch.exec(),
      ]);

      if (!upstreamRes.ok) {
        return res.status(upstreamRes.status === 404 ? 404 : 502).end('unregistered ipfs data');
      }

      const rawData = await readBoundedResponse(upstreamRes, ctx.config.MAX_ARTIFACT_BYTES);
      const actualCid = await getContentCID(rawData);

      if (actualCid !== cid) {
        console.error(`upstream artifact CID mismatch: requested "${cid}", computed "${actualCid}"`);
        return res.status(502).end('upstream artifact integrity check failed');
      }

      const hashIsRepod = _.some(existsResult, _.isNumber);

      if (!hashIsRepod) {
        try {
          JSON.parse(uncompress(rawData));
        } catch (err) {
          console.error('unregistered upstream artifact is not a Cannon package', err);
          return res.status(404).end('unregistered ipfs data');
        }
      }

      await ctx.s3.putObject(cid, rawData);
      return sendArtifact(res, rawData);
    } catch (err) {
      console.error('Cannon artifact fallback failed', err);
      return res.status(502).end('cannon package download ipfs fail');
    }
  });

  return app;
}
