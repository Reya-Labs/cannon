import { Job as BullJob, Queue as BullQueue, Worker as BullWorker } from 'bullmq';
import { parseRedisUrl } from './redis';
import { createRetryableResourceCloser } from '../shutdown';

export interface QueueOptions {
  redisUrl: string;
  queueName: string;
  retries: number;
  defaultConcurrency: number;
}

export interface WorkerOptions {
  autorun?: boolean;
  concurrency: number;
}

function safeJobId(value: string | undefined): string {
  return value && value.length <= 128 && /^[A-Za-z0-9:_-]+$/.test(value) ? value : 'redacted';
}

export interface DefaultJobContext<JobName extends string, JobData = any> {
  queue: BullQueue<JobData, void, JobName>;
  add: (name: JobName, data: JobData) => Promise<BullJob<JobData, void, JobName>>;
  createBatch: () => {
    add: (name: JobName, data: JobData) => QueueJobAttributes<JobName, JobData>;
    exec: () => Promise<void>;
  };
}

export interface QueueJobAttributes<JobName extends string, JobData = any> {
  name: JobName;
  data: JobData;
  opts?: { jobId: string };
}

export interface JobActionSchema<JobName extends string, JobData, JobContext extends DefaultJobContext<JobName, JobData>> {
  name: JobName;
  action: (data: JobData, ctx: JobContext) => QueueJobAttributes<JobName, JobData>;
}

export interface JobHandlerSchema<JobName extends string, JobData, JobContext extends DefaultJobContext<JobName, JobData>> {
  name: JobName;
  handler: (data: JobData, ctx: JobContext) => Promise<void>;
}

interface ParsedJobActions<JobName extends string, JobData, JobContext extends DefaultJobContext<JobName, JobData>> {
  jobs: JobActionSchema<JobName, JobData, JobContext>[];
  ctx: JobContext;
}

export function createJobs<T extends JobActionSchema<string, any, DefaultJobContext<string, any>>, GivenJobContext>(
  jobs: T[],
  ctx: GivenJobContext = {} as GivenJobContext
) {
  type JobName = T['name'];
  type JobData = Parameters<T['action']>[0];
  type JobContext = GivenJobContext & DefaultJobContext<JobName, JobData>;

  return {
    jobs,
    ctx: ctx as JobContext,
  } satisfies ParsedJobActions<JobName, JobData, JobContext>;
}

export function createQueue<T extends ParsedJobActions<string, any, DefaultJobContext<string, any>>>(
  jobs: T,
  queueOpts: QueueOptions
) {
  type QueueJobName = T['jobs'][number]['name'];
  type QueueJobData = Parameters<T['jobs'][number]['action']>[0];
  type QueueContext = T['ctx'] & DefaultJobContext<QueueJobName, QueueJobData>;

  const connection = parseRedisUrl(queueOpts.redisUrl);

  const queue = new BullQueue<QueueJobData, void, QueueJobName>(queueOpts.queueName, {
    connection,
    defaultJobOptions: {
      attempts: queueOpts.retries,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
    },
  });
  queue.on('error', () => {
    // BullMQ requires an error listener; keep connection details and job data out of logs.
    // eslint-disable-next-line no-console
    console.error(`[queue][${queueOpts.queueName}] Redis connection error`);
  });

  const jobCtx = { ...jobs.ctx, queue, add, createBatch } as unknown as QueueContext;

  function createAction(name: QueueJobName, data: QueueJobData) {
    const actionCreator = jobs.jobs.find((j) => j.name === name)?.action;
    if (!actionCreator) throw new Error(`Unknown job name: ${name}`);
    const job = actionCreator(data, jobCtx);
    if (!job) throw new Error(`Missing action response for job: ${name}`);
    return job;
  }

  async function add(name: QueueJobName, data: QueueJobData) {
    const job = await createAction(name, data);
    return queue.add(job.name as any, job.data, job.opts);
  }

  function createBatch() {
    const jobs: QueueJobAttributes<QueueJobName, QueueJobData>[] = [];

    return {
      add(name: QueueJobName, data: QueueJobData) {
        const action = createAction(name, data);
        jobs.push(action);
        return action;
      },
      async exec() {
        return queue.addBulk(jobs as any);
      },
    };
  }

  const workers: BullWorker<QueueJobData, any, QueueJobName>[] = [];
  let closingStarted = false;
  function createWorker(
    jobHandlers: JobHandlerSchema<QueueJobName, QueueJobData, QueueContext>[],
    workerOpts?: WorkerOptions
  ) {
    if (closingStarted) throw new Error('queue is closing');

    const handlerNames = jobHandlers.map(({ name }) => name);
    const missingHandlers = jobs.jobs.map(({ name }) => name).filter((name) => !handlerNames.includes(name as QueueJobName));
    if (missingHandlers.length) {
      throw new Error(`Missing queue handlers: ${missingHandlers.join(', ')}`);
    }
    if (new Set(handlerNames).size !== handlerNames.length) {
      throw new Error('Duplicate queue handlers are not allowed');
    }

    const concurrency = workerOpts?.concurrency || queueOpts?.defaultConcurrency || 1;

    const worker = new BullWorker<QueueJobData, any, QueueJobName>(
      queueOpts.queueName,
      async (job) => {
        const jobDef = jobHandlers.find((candidate) => candidate.name === job.name);

        if (!jobDef) {
          throw new Error(`Unknown job name: ${job.name}`);
        }

        await jobDef.handler(job.data, jobCtx);
      },
      {
        autorun: workerOpts?.autorun ?? true,
        connection,
        concurrency,
      }
    );

    workers.push(worker);

    worker.on('error', () => {
      // eslint-disable-next-line no-console
      console.error(`[worker][${queueOpts.queueName}] Redis connection error`);
    });

    worker.on('completed', (job) => {
      // eslint-disable-next-line no-console
      console.log(`[worker][${queueOpts.queueName}] completed queue job ${safeJobId(job?.id)}`);
    });

    worker.on('failed', (job) => {
      // eslint-disable-next-line no-console
      console.error(
        `[worker][${queueOpts.queueName}] failed queue job ${safeJobId(job?.id)} (attempt ${job?.attemptsMade ?? 0})`
      );
    });

    return worker;
  }

  async function pendingCount() {
    const counts = await queue.getJobCounts('delayed', 'active', 'waiting', 'waiting-children', 'prioritized');
    return Object.values(counts).reduce((acc, count) => acc + count, 0);
  }

  async function waitForIdle() {
    let pending = 0;
    do {
      pending = await pendingCount();
      // eslint-disable-next-line no-console
      console.log(`[queue][${queueOpts.queueName}] pending: ${pending}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } while (pending > 0);
  }

  let forceWorkerClose = false;
  const closeResources = createRetryableResourceCloser(
    () => [...workers, queue],
    'queue cleanup failed',
    (resource) =>
      workers.includes(resource as BullWorker<QueueJobData, any, QueueJobName>)
        ? (resource as BullWorker<QueueJobData, any, QueueJobName>).close(forceWorkerClose)
        : resource.close()
  );

  async function close(forceWorkers = false) {
    closingStarted = true;
    forceWorkerClose ||= forceWorkers;
    await closeResources();
  }

  return { queue, add, createBatch, createWorker, pendingCount, waitForIdle, close };
}
