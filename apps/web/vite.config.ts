import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { DOWNLOADS, missingText } from '../../scripts/downloads.ts';
import { type BundleEntry, precacheScript, shellFiles } from './src/offline/shell.ts';

// Cross-origin isolation lets the simulation worker share memory with the UI thread
// (SharedArrayBuffer) once the frame transport moves off postMessage.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// The examples import committed fixtures (project JSON, firmware ?raw) from the repo root.
const repoRoot = decodeURIComponent(new URL('../..', import.meta.url).pathname);

/**
 * Dev only (BT34, BT63, BT66, BT94, BT126; one plugin since BT147): the simulation worker fetches
 * the downloads scripts/downloads.ts lists — the ESP32, ESP32-C3, ESP32-S3 and ESP32-S2 ROMs, the RP2350
 * bootrom, the MicroPython UF2s — from the git-ignored .cache their fetch scripts fill. Never part
 * of the build: the bridge serves the same table for `npm start`. A missing file is a 404 the
 * worker turns into a Problem.
 */
function downloads(): Plugin {
  return {
    name: 'benchtop-downloads',
    apply: 'serve',
    configureServer(server) {
      for (const download of DOWNLOADS) {
        const file = resolve(repoRoot, download.file);
        server.middlewares.use(download.path, (_req, res) => {
          if (!existsSync(file)) {
            res.statusCode = 404;
            res.end(missingText(download));
            return;
          }
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          createReadStream(file).pipe(res);
        });
      }
    },
  };
}

/**
 * Build only (BT40): writes /sw-precache.js, the app shell the service worker (public/sw.js)
 * precaches — computed from the final bundle, so it runs after Vite emits the worker.
 */
function appShell(): Plugin {
  return {
    name: 'benchtop-app-shell',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = shellFiles(bundle as unknown as Record<string, BundleEntry>);
      this.emitFile({ type: 'asset', fileName: 'sw-precache.js', source: precacheScript(files) });
    },
  };
}

export default defineConfig({
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  plugins: [downloads(), appShell()],
  worker: { format: 'es' },
  build: { target: 'es2023' },
  server: {
    headers: isolationHeaders,
    fs: { allow: [repoRoot] },
    // The compile bridge (npm run bridge). changeOrigin makes the Host header name the bridge,
    // which its DNS-rebinding guard requires. When the bridge goes away mid-response (its watch
    // stream), the browser's response is cut too, so the app notices and reconnects.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5175',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            proxyRes.on('close', () => {
              if (!res.writableEnded) res.destroy();
            });
          });
        },
      },
    },
  },
  preview: { headers: isolationHeaders },
});
