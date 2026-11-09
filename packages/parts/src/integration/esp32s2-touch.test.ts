import { assembleBench, type Bench, type BenchEnv, type FirmwareImage, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { esp32s2McuFactory } from '@benchtop/esp32s2';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { loadCachedS2Rom } from '../../../esp32s2/src/test-support/rom.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// BT155: the S2's touch sensor on a full Bench — touch pads on its touch pins (TOUCH1–14 =
// GPIO1–14), through the bench's TouchSensing seam, with Arduino's touchRead and
// touchAttachInterrupt (fixtures/sketches/esp32s2/touch-read, touch-interrupt).

const env: BenchEnv = { part: benchEnvParts, createMcu: esp32s2McuFactory(loadCachedS2Rom()) };

function image(name: string): FirmwareImage {
  return { format: 'esp32-bin', app: readFixture(`fixtures/firmware/esp32s2/${name}.bin`), partitions: readFixture(`fixtures/firmware/esp32s2/${name}.partitions.bin`) };
}

const wire = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { part: a, pin: ap }, to: { part: b, pin: bp }, waypoints: [], color: 'green' });

/** An S2 with a touch pad on IO5, or one reached through a breadboard strip. */
function doc(viaBreadboard = false, padPf = 2): ProjectDoc {
  return {
    format: 1,
    name: 's2-touch',
    parts: [
      { id: 's2', type: 'esp32-s2-devkitm-1', x: 0, y: 0, rotation: 0, props: {} },
      { id: 'pad', type: 'touch-pad', x: -40, y: 10, rotation: 0, props: { padPf } },
      ...(viaBreadboard ? [{ id: 'bb', type: 'breadboard-half', x: -90, y: 0, rotation: 0, props: {} }] : []),
    ],
    wires: viaBreadboard ? [wire('w1', 's2', 'IO5', 'bb', '5t.a'), wire('w2', 'pad', 'PAD', 'bb', '5t.e')] : [wire('w1', 's2', 'IO5', 'pad', 'PAD')],
    firmware: {},
  } as ProjectDoc;
}

function live(project: ProjectDoc, firmware: string) {
  let bench: Bench = assembleBench(project, env, { s2: image(firmware) });
  let serial = '';
  const listen = (b: Bench): void => b.onSerial('s2', (bytes) => (serial += String.fromCharCode(...bytes)));
  listen(bench);
  return {
    bench: () => bench,
    serial: () => serial,
    runTo(ms: number): void {
      for (let t = Math.floor(bench.now() / NS_PER_MS) + 5; t <= ms; t += 5) bench.runUntil(t * NS_PER_MS);
    },
    edit(next: ProjectDoc): void {
      bench = assembleBench(next, env, { s2: image(firmware) }, { carry: bench.carry() });
      listen(bench);
    },
  };
}

/** The last complete "t1 … t5 …" reading. */
function lastReading(serial: string): { t1: number; t5: number } {
  const lines = [...serial.matchAll(/t1 (\d+) t5 (\d+)\n/g)];
  const last = lines.at(-1);
  if (last === undefined) throw new Error(`no reading in ${JSON.stringify(serial.slice(-200))}`);
  return { t1: Number(last[1]), t5: Number(last[2]) };
}

describe('the S2’s touch pins on the bench (BT155)', () => {
  it('touchRead: a bare pin reads the chip’s own pad, a touch pad more, a finger on it far more — and back on release', () => {
    const r = live(doc(), 'touch-read');
    r.runTo(600);
    expect(r.serial()).toContain('touch ready');
    const idle = lastReading(r.serial());
    expect(idle.t1).toBeGreaterThan(15_000); // nothing on IO1: the pad alone (≈ 19,400)
    expect(idle.t1).toBeLessThan(22_000);
    expect(idle.t5).toBeGreaterThan(idle.t1); // the touch pad's electrode adds a little
    expect(idle.t5 - idle.t1).toBeLessThan(6_000);
    r.bench().input('pad', { kind: 'press' });
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    const touched = lastReading(r.serial());
    expect(touched.t5 - idle.t5).toBeGreaterThan(10_000);
    expect(touched.t1).toBe(idle.t1); // the other channel doesn't move
    r.bench().input('pad', { kind: 'value', value: 0.5 });
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    const half = lastReading(r.serial());
    expect(half.t5).toBeGreaterThan(idle.t5 + 3_000);
    expect(half.t5).toBeLessThan(touched.t5 - 3_000);
    r.bench().input('pad', { kind: 'release' });
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    expect(lastReading(r.serial()).t5).toBe(idle.t5);
    expect(r.bench().problems().filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('a pad reached through a breadboard counts; an edit that keeps the board re-links it (a bigger electrode reads higher)', () => {
    const r = live(doc(true), 'touch-read');
    r.runTo(600);
    const viaStrip = lastReading(r.serial());
    expect(viaStrip.t5 - viaStrip.t1).toBeGreaterThan(2_000);
    r.bench().input('pad', { kind: 'press' });
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    expect(lastReading(r.serial()).t5 - viaStrip.t5).toBeGreaterThan(10_000);
    r.bench().input('pad', { kind: 'release' });
    r.runTo(r.bench().now() / NS_PER_MS + 100);
    r.edit(doc(true, 6)); // the pad's prop changed: a new model, the same running MCU
    expect(r.bench().carriedBoard('s2')).toBe(true);
    r.runTo(r.bench().now() / NS_PER_MS + 200);
    expect(lastReading(r.serial()).t5).toBeGreaterThan(viaStrip.t5 + 5_000);
  });

  it('touchAttachInterrupt: one call on a touch, one on the release (touchInterruptGetLastStatus says which)', () => {
    const r = live(doc(), 'touch-interrupt');
    r.runTo(500);
    expect(r.serial()).toContain('ready');
    expect(r.serial()).not.toContain('count');
    r.bench().input('pad', { kind: 'press' });
    r.runTo(r.bench().now() / NS_PER_MS + 100);
    expect(r.serial()).toContain('touched count 1');
    r.runTo(r.bench().now() / NS_PER_MS + 300); // held: no more calls
    expect(r.serial()).not.toContain('count 2');
    r.bench().input('pad', { kind: 'release' });
    r.runTo(r.bench().now() / NS_PER_MS + 100);
    expect(r.serial()).toContain('released count 2');
    r.bench().input('pad', { kind: 'press' });
    r.runTo(r.bench().now() / NS_PER_MS + 100);
    expect(r.serial()).toContain('touched count 3');
  });
});
