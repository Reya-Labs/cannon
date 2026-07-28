import {
  readFile,
  rename,
  rm,
  mkdir,
  mkdtemp,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestFiles, sha256, validateBuildEnvironment } from './config.mjs';
import { CLOUDFLARE_HEADERS, renderHtml, STYLES } from './template.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const DEFAULT_OUTPUT = path.join(PACKAGE_ROOT, 'dist');

const SOURCE_INPUTS = Object.freeze([
  'package.json',
  'src/build.mjs',
  'src/config.mjs',
  'src/template.mjs',
]);
const ASSET_PATHS = Object.freeze([
  '_headers',
  'assets/app.css',
  'index.html',
  'sbom.cdx.json',
]);
const COMPONENT_REFERENCE = 'pkg:npm/%40reya/cannon-safe-ui@0.0.0';

async function readSourceInputs(packageRoot) {
  return Promise.all(
    SOURCE_INPUTS.map(async (relativePath) => ({
      path: relativePath,
      bytes: await readFile(path.join(packageRoot, relativePath)),
    }))
  );
}

function releaseMetadata({
  assets,
  buildSha,
  configDigest,
  profile,
  sourceDigest,
}) {
  return {
    schemaVersion: 1,
    application: 'reya-safe-ui',
    activation: 'disabled',
    profile,
    build: {
      revision: buildSha,
      sourceDigest,
      configDigest,
    },
    export: {
      assetDigest: digestFiles(assets),
      files: assets.map(({ bytes, path: relativePath }) => ({
        path: relativePath,
        bytes: bytes.length,
        digest: sha256(bytes),
      })),
    },
  };
}

function staticExportSbom({ buildSha, configDigest, sourceDigest }) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
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
            value: buildSha,
          },
          {
            name: 'io.reya.cannon.build.source-digest',
            value: sourceDigest,
          },
          {
            name: 'io.reya.cannon.build.config-digest',
            value: configDigest,
          },
          {
            name: 'io.reya.cannon.runtime-javascript',
            value: 'absent',
          },
        ],
      },
    },
    components: [],
    dependencies: [
      {
        ref: COMPONENT_REFERENCE,
        dependsOn: [],
      },
    ],
  };
}

export async function buildExport({
  env = process.env,
  outDir = DEFAULT_OUTPUT,
  packageRoot = PACKAGE_ROOT,
} = {}) {
  const { buildSha, configDigest, profile } = validateBuildEnvironment(env);
  const sourceDigest = digestFiles(await readSourceInputs(packageRoot));
  const sbom = `${JSON.stringify(
    staticExportSbom({ buildSha, configDigest, sourceDigest }),
    null,
    2
  )}\n`;

  const assetContents = new Map([
    ['_headers', CLOUDFLARE_HEADERS],
    ['assets/app.css', STYLES],
    ['index.html', renderHtml({ buildSha, configDigest, sourceDigest })],
    ['sbom.cdx.json', sbom],
  ]);
  const assets = ASSET_PATHS.map((relativePath) => ({
    path: relativePath,
    bytes: Buffer.from(assetContents.get(relativePath), 'utf8'),
  }));
  const release = `${JSON.stringify(
    releaseMetadata({ assets, buildSha, configDigest, profile, sourceDigest }),
    null,
    2
  )}\n`;

  const output = path.resolve(outDir);
  const parent = path.dirname(output);
  if (output === path.parse(output).root) {
    throw new Error(
      'refusing to build the Reya Safe UI into a filesystem root'
    );
  }

  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(
    path.join(parent, `.${path.basename(output)}-`)
  );

  try {
    for (const { bytes, path: relativePath } of assets) {
      const target = path.join(temporary, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx' });
    }
    await writeFile(path.join(temporary, 'release.json'), release, {
      flag: 'wx',
    });
    await rm(output, { force: true, recursive: true });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }

  return {
    buildSha,
    configDigest,
    outDir: output,
    sourceDigest,
  };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await buildExport();
    process.stdout.write(
      `Built disabled Reya Safe UI ${result.buildSha} (${result.configDigest}) at ${result.outDir}\n`
    );
  } catch (error) {
    process.stderr.write(
      `Reya Safe UI build failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    process.exitCode = 1;
  }
}
