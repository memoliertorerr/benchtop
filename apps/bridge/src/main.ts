/**
 * Starts the compile bridge:
 *   node apps/bridge/src/main.ts [--port 5175] [--serve [dir]] [--network host:port[,…]]
 * `npm run bridge` runs it for the Vite dev server (which proxies /api to it); `npm start` builds
 * the app and serves it from the bridge on one origin. BT101: `--network` lets the app's
 * simulated WiFi reach those real hosts (only those, and only where the project allows them
 * too); without it nothing leaves the machine.
 */

import { resolve } from 'node:path';
import { arduinoCliCandidates, findArduinoCli } from './compile.ts';
import { parseNetworkList } from './network.ts';
import { createBridge, DEFAULT_SERVE_DIR } from './server.ts';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 5175;
const serveIndex = args.indexOf('--serve');
const serveArg = serveIndex >= 0 ? args[serveIndex + 1] : undefined;
const serveDir = serveIndex < 0 ? undefined : serveArg !== undefined && !serveArg.startsWith('--') ? resolve(serveArg) : DEFAULT_SERVE_DIR;

const networkIndex = args.indexOf('--network');
const networkArg = networkIndex >= 0 ? (args[networkIndex + 1] ?? '') : '';
const network = parseNetworkList(networkArg);

if (!Number.isInteger(port) || port < 0 || port > 65535 || network.errors.length > 0 || (networkIndex >= 0 && network.entries.length === 0)) {
  if (network.errors.length > 0) console.error(`--network: ${network.errors.join('; ')}`);
  console.error('usage: node apps/bridge/src/main.ts [--port 5175] [--serve [dir]] [--network host:port[,host:port…]]');
  process.exit(2);
}

const cli = findArduinoCli();
if (cli === undefined) {
  console.warn(`arduino-cli not found (looked in ${arduinoCliCandidates().join(', ')}); compiles will fail until it is installed.`);
}
const bridge = createBridge({ cli, ...(serveDir === undefined ? {} : { serveDir }), network: network.entries });
const listening = await bridge.listen(port);
console.info(`Benchtop bridge on http://127.0.0.1:${listening}${serveDir === undefined ? '' : ` (serving ${serveDir})`}`);
if (network.entries.length > 0) console.info(`The simulated WiFi may reach: ${network.entries.map((e) => `${e.host}:${e.port}`).join(', ')} (where a project allows them too).`);
