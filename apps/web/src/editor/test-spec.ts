/**
 * A recorded test as a `.bench.json` spec (BT50; the format is apps/cli/src/spec.ts). The
 * circuit goes in inline — the spec replays exactly what was recorded against — and the firmware
 * as paths the user names (the browser can't know where their builds live; they're relative to
 * where the spec is saved). Steps keep the recording's exact times; a microSD card starts with
 * the files it had when the recording began (BT144), each board with its EEPROM or flash data
 * (BT156: `memory`, sectors at hex offsets, trailing erased bytes trimmed). DOM-free: the dialog
 * (ui/RecordDialog.tsx) and the Node tests share it.
 */

import type { ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { quoted, timeText } from '../sim/recording.ts';
import type { RecordedTest } from '../sim/protocol.ts';

export { quoted, timeText };

export interface SpecDraft {
  name: string;
  /** The circuit the recording ran on. */
  doc: ProjectDoc;
  /** Board part id → firmware path, relative to the spec file. */
  firmware: Readonly<Record<string, string>>;
  test: RecordedTest;
  /** The expectations to keep (normally a subset of `test.proposals`). */
  expectations: readonly string[];
}

/** The spec's JSON value. */
export function buildSpec(draft: SpecDraft): Record<string, unknown> {
  const boards = Object.keys(draft.firmware);
  const steps = draft.test.steps.map((step) => {
    const at = timeText(step.at);
    if ('serial' in step) return { at, ...(boards.length > 1 ? { board: step.board } : {}), serial: step.serial };
    if ('input' in step) return { at, part: step.part, input: step.input };
    const { at: _ns, ...file } = step; // BT144: write (text or base64) and remove steps are spec steps as they are
    return { at, ...file };
  });
  // BT144: cards start with the files they had when the recording began (a reset keeps them).
  const cards = draft.test.cards;
  const project = Object.keys(cards).length === 0 ? draft.doc : { ...draft.doc, parts: draft.doc.parts.map((p) => (Object.hasOwn(cards, p.id) ? { ...p, props: { ...p.props, files: cards[p.id] } } : p)) };
  // BT156: boards start with the data they held when the recording began (a reset keeps it).
  const memory = Object.entries(draft.test.memory).filter(([board, sectors]) => Object.hasOwn(draft.firmware, board) && sectors.length > 0);
  return {
    name: draft.name,
    project,
    firmware: { ...draft.firmware },
    ...(memory.length > 0 ? { memory: Object.fromEntries(memory.map(([board, sectors]) => [board, sectors.map((s) => ({ offset: `0x${s.offset.toString(16)}`, base64: s.base64 }))])) } : {}),
    duration: timeText(draft.test.durationNs),
    ...(steps.length > 0 ? { steps } : {}),
    expect: [...draft.expectations],
  };
}

/** Pretty JSON with a trailing newline, as committed specs are. */
export function specText(draft: SpecDraft): string {
  return `${JSON.stringify(buildSpec(draft), null, 2)}\n`;
}

/** A file name for the spec: the name's letters and digits, `.bench.json`. */
export function specFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug === '' ? 'recorded-test' : slug}.bench.json`;
}

/** Firmware paths to start from: `<board>.hex` for AVR boards, `<board>.bin` for the ESP32. */
export function defaultFirmwarePaths(doc: ProjectDoc): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const part of doc.parts) {
    const mcu = CATALOG.get(part.type)?.board?.mcu;
    if (mcu !== undefined) paths[part.id] = `${part.id}.${mcu === 'esp32' || mcu === 'esp32c3' || mcu === 'esp32s3' || mcu === 'esp32s2' ? 'bin' : 'hex'}`;
  }
  return paths;
}
