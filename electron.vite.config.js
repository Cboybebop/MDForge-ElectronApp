import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// Dev-mode CSP for the Vite dev server (renderer loads via ELECTRON_RENDERER_URL in dev,
// not through the production app:// protocol handler). See 01-RESEARCH.md Pattern 2.
const DEV_CSP =
  "default-src 'self' http://localhost:*; " +
  "script-src 'self' http://localhost:* 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline' http://localhost:*; " +
  "connect-src 'self' http://localhost:* ws://localhost:*"

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        // electron-store@11 (and its conf@15 dependency) ship ESM-only. Force-bundle it so
        // the CJS main-process output doesn't hit ERR_REQUIRE_ESM. See 01-RESEARCH.md Pattern 3.
        // chokidar@5 (and its readdirp@5 dependency) is the same shape -- ESM-only,
        // "type": "module", no CJS build. See 07-RESEARCH.md Pattern 2.
        exclude: ['electron-store', 'chokidar']
      }
    }
  },
  preload: {},
  renderer: {
    root: 'src/renderer',
    server: {
      headers: { 'Content-Security-Policy': DEV_CSP }
    },
    build: {
      rollupOptions: {
        // Second entry: the Phase 9 decision-gate spellcheck spike
        // (09-01-PLAN.md Task 3). Standard Vite multi-page pattern --
        // protocol.js's app:// handler already serves any relative path
        // under out/renderer/, so no protocol.js change is needed. This
        // second entry is permanent, not deleted at phase close
        // (09-01-PLAN.md's revision note) -- only the packaged installer
        // excludes it later (09-03-PLAN.md Task 2).
        input: {
          main: resolve(__dirname, 'src/renderer/index.html'),
          spike: resolve(__dirname, 'src/renderer/spike-spellcheck.html')
        }
      }
    }
  }
})
