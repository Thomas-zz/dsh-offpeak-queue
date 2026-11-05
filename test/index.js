/**
 * Compatibility entry point for the documented directory form:
 *
 *     node --test test/
 *
 * Node's test runner (24.x) treats a positional path as a file, not a
 * directory, so the directory form resolves this entry and executes it as one
 * test file (argv[1] is the extensionless `.../test` path). Importing the suite
 * files here keeps that command working, while `node --test` auto-discovery
 * still runs each `*.test.mjs` once — this file is a no-op in that mode.
 *
 * @module dsh-offpeak-queue/test
 */

const entry = process.argv[1] ?? ''

if (!entry.endsWith('.js') && !entry.endsWith('.mjs') && !entry.endsWith('.cjs')) {
  await import('./policy.test.mjs')
  await import('./pricing.test.mjs')
  await import('./store.test.mjs')
  await import('./prestep.test.mjs')
  await import('./controller.test.mjs')
  await import('./runner.test.mjs')
  await import('./engine.test.mjs')
  await import('./routes.test.mjs')
  await import('./tool.test.mjs')
}
