/**
 * Performance measurement only: `npx vite --config perf/vite.meter.config.ts` serves the portal with every
 * `firebase/firestore` import routed through perf/meter.ts, which counts documents read (window.__reads).
 * Run against the emulators (VITE_USE_EMULATORS=1). Never used by `npm run build`.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config'

export default mergeConfig(
  base,
  defineConfig({
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: [{ find: /^firebase\/firestore$/, replacement: fileURLToPath(new URL('./meter.ts', import.meta.url)) }] }
  })
)
