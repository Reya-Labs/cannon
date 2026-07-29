import {
  createLocalIngress,
  loadLocalIngressConfig,
} from '../src/local-ingress.mjs';

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
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
} catch (error) {
  process.stderr.write('Reya local ingress failed to start.\n');
  process.exitCode = 1;
}
