/**
 * The MicroPython builds Benchtop runs (BT63, human-approved 2026-10-21): the stock v1.29.0 UF2s
 * from micropython.org (MIT), pinned. `npm run fetch:micropython` downloads them (with a human's
 * approval) into MICROPYTHON_CACHE_DIR (git-ignored) and requires each file's size and SHA-256
 * to equal the pinned ones below; they are never committed. micropython.org publishes no
 * checksums: the hashes were recorded on the first approved download (`-- --yes --record`,
 * 2026-10-21; two downloads, one with curl, agreed).
 */

export const MICROPYTHON_VERSION = '1.29.0';
/** Relative to the repository root. */
export const MICROPYTHON_CACHE_DIR = '.cache/micropython';

export interface MicroPythonBuild {
  /** The UF2's file name, in the cache and in its URL. */
  name: string;
  url: string;
  bytes: number;
  sha256: string;
}

/** The Raspberry Pi Pico (RP2040) build. */
export const MICROPYTHON_PICO: MicroPythonBuild = {
  name: 'RPI_PICO-20260824-v1.29.0.uf2',
  url: 'https://micropython.org/resources/firmware/RPI_PICO-20260824-v1.29.0.uf2',
  bytes: 680_960,
  sha256: 'e1160e602e277d85920adb5fe741435edccba9ba6ecadc85fdab75252eeff4e9',
};

/** The Raspberry Pi Pico 2 build for its RISC-V cores (RP2350; phase 19). */
export const MICROPYTHON_PICO2_RISCV: MicroPythonBuild = {
  name: 'RPI_PICO2-RISCV-20260824-v1.29.0.uf2',
  url: 'https://micropython.org/resources/firmware/RPI_PICO2-RISCV-20260824-v1.29.0.uf2',
  bytes: 835_584,
  sha256: '358075afe8ed165223d35e0252ede629808a5ab0f04844ecaf89205e7cbe158b',
};

export const MICROPYTHON_BUILDS: readonly MicroPythonBuild[] = [MICROPYTHON_PICO, MICROPYTHON_PICO2_RISCV];
