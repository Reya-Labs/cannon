import {
  createLocalIngress,
  loadLocalIngressConfig,
} from '../src/local-ingress.mjs';

function safeStartupReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (
    /^(?:REYA_[A-Z0-9_]+ (?:is required|is invalid|must be [a-zA-Z0-9 .:/-]{1,120})|local ingress (?:fetch implementation is invalid|RPC upstream is not Reya Network))$/.test(
      message
    )
  ) {
    return message;
  }
  if (error?.code === 'EADDRINUSE') {
    return 'loopback port 8787 is already in use';
  }
  return 'startup validation failed';
}

try {
  const config = loadLocalIngressConfig();
  const ingress = await createLocalIngress(config);
  process.stdout.write(
    `Reya local ingress listening on http://127.0.0.1:${config.port}; chain=1729; safe=${config.safeAddress}\n`
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await ingress.close();
  };
  const closeSafely = () => {
    void close().catch(() => {
      process.stderr.write('Reya local ingress failed to shut down cleanly.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', closeSafely);
  process.once('SIGTERM', closeSafely);
} catch (error) {
  process.stderr.write(
    `Reya local ingress failed to start: ${safeStartupReason(error)}.\n`
  );
  process.exitCode = 1;
}
