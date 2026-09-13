// Fast tier: `npm run test:js`. Deliberately minimal -- one worker's browser
// and HTTPS server are shared across that worker's tests (tests/harness/fixtures.mjs),
// so parallelism comes from more workers, not from per-test browser launches.
export default {
  testDir: 'tests/specs',
  timeout: 15000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    // Real per-worker cert; nothing here talks to a real network origin.
    ignoreHTTPSErrors: true,
  },
};
