#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

const packagePurl = (name, version) => {
  const encodedName = name.startsWith('@')
    ? `%40${name
        .slice(1)
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
};

const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
};

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const resolvedPackageIdentity = (name, dependency, repositoryRoot) => {
  if (typeof dependency.path !== 'string') {
    throw new Error(`dependency path is missing: ${name}`);
  }

  const resolvedPath = realpathSync(resolve(dependency.path));
  if (!isWithin(repositoryRoot, resolvedPath)) {
    throw new Error(`dependency path escapes the repository root: ${name}`);
  }

  const packageJson = JSON.parse(
    readFileSync(resolve(resolvedPath, 'package.json'), 'utf8')
  );
  if (
    typeof packageJson.name !== 'string' ||
    packageJson.name.length === 0 ||
    typeof packageJson.version !== 'string' ||
    packageJson.version.length === 0
  ) {
    throw new Error(`resolved dependency metadata is incomplete: ${name}`);
  }
  if (
    !dependency.version.startsWith('link:') &&
    dependency.version !== packageJson.version
  ) {
    throw new Error(`resolved dependency version disagrees with pnpm: ${name}`);
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
  };
};

export function generateBundleInputSbom({
  componentName,
  componentVersion,
  pnpmList,
  repositoryRoot,
}) {
  const root = realpathSync(resolve(repositoryRoot));
  const components = new Map();

  if (
    !Array.isArray(pnpmList) ||
    pnpmList.length !== 1 ||
    !isRecord(pnpmList[0]) ||
    pnpmList[0].name !== componentName ||
    pnpmList[0].version !== componentVersion
  ) {
    throw new Error(
      'pnpm list root must exactly match the requested component'
    );
  }

  const visitDependencies = (dependencies) => {
    if (dependencies === undefined) return;
    if (!isRecord(dependencies)) {
      throw new Error('pnpm dependency graph must be an object');
    }

    for (const [name, dependency] of Object.entries(dependencies)) {
      if (
        typeof name !== 'string' ||
        name.length === 0 ||
        !isRecord(dependency) ||
        typeof dependency.version !== 'string' ||
        dependency.version.length === 0
      ) {
        throw new Error(`dependency metadata is incomplete: ${name}`);
      }
      if (
        (isRecord(dependency.devDependencies) &&
          Object.keys(dependency.devDependencies).length > 0) ||
        (isRecord(dependency.optionalDependencies) &&
          Object.keys(dependency.optionalDependencies).length > 0)
      ) {
        throw new Error(
          `pnpm list contains excluded dependency classes: ${name}`
        );
      }

      const identity = resolvedPackageIdentity(name, dependency, root);
      const purl = packagePurl(identity.name, identity.version);
      components.set(purl, {
        type: 'library',
        'bom-ref': purl,
        name: identity.name,
        version: identity.version,
        purl,
      });
      visitDependencies(dependency.dependencies);
    }
  };

  visitDependencies(pnpmList[0].dependencies);

  if (components.size === 0) {
    throw new Error('bundle input dependency closure must not be empty');
  }

  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name: componentName,
        version: componentVersion,
      },
      properties: [
        {
          name: 'io.reya.cannon.bundle-input-selection',
          value: 'pnpm list --prod --no-optional --depth Infinity --json',
        },
      ],
    },
    components: [...components.values()].sort((left, right) =>
      left.purl.localeCompare(right.purl)
    ),
  };
}

const main = () => {
  if (process.argv.length !== 7) {
    throw new Error(
      'usage: generate-bundle-input-sbom.mjs REPOSITORY_ROOT PNPM_LIST_FILE OUTPUT_FILE COMPONENT_NAME COMPONENT_VERSION'
    );
  }

  const [
    ,
    ,
    repositoryRoot,
    pnpmListFile,
    outputFile,
    componentName,
    componentVersion,
  ] = process.argv;
  const pnpmList = JSON.parse(readFileSync(pnpmListFile, 'utf8'));
  const sbom = generateBundleInputSbom({
    componentName,
    componentVersion,
    pnpmList,
    repositoryRoot,
  });

  writeFileSync(outputFile, `${JSON.stringify(sbom, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o644,
  });
  process.stdout.write(
    `Recorded ${sbom.components.length} production bundle-input components.\n`
  );
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main();
}
