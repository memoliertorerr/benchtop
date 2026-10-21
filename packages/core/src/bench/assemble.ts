/**
 * Project → running Bench, shared by the simulation worker and the headless CLI: validate the
 * document (`parseProject`), build the bench from the injected environment (part definitions,
 * an MCU per board) and options (analog specs), attach each board's firmware, and reset so
 * every part starts from its power-on state and reports it once.
 */

import type { FirmwareImage } from '../contracts/mcu.ts';
import type { ProjectDoc } from '../contracts/project.ts';
import { parseProject } from '../project/validate.ts';
import { Bench, type BenchEnv, type BenchOptions } from './bench.ts';

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectError';
  }
}

/** The validated document, or a ProjectError naming up to the first 10 problems. */
export function validateProject(doc: unknown): ProjectDoc {
  const parsed = parseProject(doc);
  if (parsed.ok) return parsed.doc;
  const shown = parsed.errors.slice(0, 10).map((e) => `${e.path || '/'} ${e.message}`);
  throw new ProjectError(`invalid project: ${shown.join('; ')}${parsed.errors.length > 10 ? ` (+${parsed.errors.length - 10} more)` : ''}`);
}

/**
 * A bench for `doc` with `firmware` (board part id → image) attached and reset. Throws
 * ProjectError for an invalid document; firmware errors (a bad .hex) propagate as thrown by
 * the MCU.
 */
export function assembleBench(doc: unknown, env: BenchEnv, firmware: Readonly<Record<string, FirmwareImage>>, options: BenchOptions = {}): Bench {
  const bench = new Bench(validateProject(doc), env, options);
  try {
    for (const [board, image] of Object.entries(firmware)) bench.attachFirmware(board, image);
    bench.reset();
  } catch (error) {
    bench.dispose();
    throw error;
  }
  return bench;
}
