import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'out');
const profile = process.env.REYA_EXPORT_PROFILE?.trim() || 'local';
if (profile !== 'local' && profile !== 'production') {
  throw new Error(
    'REYA_EXPORT_PROFILE must be exactly "local" or "production"'
  );
}
const allowedRoot = new Set(
  profile === 'production'
    ? ['_headers', 'app.css', 'app.js', 'index.html', 'release.json']
    : ['app.css', 'app.js', 'index.html']
);
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
  /personal_sign/,
  /wallet_switchEthereumChain/,
  /execTransaction/,
  /\/staging\/(?!1729\/)/,
  /\/staging\/1729\/[^"'`/]{0,80}\/supersede/,
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
const ingressOrigin =
  profile === 'production'
    ? 'https://cannon-safe-staging.tailf2022c.ts.net'
    : 'http://127.0.0.1:8787';
for (const expected of [
  'Reya Cannon Safe staging',
  'Content-Security-Policy',
  ingressOrigin,
  "script-src 'self'",
]) {
  if (!index.includes(expected)) {
    throw new Error(`Reya profile index is missing ${expected}`);
  }
}

if (profile === 'production') {
  const headers = await readFile(path.join(root, '_headers'), 'utf8');
  for (const expected of [
    `connect-src ${ingressOrigin}`,
    'Cache-Control: no-store',
    'Cross-Origin-Opener-Policy: same-origin',
    'Permissions-Policy:',
    'Strict-Transport-Security: max-age=31536000; includeSubDomains',
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
  ]) {
    if (!headers.includes(expected)) {
      throw new Error(`Reya production headers are missing ${expected}`);
    }
  }

  const release = JSON.parse(
    await readFile(path.join(root, 'release.json'), 'utf8')
  );
  if (
    release?.schema !== 'reya-cannon-safe-website-release/v1' ||
    release?.config?.profile !== 'production' ||
    release?.config?.ingressOrigin !== ingressOrigin ||
    release?.config?.siteOrigin !== 'https://cannon.reya.xyz' ||
    release?.config?.stagingEnabled !== true ||
    !/^[0-9a-f]{40}$/.test(release?.buildCommit ?? '') ||
    !/^[0-9a-f]{64}$/.test(release?.configDigest ?? '')
  ) {
    throw new Error('Reya production release metadata is invalid');
  }
  for (const name of ['_headers', 'app.css', 'app.js', 'index.html']) {
    const expected = release?.assets?.[name];
    const actual = createHash('sha256')
      .update(await readFile(path.join(root, name)))
      .digest('hex');
    if (expected !== actual) {
      throw new Error(`Reya production release digest is invalid for ${name}`);
    }
  }
}
const application = await readFile(path.join(root, 'app.js'), 'utf8');
for (const expected of [
  'Shared Safe proposal',
  'Sign and stage proposal',
  'PREVIEW_CHANGED_REVIEW_REQUIRED',
  'SHARED_PROPOSAL_REVIEW_MISMATCH',
  'eth_signTypedData_v4',
  'Execution and broadcast remain unavailable',
  'Execution pending security review',
]) {
  if (!application.includes(expected)) {
    throw new Error(`Reya profile application is missing ${expected}`);
  }
}

process.stdout.write(
  `Validated Reya ${profile} profile export: ${files.length} files; fixed Safe proposal discovery and signing only; no hosted Cannon, telemetry, broadcast or execution capability.\n`
);
