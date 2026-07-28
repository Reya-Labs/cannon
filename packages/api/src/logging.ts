const SAFE_LOG_LABEL = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function readSafeLabel(value: unknown, property: 'code' | 'name', fallback: string): string {
  try {
    if (typeof value !== 'object' || value === null) return fallback;
    const candidate = Reflect.get(value, property);
    return typeof candidate === 'string' && SAFE_LOG_LABEL.test(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export function errorIdentity(error: unknown): { code: string; name: string } {
  return {
    code: readSafeLabel(error, 'code', 'unexpected'),
    name: readSafeLabel(error, 'name', 'unknown'),
  };
}

export function warnMalformedDocument(kind: 'contract' | 'namespace' | 'package' | 'selector' | 'tag'): void {
  // eslint-disable-next-line no-console
  console.warn('query API skipped malformed Redis document', { kind });
}
