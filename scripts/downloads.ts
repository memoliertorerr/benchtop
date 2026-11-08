/**
 * The downloads the app's simulation worker fetches (BT147): each URL path → its file in the
 * git-ignored .cache that a fetch script fills (the ESP32, ESP32-C3 and ESP32-S3 ROMs, the
 * RP2350 bootrom, the Pico's and Pico 2's MicroPython UF2s). The dev server (apps/web
 * vite.config.ts) and the bridge's static serving (`npm start`) both answer from this table, for
 * these exact names only. No Node or DOM imports: Vite's config and the bridge both read it.
 */

import { ROM_CACHE_DIR as ESP32_ROM_CACHE_DIR, ROM_ELF_NAME as ESP32_ROM_ELF_NAME } from '../packages/esp32/src/boot/rom-manifest.ts';
import { C3_ROM_CACHE_DIR, C3_ROM_ELF_NAME } from '../packages/esp32c3/src/rom-manifest.ts';
import { S3_ROM_CACHE_DIR, S3_ROM_ELF_NAME } from '../packages/esp32s3/src/rom-manifest.ts';
import { MICROPYTHON_BUILDS, MICROPYTHON_CACHE_DIR } from '../packages/rp2040/src/micropython-manifest.ts';
import { ROM_CACHE_DIR as RP2350_ROM_CACHE_DIR, ROM_IMAGE as RP2350_ROM_IMAGE } from '../packages/rp2350/src/rom-manifest.ts';

export interface Download {
  /** The URL path the worker fetches. */
  readonly path: string;
  /** The file, from the repository root. */
  readonly file: string;
  /** What it is, for the 404's text. */
  readonly what: string;
  /** The command that fetches it. */
  readonly fetch: string;
}

export const DOWNLOADS: readonly Download[] = [
  { path: `/esp32-rom/${ESP32_ROM_ELF_NAME}`, file: `${ESP32_ROM_CACHE_DIR}/${ESP32_ROM_ELF_NAME}`, what: 'ESP32 ROM', fetch: 'npm run fetch:esp32-rom' },
  { path: `/esp32c3-rom/${C3_ROM_ELF_NAME}`, file: `${C3_ROM_CACHE_DIR}/${C3_ROM_ELF_NAME}`, what: 'ESP32-C3 ROM', fetch: 'npm run fetch:esp32-rom' },
  { path: `/esp32s3-rom/${S3_ROM_ELF_NAME}`, file: `${S3_ROM_CACHE_DIR}/${S3_ROM_ELF_NAME}`, what: 'ESP32-S3 ROM', fetch: 'npm run fetch:esp32-rom' },
  { path: `/rp2350-rom/${RP2350_ROM_IMAGE.name}`, file: `${RP2350_ROM_CACHE_DIR}/${RP2350_ROM_IMAGE.name}`, what: 'RP2350 bootrom', fetch: 'npm run fetch:rp2350-rom' },
  ...MICROPYTHON_BUILDS.map((build) => ({ path: `/micropython/${build.name}`, file: `${MICROPYTHON_CACHE_DIR}/${build.name}`, what: 'MicroPython', fetch: 'npm run fetch:micropython' })),
];

/** The folders those paths are in: nothing else under them is served. */
export const DOWNLOAD_FOLDERS: readonly string[] = [...new Set(DOWNLOADS.map((d) => d.path.slice(0, d.path.lastIndexOf('/') + 1)))];

/** The download a URL path names, `null` for another name in one of their folders, or undefined. */
export function downloadFor(pathname: string): Download | null | undefined {
  const download = DOWNLOADS.find((d) => d.path === pathname);
  if (download !== undefined) return download;
  return DOWNLOAD_FOLDERS.some((folder) => pathname.startsWith(folder)) ? null : undefined;
}

/** The 404's text for a download that isn't there yet. */
export function missingText(download: Download): string {
  return `${download.what} not installed: run ${download.fetch}`;
}
