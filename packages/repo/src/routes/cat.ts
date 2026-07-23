import { Response as ExpressResponse, Router } from 'express';
import { getContentCID, parseIpfsCid } from '@usecannon/builder/dist/src/ipfs';
import { RepoContext } from '../types';

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
    return res.status(404).end('unregistered ipfs data');
  });

  return app;
}
