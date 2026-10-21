import { createReadStream, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO } from '../../packages/rp2040/src/micropython-manifest.ts';
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
 * Dev only (BT34): the simulation worker fetches the ESP32 ROM ELF from /esp32-rom/, served
 * straight from the git-ignored .cache/esp32-rom that `npm run fetch:esp32-rom` fills. It is
 * never copied into dist; a missing file is a 404 the worker turns into a Problem.
 */
function esp32Rom(): Plugin {
  const file = resolve(repoRoot, '.cache/esp32-rom/esp32_rev0_rom.elf');
  return {
    name: 'benchtop-esp32-rom',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/esp32-rom/esp32_rev0_rom.elf', (_req, res) => {
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('ESP32 ROM not installed: run npm run fetch:esp32-rom');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Dev only (BT63): the worker fetches the Pico's stock MicroPython UF2 from /micropython/,
 * served from the git-ignored .cache/micropython that `npm run fetch:micropython` fills — like
 * the ESP32 ROM, never part of the build; a missing file is a 404 MicroPython sketches report.
 */
function micropython(): Plugin {
  const file = resolve(repoRoot, MICROPYTHON_CACHE_DIR, MICROPYTHON_PICO.name);
  return {
    name: 'benchtop-micropython',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(`/micropython/${MICROPYTHON_PICO.name}`, (_req, res) => {
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end('MicroPython not installed: run npm run fetch:micropython');
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        createReadStream(file).pipe(res);
      });
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
  plugins: [esp32Rom(), micropython(), appShell()],
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
