import * as rkey from './db';

/**
 * Marks an unrecognized registry event kind as terminal for event processing.
 *
 * The failure disposition propagates this error to the scan supervisor instead
 * of serializing an event that the current binary cannot safely replay.
 */
export class UnsupportedRegistryEventError extends Error {
  override readonly name = 'UnsupportedRegistryEventError';
}

const REGISTRY_FAILURE_MESSAGES = {
  action: '[warn] registry action handler failed',
  notification: '[warn] registry notification failed',
  process: 'registry process failed',
  scan: 'failure while scanning cannon publishes',
} as const;

interface RegistryEventDeadLetterStore {
  lPush(key: string, value: string): Promise<unknown>;
}

function safeDiagnosticName(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value) ? value : fallback;
}

function serializeDeadLetterEvent(event: unknown): string {
  return JSON.stringify(event, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
}

/**
 * Emits only a fixed diagnostic; provider, Redis, artifact, and webhook errors
 * can contain credential-bearing URLs or attacker-controlled payloads.
 */
export function reportRegistryFailure(scope: keyof typeof REGISTRY_FAILURE_MESSAGES, _error: unknown): void {
  void _error;
  // eslint-disable-next-line no-console
  console.error(REGISTRY_FAILURE_MESSAGES[scope]);
}

/**
 * Applies the registry's fail-closed event disposition without logging event
 * payloads or raw dependency errors.
 *
 * Unsupported event kinds are propagated to the scan supervisor. Other
 * processing failures are placed on the existing dead-letter list until an
 * idempotent recovery state machine is introduced.
 */
export async function handleRegistryEventFailure(
  error: unknown,
  event: { eventName?: unknown },
  redis: RegistryEventDeadLetterStore
): Promise<void> {
  if (error instanceof UnsupportedRegistryEventError) throw error;

  const eventName = safeDiagnosticName(event?.eventName, 'unknown');
  const errorName = safeDiagnosticName(error instanceof Error ? error.name : undefined, 'unknown');
  // eslint-disable-next-line no-console
  console.error(`[REG] failed to process ${eventName} event (${errorName})`);
  await redis.lPush(rkey.RKEY_RETRY_PROCESS_PACKAGE, serializeDeadLetterEvent(event));
}
