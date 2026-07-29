import toml from '@iarna/toml';

const SOURCE_ROOT_PARTS = ['packages', 'tomls', 'src'];
const SOURCE_ROOT_PREFIX = `${SOURCE_ROOT_PARTS.join('/')}/`;
const MAX_SOURCE_FILES = 512;
const MAX_INCLUDE_DEPTH = 16;
const MAX_VALUE_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataProperty(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error('definition assembly input is invalid');
  }
  return descriptor.value;
}

function writeSafeDataProperty(target, key, value) {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new Error('definition contains a forbidden key');
  }
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function assertSourcePath(sourcePath) {
  if (
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath.includes('\\') ||
    sourcePath.includes('\0') ||
    sourcePath.startsWith('/') ||
    !sourcePath.startsWith(SOURCE_ROOT_PREFIX) ||
    !sourcePath.endsWith('.toml')
  ) {
    throw new Error('definition source path is invalid');
  }

  const parts = sourcePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('definition source path is invalid');
  }
}

function resolveIncludePath(parentPath, includePath) {
  if (
    typeof includePath !== 'string' ||
    includePath.length === 0 ||
    includePath.includes('\\') ||
    includePath.includes('\0') ||
    includePath.startsWith('/')
  ) {
    throw new Error('definition include path is invalid');
  }

  const parts = parentPath.split('/');
  parts.pop();

  for (const part of includePath.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }

    if (part === '..') {
      if (parts.length <= SOURCE_ROOT_PARTS.length) {
        throw new Error('definition include escapes source root');
      }
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  const resolved = parts.join('/');
  assertSourcePath(resolved);
  return resolved;
}

function assertSafeValue(value, depth = 0) {
  if (depth > MAX_VALUE_DEPTH) {
    throw new Error('definition value nesting is too deep');
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('definition contains a non-finite number');
    }
    return;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('definition contains an invalid date');
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeValue(item, depth + 1);
    }
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error('definition contains an unsupported value');
  }

  if (
    Object.getOwnPropertySymbols(value).some(
      (symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable,
    )
  ) {
    throw new Error('definition contains enumerable symbol keys');
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error('definition contains a forbidden key');
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable
    ) {
      throw new Error('definition contains an unsafe property');
    }
    assertSafeValue(descriptor.value, depth + 1);
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }

  if (value instanceof Date) {
    const clone = new Date(value.getTime());
    Object.setPrototypeOf(clone, Object.getPrototypeOf(value));
    for (const key of Object.keys(value)) {
      writeSafeDataProperty(
        clone,
        key,
        cloneValue(readDataProperty(value, key)),
      );
    }
    return clone;
  }

  if (isPlainObject(value)) {
    const clone = {};
    for (const key of Object.keys(value)) {
      writeSafeDataProperty(
        clone,
        key,
        cloneValue(readDataProperty(value, key)),
      );
    }
    return clone;
  }

  return value;
}

function mergeValue(target, source, depth) {
  // This is the website's mergeWith customizer boundary: operation-content
  // values are replaced as a unit, while operation objects still merge by key.
  if (depth >= 3) {
    return cloneValue(source);
  }

  if (Array.isArray(source)) {
    const merged = Array.isArray(target)
      ? target.map((item) => cloneValue(item))
      : [];

    for (let index = 0; index < source.length; index += 1) {
      merged[index] = mergeValue(merged[index], source[index], depth + 1);
    }
    return merged;
  }

  if (isPlainObject(source)) {
    const merged = isPlainObject(target) ? target : {};
    for (const key of Object.keys(source)) {
      const targetValue = Object.hasOwn(merged, key)
        ? readDataProperty(merged, key)
        : undefined;
      writeSafeDataProperty(
        merged,
        key,
        mergeValue(
          targetValue,
          readDataProperty(source, key),
          depth + 1,
        ),
      );
    }
    return merged;
  }

  return cloneValue(source);
}

function mergeDefinition(target, source) {
  return mergeValue(target, source, 0);
}

function parseDefinition(content) {
  let definition;
  try {
    definition = toml.parse(content);
  } catch {
    throw new Error('definition TOML is invalid');
  }

  if (!isPlainObject(definition)) {
    throw new Error('definition TOML root is invalid');
  }
  assertSafeValue(definition);
  return definition;
}

/**
 * Assemble a Cannon definition from a closed, in-memory source bundle.
 *
 * Includes are resolved relative to the including file and merged in declared
 * order. The including file is merged last. This mirrors the Cannon website's
 * loadChainDefinitionToml precedence without performing filesystem or network
 * access.
 */
export function assembleCannonDefinition(bundle) {
  if (
    !isPlainObject(bundle) ||
    Object.getOwnPropertySymbols(bundle).length !== 0
  ) {
    throw new Error('definition assembly input is invalid');
  }

  const root = readDataProperty(bundle, 'root');
  const files = readDataProperty(bundle, 'files');
  assertSourcePath(root);

  if (
    !Array.isArray(files) ||
    files.length === 0 ||
    files.length > MAX_SOURCE_FILES
  ) {
    throw new Error('definition source files are invalid');
  }

  const fileByPath = new Map();
  for (const file of files) {
    if (!isPlainObject(file) || Object.getOwnPropertySymbols(file).length !== 0) {
      throw new Error('definition source file is invalid');
    }

    const sourcePath = readDataProperty(file, 'path');
    const content = readDataProperty(file, 'content');
    assertSourcePath(sourcePath);
    if (typeof content !== 'string') {
      throw new Error('definition source file is invalid');
    }
    if (fileByPath.has(sourcePath)) {
      throw new Error('definition source path is duplicated');
    }
    fileByPath.set(sourcePath, content);
  }

  const active = new Set();
  const cache = new Map();
  const reachable = new Set();

  function assemble(sourcePath, depth) {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new Error('definition include nesting is too deep');
    }
    if (active.has(sourcePath)) {
      throw new Error('definition include cycle detected');
    }
    if (cache.has(sourcePath)) {
      reachable.add(sourcePath);
      return cloneValue(cache.get(sourcePath));
    }

    const content = fileByPath.get(sourcePath);
    if (content === undefined) {
      throw new Error('definition include is missing');
    }

    active.add(sourcePath);
    reachable.add(sourcePath);

    try {
      const rawDefinition = parseDefinition(content);
      const includes = Object.hasOwn(rawDefinition, 'include')
        ? rawDefinition.include
        : [];

      if (
        !Array.isArray(includes) ||
        includes.some((includePath) => typeof includePath !== 'string')
      ) {
        throw new Error('definition include list is invalid');
      }

      const assembled = {};
      for (const includePath of includes) {
        const resolved = resolveIncludePath(sourcePath, includePath);
        mergeDefinition(assembled, assemble(resolved, depth + 1));
      }

      const localDefinition = {};
      for (const key of Object.keys(rawDefinition)) {
        if (key !== 'include') {
          localDefinition[key] = rawDefinition[key];
        }
      }
      mergeDefinition(assembled, localDefinition);

      cache.set(sourcePath, cloneValue(assembled));
      return assembled;
    } finally {
      active.delete(sourcePath);
    }
  }

  const assembled = assemble(root, 0);
  if (reachable.size !== fileByPath.size) {
    throw new Error('definition bundle contains unreachable files');
  }
  return assembled;
}
