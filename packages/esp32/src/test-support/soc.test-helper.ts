/**
 * Esp32Soc for tests (Node-only): optionally with the cached ROM in ROM0 and a fixtures/xtensa
 * program in SRAM0 at 0x40080000 (the programs' link address), PC there. `run` runs the PRO_CPU
 * until `break 1, 15`, a fault or a step cap, like BareMachine.run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { parseRomElf } from '../boot/rom.ts';
import { Esp32Soc, type Esp32SocOptions } from '../soc/soc.ts';
import { HALT, type XtensaCore } from '../xtensa/cpu.ts';
import { loadCachedRom } from './rom.test-helper.ts';

export interface TestSocOptions extends Esp32SocOptions {
  rom?: boolean;
  /** fixtures/xtensa/<program>.bin, loaded at 0x40080000 with the PRO_CPU's PC there. */
  program?: string;
}

export function createTestSoc(options: TestSocOptions = {}): Esp32Soc {
  const soc = new Esp32Soc(options.flashSize === undefined ? {} : { flashSize: options.flashSize });
  if (options.rom === true) soc.loadRom(parseRomElf(loadCachedRom()));
  const pro = soc.cores[0];
  // `break 1, 15` ends a test program, as on the bare machine.
  pro.breakHook = (s, t) => s === 1 && t === 15;
  if (options.program !== undefined) {
    soc.memory.load(0x40080000, new Uint8Array(readFileSync(join(REPO_ROOT, 'fixtures', 'xtensa', `${options.program}.bin`))));
    pro.pc = 0x40080000;
  }
  return soc;
}

/** Runs the PRO_CPU up to `maxSteps` cycles; still running at the end is a fault ("step cap"). */
export function runPro(soc: Esp32Soc, maxSteps = 10_000_000): XtensaCore {
  const core = soc.cores[0];
  core.run(maxSteps);
  if (core.halt === HALT.RUNNING) {
    core.halt = HALT.FAULT;
    core.haltReason = 'step cap';
  }
  return core;
}
