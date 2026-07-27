export interface ShutdownSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
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
