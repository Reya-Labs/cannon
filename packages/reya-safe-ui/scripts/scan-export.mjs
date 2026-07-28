import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCanonicalText, digestFiles, sha256 } from '../src/config.mjs';
import { CLOUDFLARE_HEADERS, META_CSP } from '../src/template.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const EXPECTED_FILES = Object.freeze([
  '_headers',
  'assets/app.css',
  'index.html',
  'release.json',
  'sbom.cdx.json',
]);
const ASSET_FILES = Object.freeze([
  '_headers',
  'assets/app.css',
  'index.html',
  'sbom.cdx.json',
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_EXPORT_FILE_BYTES = 1024 * 1024;
const COMPONENT_REFERENCE = 'pkg:npm/%40reya/cannon-safe-ui@0.0.0';

const FORBIDDEN_CONTENT = Object.freeze([
  ['remote HTTP URL', /\bhttps?:\/\//i],
  ['remote WebSocket URL', /\bwss?:\/\//i],
  ['IPFS URI', /\bipfs:\/\//i],
  ['executable or embedded URI', /\b(?:blob|data|javascript):/i],
  ['protocol-relative URL', /(?:["'(=:\s])\/\/[a-z0-9.-]+/i],
  ['CSS external resource', /(?:@import\b|url\s*\()/i],
  [
    'hosted Cannon domain',
    /\b(?:repo\.|safe-staging\.|git-proxy\.repo\.)?usecannon\.com\b/i,
  ],
  ['public IPFS gateway', /\b(?:ipfs\.io|dweb\.link|cloudflare-ipfs\.com)\b/i],
  ['public RPC provider', /\b(?:infura\.io|alchemy\.com|ankr\.com)\b/i],
  [
    'remote package CDN',
    /\b(?:unpkg\.com|jsdelivr\.net|cdnjs\.cloudflare\.com)\b/i,
  ],
  [
    'telemetry provider',
    /\b(?:sentry|segment|mixpanel|amplitude|google-analytics)\b/i,
  ],
  ['script element', /<script\b/i],
  ['frame element', /<(?:iframe|frame)\b/i],
  ['form element', /<form\b/i],
  ['inline event handler', /\bon(?:click|error|load|submit)\s*=/i],
  [
    'browser network primitive',
    /\b(?:fetch|WebSocket|XMLHttpRequest|sendBeacon)\s*\(/,
  ],
]);

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields: ${actual.join(', ')}`);
  }
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) =>
    compareCanonicalText(left.name, right.name)
  )) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    const metadata = await lstat(absolute);

    if (metadata.isSymbolicLink())
      throw new Error(`export contains a symbolic link: ${relative}`);
    if (metadata.isDirectory()) {
      files.push(...(await collectFiles(root, absolute)));
    } else if (metadata.isFile()) {
      if (metadata.size > MAX_EXPORT_FILE_BYTES) {
        throw new Error(
          `export file exceeds ${MAX_EXPORT_FILE_BYTES} bytes: ${relative}`
        );
      }
      files.push(relative);
    } else {
      throw new Error(`export contains a non-regular file: ${relative}`);
    }
  }

  return files;
}

function validateRelease(release, contents) {
  assertExactKeys(
    release,
    [
      'schemaVersion',
      'application',
      'activation',
      'profile',
      'build',
      'export',
    ],
    'release metadata'
  );
  assertExactKeys(
    release.profile,
    ['schemaVersion', 'name', 'chainId', 'activation'],
    'release profile'
  );
  assertExactKeys(
    release.build,
    ['revision', 'sourceDigest', 'configDigest'],
    'release build'
  );
  assertExactKeys(release.export, ['assetDigest', 'files'], 'release export');

  if (release.schemaVersion !== 1)
    throw new Error('release schemaVersion must be 1');
  if (release.application !== 'reya-safe-ui')
    throw new Error('release application is invalid');
  if (release.activation !== 'disabled')
    throw new Error('release activation must be disabled');
  if (
    release.profile.schemaVersion !== 1 ||
    release.profile.name !== 'reya-mainnet' ||
    release.profile.chainId !== 1729 ||
    release.profile.activation !== 'disabled'
  ) {
    throw new Error('release profile is not the disabled Reya mainnet profile');
  }
  if (!BUILD_SHA_PATTERN.test(release.build.revision))
    throw new Error('release build revision is invalid');
  if (!DIGEST_PATTERN.test(release.build.sourceDigest))
    throw new Error('release source digest is invalid');
  if (!DIGEST_PATTERN.test(release.build.configDigest))
    throw new Error('release config digest is invalid');
  if (release.build.configDigest !== sha256(JSON.stringify(release.profile))) {
    throw new Error(
      'release config digest does not match the validated profile'
    );
  }
  if (!DIGEST_PATTERN.test(release.export.assetDigest))
    throw new Error('release asset digest is invalid');
  if (
    !Array.isArray(release.export.files) ||
    release.export.files.length !== ASSET_FILES.length
  ) {
    throw new Error('release file manifest is incomplete');
  }

  const manifestPaths = release.export.files.map((entry) => entry.path);
  if (JSON.stringify(manifestPaths) !== JSON.stringify(ASSET_FILES)) {
    throw new Error('release file manifest paths are not canonical');
  }

  const assets = ASSET_FILES.map((relativePath, index) => {
    const entry = release.export.files[index];
    assertExactKeys(
      entry,
      ['path', 'bytes', 'digest'],
      `release file ${relativePath}`
    );
    const bytes = contents.get(relativePath);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes.length) {
      throw new Error(`release byte length mismatch: ${relativePath}`);
    }
    if (entry.digest !== sha256(bytes))
      throw new Error(`release file digest mismatch: ${relativePath}`);
    return { path: relativePath, bytes };
  });

  if (release.export.assetDigest !== digestFiles(assets)) {
    throw new Error('release asset digest mismatch');
  }

  const html = contents.get('index.html').toString('utf8');
  if (!html.includes('Proposal signing is not activated')) {
    throw new Error('disabled activation notice is missing');
  }
  if (!html.includes(release.build.revision))
    throw new Error('visible build revision is missing');
  if (!html.includes(`content="${release.build.sourceDigest}"`))
    throw new Error('HTML source digest does not match release metadata');
  if (!html.includes(`content="${release.build.configDigest}"`))
    throw new Error('HTML config digest does not match release metadata');
  if (!html.includes(`content="${META_CSP}"`))
    throw new Error('HTML CSP does not match the generated policy');
}

function validateSbom(sbom, release) {
  assertExactKeys(
    sbom,
    [
      'bomFormat',
      'specVersion',
      'version',
      'metadata',
      'components',
      'dependencies',
    ],
    'SBOM'
  );
  assertExactKeys(sbom.metadata, ['component'], 'SBOM metadata');
  assertExactKeys(
    sbom.metadata.component,
    ['bom-ref', 'type', 'name', 'version', 'properties'],
    'SBOM component'
  );

  if (
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.6' ||
    sbom.version !== 1
  ) {
    throw new Error('SBOM identity is invalid');
  }

  const expectedComponent = {
    'bom-ref': COMPONENT_REFERENCE,
    type: 'application',
    name: '@reya/cannon-safe-ui',
    version: '0.0.0',
    properties: [
      {
        name: 'io.reya.cannon.activation',
        value: 'disabled',
      },
      {
        name: 'io.reya.cannon.build.revision',
        value: release.build.revision,
      },
      {
        name: 'io.reya.cannon.build.source-digest',
        value: release.build.sourceDigest,
      },
      {
        name: 'io.reya.cannon.build.config-digest',
        value: release.build.configDigest,
      },
      {
        name: 'io.reya.cannon.runtime-javascript',
        value: 'absent',
      },
    ],
  };
  if (
    JSON.stringify(sbom.metadata.component) !==
    JSON.stringify(expectedComponent)
  ) {
    throw new Error('SBOM component does not match the tested release');
  }
  if (!Array.isArray(sbom.components) || sbom.components.length !== 0) {
    throw new Error('SBOM deployed components must be empty');
  }
  if (
    !Array.isArray(sbom.dependencies) ||
    sbom.dependencies.length !== 1 ||
    JSON.stringify(sbom.dependencies[0]) !==
      JSON.stringify({ ref: COMPONENT_REFERENCE, dependsOn: [] })
  ) {
    throw new Error('SBOM dependency graph must be empty');
  }
}

export async function scanExport(exportRoot) {
  const root = path.resolve(exportRoot);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('export root must be a real directory');
  }

  const files = await collectFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    throw new Error(`export file set is not allowlisted: ${files.join(', ')}`);
  }

  const contents = new Map();
  for (const relativePath of files) {
    const bytes = await readFile(path.join(root, relativePath));
    const text = bytes.toString('utf8');
    if (text.includes('\u0000') || text.includes('\ufffd')) {
      throw new Error(
        `export file is not valid plain UTF-8 text: ${relativePath}`
      );
    }
    for (const [label, pattern] of FORBIDDEN_CONTENT) {
      if (pattern.test(text))
        throw new Error(`${relativePath} contains forbidden ${label}`);
    }
    contents.set(relativePath, bytes);
  }

  if (contents.get('_headers').toString('utf8') !== CLOUDFLARE_HEADERS) {
    throw new Error('Cloudflare headers do not match the generated policy');
  }

  let release;
  try {
    release = JSON.parse(contents.get('release.json').toString('utf8'));
  } catch {
    throw new Error('release metadata is not valid JSON');
  }
  validateRelease(release, contents);

  let sbom;
  try {
    sbom = JSON.parse(contents.get('sbom.cdx.json').toString('utf8'));
  } catch {
    throw new Error('SBOM is not valid JSON');
  }
  validateSbom(sbom, release);

  return Object.freeze({
    assetDigest: release.export.assetDigest,
    buildSha: release.build.revision,
    configDigest: release.build.configDigest,
    files: Object.freeze([...files]),
    sourceDigest: release.build.sourceDigest,
  });
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.length > 3) {
    process.stderr.write(
      'usage: node scripts/scan-export.mjs [export-directory]\n'
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await scanExport(
        process.argv[2] ?? path.join(PACKAGE_ROOT, 'dist')
      );
      process.stdout.write(
        `Verified disabled Reya Safe UI ${result.buildSha} (${result.assetDigest}) across ${result.files.length} files\n`
      );
    } catch (error) {
      process.stderr.write(
        `Reya Safe UI export rejected: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
      process.exitCode = 1;
    }
  }
}
