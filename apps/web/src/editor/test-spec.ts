/**
 * A recorded test as a `.bench.json` spec (BT50; the format is apps/cli/src/spec.ts). The
 * circuit goes in inline — the spec replays exactly what was recorded against — and the firmware
 * as paths the user names (the browser can't know where their builds live; they're relative to
 * where the spec is saved). Steps keep the recording's exact times. DOM-free: the dialog
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
  const steps = draft.test.steps.map((step) =>
    'serial' in step
      ? { at: timeText(step.at), ...(boards.length > 1 ? { board: step.board } : {}), serial: step.serial }
      : { at: timeText(step.at), part: step.part, input: step.input },
  );
  return {
    name: draft.name,
    project: draft.doc,
    firmware: { ...draft.firmware },
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
    if (mcu !== undefined) paths[part.id] = `${part.id}.${mcu === 'esp32' ? 'bin' : 'hex'}`;
  }
  return paths;
}
