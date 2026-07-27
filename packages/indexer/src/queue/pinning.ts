import { getDeploymentImports, readRawIpfs, uncompress, writeRawIpfs } from '@usecannon/builder';
import { getS3Client } from '@usecannon/repo/dist/src/s3';
import type { WorkerOptions } from '../helpers/create-queue';
import type { ArtifactWorkerConfig } from '../worker-config';
import { validatePinningJobData } from './contracts';
import type { PinningJobData } from './contracts';
import type { Queue } from './index';

/**
 * Starts the privileged artifact handlers. Configuration and the S3 client are
 * constructed here rather than when the canonical registry imports its queue
 * producer.
 */
export function startPinningWorker(queue: Queue, config: ArtifactWorkerConfig, workerOptions?: WorkerOptions) {
  const s3 = getS3Client(config, {
    credentials: {
      accessKeyId: config.S3_KEY,
      secretAccessKey: config.S3_SECRET,
    },
  });

  return queue.createWorker(
    [
      {
        name: 'PIN_CID',
        async handler(data: PinningJobData) {
          // eslint-disable-next-line no-console
          console.log('PIN_CID: ', data.cid);

          const { cid } = validatePinningJobData(data);

          const existsOnS3 = await s3.objectExists(cid);
          const rawData = Buffer.from(
            existsOnS3
              ? await s3.getObject(cid)
              : await readRawIpfs({
                  ipfsUrl: config.IPFS_URL,
                  cid,
                })
          );

          if (existsOnS3) {
            await writeRawIpfs({
              ipfsUrl: config.IPFS_URL,
              data: rawData,
            });
          } else {
            await s3.putObject(cid, rawData);
          }
        },
      },
      {
        name: 'PIN_PACKAGE',
        async handler(data: PinningJobData, { createBatch }) {
          // eslint-disable-next-line no-console
          console.log('PIN_PACKAGE: ', data.cid);

          const { cid } = validatePinningJobData(data);

          const existsOnS3 = await s3.objectExists(cid);

          const rawPackageData = Buffer.from(
            existsOnS3
              ? await s3.getObject(cid)
              : await readRawIpfs({
                  ipfsUrl: config.IPFS_URL,
                  cid,
                  timeout: 1000 * 30,
                })
          );

          const packageData = JSON.parse(uncompress(rawPackageData));

          const batch = createBatch();

          batch.add('PIN_CID', { cid });

          if (packageData.miscUrl) {
            batch.add('PIN_CID', { cid: packageData.miscUrl });
          }

          for (const subPackage of getDeploymentImports(packageData)) {
            batch.add('PIN_PACKAGE', { cid: subPackage.url });
          }

          await batch.exec();
        },
      },
    ],
    workerOptions
  );
}
