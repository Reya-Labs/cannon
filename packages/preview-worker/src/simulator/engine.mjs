/**
 * The Cannon engine is a runtime capability of the image, not of this package.
 *
 * `packages/preview-worker` is deliberately outside the pnpm workspace so that
 * a change to the derivation boundary cannot re-resolve the monorepo's
 * dependency graph. The Cannon builder, the artifact codec and the reviewed
 * read-only preview engine all live inside that workspace and are built from
 * it, so the image supplies them and this module resolves them by fixed
 * specifier.
 *
 * Fixed is the point. No environment variable, request field or configuration
 * value selects what gets imported here, so an operator mistake or a request
 * cannot substitute a different engine. If the image did not supply the
 * capability, a `fork` worker fails to start rather than starting degraded.
 */
export const ENGINE_MEMBERS = Object.freeze({
  assembleDefinition: Object.freeze({
    export: 'assembleCannonDefinition',
    specifier: '@reya/cannon-safe-ui/assemble-definition',
  }),
  createArtifactLoader: Object.freeze({
    export: 'createReadOnlyArtifactLoader',
    specifier: '@reya/cannon-safe-ui/artifact-loader',
  }),
  createEphemeralOverlay: Object.freeze({
    export: 'createEphemeralArtifactOverlay',
    specifier: '@reya/cannon-safe-ui/ephemeral-artifact-overlay',
  }),
  getContentCid: Object.freeze({
    export: 'getContentCID',
    specifier: '@usecannon/artifact-codec',
  }),
  runReadOnlyPreview: Object.freeze({
    export: 'runReadOnlyPreview',
    specifier: '@reya/cannon-safe-ui/preview-engine',
  }),
});

export const ENGINE_MEMBER_NAMES = Object.freeze(
  Object.keys(ENGINE_MEMBERS).sort(),
);

/**
 * Accepts only a complete engine. A partially satisfied contract is rejected
 * rather than tolerated, because the missing member would otherwise surface as
 * an unexplained failure in the middle of a build.
 *
 * @param {unknown} engine
 */
export function validatePreviewEngine(engine) {
  if (
    engine === null ||
    typeof engine !== 'object' ||
    Array.isArray(engine) ||
    Reflect.ownKeys(engine).length !== ENGINE_MEMBER_NAMES.length ||
    !ENGINE_MEMBER_NAMES.every((name) => typeof engine[name] === 'function')
  ) {
    throw new Error('preview engine contract is not satisfied');
  }
  return Object.freeze({ ...engine });
}

/**
 * Resolves the engine from the image.
 *
 * @param {(specifier: string) => Promise<Record<string, unknown>>} [importModule]
 */
export async function loadPreviewEngine(
  importModule = (specifier) => import(specifier),
) {
  const specifiers = [
    ...new Set(Object.values(ENGINE_MEMBERS).map((member) => member.specifier)),
  ].sort();
  const modules = new Map();
  for (const specifier of specifiers) {
    let loaded;
    try {
      loaded = await importModule(specifier);
    } catch (error) {
      throw new Error(
        'preview engine is not installed in this image; a fork simulator cannot start',
        { cause: error },
      );
    }
    modules.set(specifier, loaded);
  }
  return validatePreviewEngine(
    Object.fromEntries(
      Object.entries(ENGINE_MEMBERS).map(([name, member]) => [
        name,
        modules.get(member.specifier)?.[member.export],
      ]),
    ),
  );
}
