module.exports = {
  e2e: {
    baseUrl: 'http://127.0.0.1:57713',
    specPattern: 'cypress/e2e/**/*.cy.mjs',
    supportFile: false,
  },
  chromeWebSecurity: true,
  defaultCommandTimeout: 20_000,
  pageLoadTimeout: 30_000,
  requestTimeout: 20_000,
  responseTimeout: 30_000,
  retries: 0,
  screenshotsFolder: 'cypress/screenshots',
  trashAssetsBeforeRuns: true,
  video: false,
  viewportHeight: 1_000,
  viewportWidth: 1_600,
};
