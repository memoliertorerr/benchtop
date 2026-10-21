/**
 * Starts the compile bridge:
 *   node apps/bridge/src/main.ts [--port 5175] [--serve [dir]]
 * `npm run bridge` runs it for the Vite dev server (which proxies /api to it); `npm start` builds
 * the app and serves it from the bridge on one origin.
 */

import { resolve } from 'node:path';
import { arduinoCliCandidates, findArduinoCli } from './compile.ts';
import { createBridge, DEFAULT_SERVE_DIR } from './server.ts';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 5175;
const serveIndex = args.indexOf('--serve');
const serveArg = serveIndex >= 0 ? args[serveIndex + 1] : undefined;
const serveDir = serveIndex < 0 ? undefined : serveArg !== undefined && !serveArg.startsWith('--') ? resolve(serveArg) : DEFAULT_SERVE_DIR;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('usage: node apps/bridge/src/main.ts [--port 5175] [--serve [dir]]');
  process.exit(2);
}

const cli = findArduinoCli();
if (cli === undefined) {
  console.warn(`arduino-cli not found (looked in ${arduinoCliCandidates().join(', ')}); compiles will fail until it is installed.`);
}
const bridge = createBridge({ cli, ...(serveDir === undefined ? {} : { serveDir }) });
const listening = await bridge.listen(port);
console.info(`Benchtop bridge on http://127.0.0.1:${listening}${serveDir === undefined ? '' : ` (serving ${serveDir})`}`);
