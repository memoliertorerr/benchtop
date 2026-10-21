/**
 * Runs a gallery example in Node (BT43): its project and every board's committed firmware, on
 * the worker's bench environment with the analog layer, as the app opens it. A check drives the
 * run — `runTo`, inputs, serial — and reads what happened: serial text per board, each part's
 * latest visual state and its history, pin states.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleBench, type Bench, type FirmwareImage, NS_PER_MS, type PartInput, parseProject, type VisualState } from '@benchtop/core';
import { analogSpecFor, applyTftUpdate, sevenSegmentText as decodeSevenSegment, TFT_PACKED, TFT_WIDTH, unpackPixel } from '@benchtop/parts';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { loadCachedRom } from '../../../../packages/esp32/src/test-support/rom.test-helper.ts';
import { createBenchEnv } from '../sim/env.ts';
import type { Example } from './manifest.ts';

export interface ExampleRun {
  bench: Bench;
  /** Runs to `ms` of simulated time, collecting frames every 5 ms. */
  runTo(ms: number): void;
  input(part: string, event: PartInput): void;
  /** Serial text a board sent so far. */
  serial(board: string): string;
  /** A part's latest visual state. */
  visual(part: string): VisualState | undefined;
  /** Every visual state a part had, with its time (ms). */
  history(part: string): { t: number; visual: VisualState }[];
  /** Whether an LED part is lit now (brightness over 0.3). */
  lit(part: string): boolean;
  /** Characters of an LCD visual as rows of `cols`. */
  rows(part: string, cols: number): string[];
  /** Feeds a sine (`hz`, amplitude 0.5) into a microphone part up to `ms`, as simulated time runs. */
  listen(part: string, hz: number, ms: number): void;
}

function image(firmware: string): FirmwareImage {
  const path = join(REPO_ROOT, 'fixtures', 'firmware', firmware);
  if (firmware.endsWith('.hex')) return { format: 'hex', text: readFileSync(path, 'utf8') };
  return { format: 'esp32-bin', app: new Uint8Array(readFileSync(path)), partitions: new Uint8Array(readFileSync(path.replace(/\.bin$/, '.partitions.bin'))) };
}

export function runExample(example: Example): ExampleRun {
  const parsed = parseProject(JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'projects', `${example.project}.json`), 'utf8')));
  if (!parsed.ok) throw new Error(`${example.id}: ${JSON.stringify(parsed.errors[0])}`);
  const images: Record<string, FirmwareImage> = {};
  for (const [board, files] of Object.entries(example.boards)) images[board] = image(files.firmware);
  const rom = Object.values(example.boards).some((b) => b.firmware.startsWith('esp32/')) ? loadCachedRom() : undefined;
  const bench = assembleBench(parsed.doc, createBenchEnv(rom), images, { analogSpecFor });
  const text: Record<string, string> = {};
  for (const board of Object.keys(example.boards)) {
    text[board] = '';
    bench.onSerial(board, (bytes) => (text[board] += String.fromCharCode(...bytes)));
  }
  const latest = new Map<string, VisualState>();
  const past = new Map<string, { t: number; visual: VisualState }[]>();
  const collect = (): void => {
    const t = bench.now() / NS_PER_MS;
    for (const [part, visual] of bench.collectFrame().parts) {
      const copy = structuredClone(visual);
      latest.set(part, copy);
      let list = past.get(part);
      if (list === undefined) past.set(part, (list = []));
      list.push({ t, visual: copy });
    }
  };
  collect();
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) {
      bench.runUntil(t * NS_PER_MS);
      collect();
    }
  };
  const mic = { kind: 'value' as const, value: 0 };
  let micSamples = 0;
  return {
    bench,
    runTo,
    input: (part, event) => bench.input(part, event),
    serial: (board) => text[board] ?? '',
    visual: (part) => latest.get(part),
    history: (part) => past.get(part) ?? [],
    lit: (part) => ((latest.get(part)?.brightness as number | undefined) ?? 0) > 0.3,
    rows(part, cols) {
      const chars = (latest.get(part)?.characters ?? []) as number[];
      const out: string[] = [];
      for (let i = 0; i < chars.length; i += cols) out.push(String.fromCharCode(...chars.slice(i, i + cols)));
      return out;
    },
    listen(part, hz, ms) {
      for (let at = Math.floor(bench.now() / NS_PER_MS) + 20; at <= ms; at += 20) {
        for (const end = at * 16; micSamples < end; micSamples++) {
          mic.value = 0.5 * Math.sin((2 * Math.PI * hz * micSamples) / 16_000);
          bench.input(part, mic);
        }
        runTo(at);
      }
    },
  };
}

/** The digits a 7-segment visual shows (@benchtop/parts' decoder, BT49). */
export function sevenSegmentText(visual: VisualState | undefined): string {
  return decodeSevenSegment((visual?.values ?? []) as number[]);
}

/** RGB565 pixels of a TFT part, folded from every update its history saw (as the UI does). */
export function tftPixels(r: ExampleRun, part: string, points: readonly (readonly [number, number])[]): number[] {
  const frame = new Array<number>(TFT_PACKED).fill(0);
  for (const { visual } of r.history(part)) applyTftUpdate(frame, visual);
  return points.map(([x, y]) => unpackPixel(frame, y * TFT_WIDTH + x));
}
