export interface ShutdownSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface AsyncCloseable {
  close(): Promise<unknown>;
}

/**
 * Closes independent resources together, remembers successful closes, and
 * permits a later call to retry only failures. The public error is deliberately
 * generic because resource errors can contain connection details.
 */
export function createRetryableResourceCloser(
  getResources: () => Iterable<AsyncCloseable>,
  failureMessage: string,
  closeResource: (resource: AsyncCloseable) => Promise<unknown> = (resource) => resource.close()
): () => Promise<void> {
  const closed = new Set<AsyncCloseable>();
  let inFlight: Promise<void> | undefined;

  async function closePending() {
    const pending = [...new Set(getResources())].filter((resource) => !closed.has(resource));
    if (!pending.length) return;

    const results = await Promise.allSettled(pending.map(closeResource));
    let failed = false;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        closed.add(pending[index]);
      } else {
        failed = true;
      }
    }

    if (failed) throw new Error(failureMessage);
  }

  return function close() {
    if (inFlight) return inFlight;
    inFlight = closePending().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

/**
 * Converts process signals into an AbortSignal and a promise without exiting
 * abruptly. Entrypoints remain responsible for closing the resources they own.
 */
export function listenForShutdown(source: ShutdownSignalSource = process) {
  const controller = new AbortController();
  let resolveRequested: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });

  const requestShutdown = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    resolveRequested();
  };

  source.once('SIGINT', requestShutdown);
  source.once('SIGTERM', requestShutdown);

  return {
    signal: controller.signal,
    requested,
    dispose() {
      source.off('SIGINT', requestShutdown);
      source.off('SIGTERM', requestShutdown);
    },
  };
}
