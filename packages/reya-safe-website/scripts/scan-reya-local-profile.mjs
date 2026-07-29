import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'out');
const allowedRoot = new Set(['app.css', 'app.js', 'index.html']);
const forbidden = [
  /api\.usecannon\.com/i,
  /repo\.usecannon\.com/i,
  /safe-staging\.usecannon\.com/i,
  /git-proxy\./i,
  /walletconnect/i,
  /sentry\.io/i,
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /vercel-insights/i,
  /mainnet\.infura\.io/i,
  /rpc\.reya\.network\/[0-9a-f]{16,}/i,
  /eth_sendRawTransaction/,
  /eth_sendTransaction/,
  /execTransaction/,
];

const rootEntries = await readdir(root, { withFileTypes: true });
if (rootEntries.some((entry) => entry.name.endsWith('.map'))) {
  throw new Error('Reya profile export contains browser source maps');
}
if (
  rootEntries.length !== allowedRoot.size ||
  [...allowedRoot].some(
    (expected) => !rootEntries.some((entry) => entry.name === expected)
  )
) {
  throw new Error('Reya profile export does not contain the exact root files');
}
for (const entry of rootEntries) {
  if (!allowedRoot.has(entry.name)) {
    throw new Error(`unexpected Reya profile export entry: ${entry.name}`);
  }
}

const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Reya profile export contains a symlink: ${target}`);
    }
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile()) files.push(target);
    else
      throw new Error(`Reya profile export contains a special file: ${target}`);
  }
}
await walk(root);

if (files.some((file) => file.endsWith('.map'))) {
  throw new Error('Reya profile export contains browser source maps');
}
for (const file of files) {
  const bytes = await readFile(file);
  if (bytes.byteLength > 32 * 1024 * 1024) {
    throw new Error(`Reya profile asset is unexpectedly large: ${file}`);
  }
  if (!/\.(?:html|js|json|txt|css)$/i.test(file)) continue;
  const text = bytes.toString('utf8');
  for (const pattern of forbidden) {
    if (pattern.test(text)) {
      throw new Error(
        `Reya profile export contains forbidden capability ${pattern}: ${file}`
      );
    }
  }
}

const index = await readFile(path.join(root, 'index.html'), 'utf8');
for (const expected of [
  'Reya Cannon Safe staging',
  'Content-Security-Policy',
  'http://127.0.0.1:8787',
  "script-src 'self'",
]) {
  if (!index.includes(expected)) {
    throw new Error(`Reya profile index is missing ${expected}`);
  }
}
const application = await readFile(path.join(root, 'app.js'), 'utf8');
for (const expected of [
  'execution disabled',
  'no transaction execution or broadcast method',
]) {
  if (!application.includes(expected)) {
    throw new Error(`Reya profile application is missing ${expected}`);
  }
}

process.stdout.write(
  `Validated Reya local profile export: ${files.length} files; no hosted Cannon, telemetry, broadcast or execution capability.\n`
);
