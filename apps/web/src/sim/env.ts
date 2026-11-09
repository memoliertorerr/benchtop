/**
 * The bench environment the worker runs: part definitions from the catalog, MCUs from the AVR
 * factory, (BT34) the ESP32 factory, which gets the ROM the worker fetched (undefined: the
 * board reports `esp32-rom-missing`), and (BT60) the RP2040 factory, with (BT63) the stock
 * MicroPython UF2 the worker fetched for MicroPython sketches, and (BT66) the RP2350 factory with
 * the bootrom it fetched, and (BT94) the ESP32-C3 factory with its ROM. Each MCU created is recorded per
 * board part id so the session can report its simulated clock rate.
 */

import { avrMcuFactory } from '@benchtop/avr';
import type { BenchEnv, Mcu } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { esp32c3McuFactory } from '@benchtop/esp32c3';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { esp32s3McuFactory } from '@benchtop/esp32s3';
import { benchEnvParts } from '@benchtop/parts';
import { rp2040McuFactory } from '@benchtop/rp2040';
import { rp2350McuFactory } from '@benchtop/rp2350';

export interface RecordingEnv extends BenchEnv {
  /** MCUs created for the current bench, by board part id. */
  readonly mcus: Map<string, Mcu>;
}

/** The downloaded files boards need (undefined: not there — the board then says so). */
export interface BenchRoms {
  esp32Rom?: Uint8Array | undefined;
  micropython?: Uint8Array | undefined;
  rp2350Rom?: Uint8Array | undefined;
  /** BT67: the Pico 2's (RISC-V) MicroPython UF2. */
  micropythonPico2?: Uint8Array | undefined;
  /** BT94: the ESP32-C3's ROM ELF. */
  esp32c3Rom?: Uint8Array | undefined;
  /** BT126: the ESP32-S3's ROM ELF. */
  esp32s3Rom?: Uint8Array | undefined;
  /** BT150: the ESP32-S2's ROM ELF. */
  esp32s2Rom?: Uint8Array | undefined;
}

export function createBenchEnv(roms: BenchRoms = {}): RecordingEnv {
  const mcus = new Map<string, Mcu>();
  const esp32 = esp32McuFactory(roms.esp32Rom);
  const esp32c3 = esp32c3McuFactory(roms.esp32c3Rom);
  const esp32s3 = esp32s3McuFactory(roms.esp32s3Rom);
  const esp32s2 = esp32s2McuFactory(roms.esp32s2Rom);
  return {
    mcus,
    part: benchEnvParts,
    createMcu(board, partId, report, props) {
      const mcu = avrMcuFactory(board) ?? esp32(board, partId, report, props) ?? esp32c3(board, partId, report) ?? esp32s3(board, partId, report, props) ?? esp32s2(board, partId, report, props) ?? rp2040McuFactory(board, partId, report, roms.micropython) ?? rp2350McuFactory(board, partId, report, { rom: roms.rp2350Rom, micropython: roms.micropythonPico2 });
      if (mcu !== undefined) mcus.set(partId, mcu);
      return mcu;
    },
  };
}
