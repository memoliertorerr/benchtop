import { avrMcuFactory } from '@benchtop/avr';
import { Bench, type BenchEnv, type I2cDevice, NS_PER_MS, parseProject, type PartDefinition, type ProjectDoc, type VisualState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixtureText } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { benchEnvParts } from '../catalog.ts';

// The SSD1306 on a full Bench with real firmware (Adafruit_SSD1306 and raw Wire), plus I2C bus
// generality: two displays, a repeated START, an address conflict.

const project = (name: string): ProjectDoc => JSON.parse(readFixtureText(`fixtures/projects/${name}.json`)) as ProjectDoc;

/** A register device at 0x50 that logs every bus call (a test-only part type). */
const calls: string[] = [];
const testRegs: PartDefinition = {
  type: 'test-regs',
  title: 'test registers',
  category: 'sensors',
  size: { w: 10, h: 10 },
  pins: [
    { name: 'SDA', x: 0, y: 0, role: 'digital' },
    { name: 'SCL', x: 5, y: 0, role: 'digital' },
  ],
  defaults: {},
  createModel(ctx) {
    let register = 0;
    let fresh = false;
    const device: I2cDevice = {
      address: 0x50,
      start(read) {
        calls.push(`start(${read ? 'read' : 'write'})`);
        fresh = !read;
        return true;
      },
      write(byte) {
        calls.push(`write(${byte})`);
        if (fresh) register = byte;
        fresh = false;
        return true;
      },
      read(ack) {
        calls.push(`read(${ack})`);
        return register === 0x05 ? (ack ? 18 : 52) : 0;
      },
      stop() {
        calls.push('stop');
      },
    };
    ctx.attachI2c('SDA', 'SCL', device);
    return {};
  },
};

const env: BenchEnv = { part: (type) => (type === 'test-regs' ? testRegs : benchEnvParts(type)), createMcu: avrMcuFactory };

function load(doc: ProjectDoc, firmware: string) {
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const bench = new Bench(parsed.doc, env);
  bench.attachFirmware('uno', { format: 'hex', text: readFixtureText(`fixtures/firmware/uno/${firmware}.hex`) });
  let text = '';
  /** Complete serial lines with the simulated ms at which they ended. */
  const lines: { text: string; ms: number }[] = [];
  bench.onSerial('uno', (bytes) => {
    text += String.fromCharCode(...bytes);
    let end: number;
    while ((end = text.indexOf('\r\n')) >= 0) {
      lines.push({ text: text.slice(0, end), ms: bench.now() / NS_PER_MS });
      text = text.slice(end + 2);
    }
  });
  const latest = new Map<string, VisualState>();
  /** Every frame a part appeared in, with its ms. */
  const updates: { part: string; ms: number }[] = [];
  const runTo = (ms: number): void => {
    for (let t = Math.floor(bench.now() / NS_PER_MS) + 1; t <= ms; t++) {
      bench.runUntil(t * NS_PER_MS);
      for (const [part, visual] of bench.collectFrame().parts) {
        latest.set(part, structuredClone(visual));
        updates.push({ part, ms: t });
      }
    }
  };
  return { bench, latest, updates, lines, runTo };
}

/** The packed fb (256 numbers) as 1024 page-major bytes. */
function unpack(visual: VisualState | undefined): number[] {
  const fb = (visual?.fb ?? []) as number[];
  const bytes: number[] = [];
  for (let i = 0; i < 1024; i++) bytes.push((fb[i >> 2] >>> (8 * (i & 3))) & 0xff);
  return bytes;
}

const pixel = (bytes: number[], x: number, y: number): number => (bytes[(y >> 3) * 128 + x] >> (y & 7)) & 1;

describe('SSD1306 with Adafruit_SSD1306', () => {
  it('shows the frame the library buffered, then inverts, dims, turns off and on, and skips identical frames', () => {
    const { bench, latest, updates, lines, runTo } = load(project('ssd1306-adafruit'), 'ssd1306-adafruit');
    expect(bench.problems()).toEqual([]);
    runTo(990);
    const dump = lines.find((l) => l.text.startsWith('FB:'));
    expect(lines.map((l) => l.text)).not.toContain('alloc failed');
    expect(dump?.text).toHaveLength(3 + 2048);
    const buffer = Array.from({ length: 1024 }, (_, i) => Number.parseInt(dump!.text.slice(3 + 2 * i, 5 + 2 * i), 16));
    const shown = unpack(latest.get('oled'));
    expect(shown).toEqual(buffer);
    expect(pixel(shown, 0, 0)).toBe(1);
    expect(pixel(shown, 127, 63)).toBe(1);
    expect(buffer.filter((b) => b !== 0).length).toBeGreaterThan(100); // border, text, circle
    expect(latest.get('oled')).toMatchObject({ on: true, invert: false, allOn: false, contrast: 0xcf });

    runTo(1010);
    expect(latest.get('oled')?.invert).toBe(true);
    runTo(1490);
    expect(latest.get('oled')?.contrast).toBe(0xcf);
    runTo(1510);
    expect(latest.get('oled')?.contrast).toBe(0);
    runTo(1990);
    expect(latest.get('oled')?.on).toBe(true);
    runTo(2010);
    expect(latest.get('oled')?.on).toBe(false);
    runTo(2490);
    expect(latest.get('oled')?.on).toBe(false);
    runTo(2510);
    expect(latest.get('oled')?.on).toBe(true);

    runTo(3600); // 50 display() calls take ~0.8 s of simulated time
    const start = lines.find((l) => l.text === 'same:');
    const done = lines.find((l) => l.text === 'same done');
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    const during = updates.filter((u) => u.part === 'oled' && u.ms >= start!.ms - 1 && u.ms <= done!.ms + 1);
    expect(during).toHaveLength(1);
    expect(pixel(unpack(latest.get('oled')), 64, 0)).toBe(1);
  });

  it('measures the simulated full-frame rate and MHz in the counter loop', () => {
    const { bench, lines, runTo } = load(project('ssd1306-adafruit'), 'ssd1306-adafruit');
    runTo(3600);
    const start = performance.now();
    runTo(5800);
    const wallMs = performance.now() - start;
    const fps = lines.filter((l) => l.text.startsWith('fps=')).map((l) => Number(l.text.slice(4)));
    expect(fps.length).toBeGreaterThan(0);
    console.info(`ssd1306-adafruit: ${fps.join(', ')} frames per simulated second; ${((2.2 * 16e6) / (wallMs * 1000)).toFixed(1)} simulated MHz`);
    expect(bench.problems()).toEqual([]);
    expect(fps[0]).toBeGreaterThan(5);
  }, 30_000); // 4.6 s of simulated time: ~5 s of wall time alone, more under load
});

/** Expected GDDRAM after ssd1306-raw's two patterns. */
function rawPattern(): number[] {
  const bytes: number[] = [];
  for (let page = 0; page < 8; page++) for (let col = 0; col < 128; col++) bytes.push(page % 2 === 0 ? 0xff : 0x00);
  for (let k = 0; k < 128; k++) {
    const page = 2 + (k % 4);
    const col = 64 + Math.floor(k / 4);
    bytes[page * 128 + col] = Math.floor(k / 4) % 2 === 0 ? 0x0f : 0xf0;
  }
  return bytes;
}

describe('SSD1306 with raw Wire, and the I2C bus', () => {
  it('ssd1306-raw: page-mode stripes and the vertical-mode window, Co=1 bytes included', () => {
    const { bench, latest, lines, runTo } = load(project('ssd1306-raw'), 'ssd1306-raw');
    expect(bench.problems()).toEqual([]);
    runTo(300);
    expect(lines.map((l) => l.text)).toEqual(['nack3D=2', 'reg=0', 'done']);
    expect(unpack(latest.get('oled'))).toEqual(rawPattern());
    expect(latest.get('oled')?.on).toBe(true);
  });

  /** ssd1306-raw's circuit plus more parts on the same SDA/SCL nets. */
  function withMore(extra: { id: string; type: string; props?: Record<string, string> }[]): ProjectDoc {
    const doc = project('ssd1306-raw');
    for (const [i, part] of extra.entries()) {
      doc.parts.push({ id: part.id, type: part.type, x: 100 + i * 50, y: 0, rotation: 0, props: part.props ?? {} });
      const [sda, scl] = part.type === 'ssd1306' ? ['DATA', 'CLK'] : ['SDA', 'SCL'];
      doc.wires.push(
        { id: `${part.id}-sda`, from: { part: 'uno', pin: 'A4' }, to: { part: part.id, pin: sda }, waypoints: [], color: 'blue' },
        { id: `${part.id}-scl`, from: { part: 'uno', pin: 'A5' }, to: { part: part.id, pin: scl }, waypoints: [], color: 'yellow' },
      );
      if (part.type === 'ssd1306') {
        doc.wires.push(
          { id: `${part.id}-vin`, from: { part: 'uno', pin: '5V' }, to: { part: part.id, pin: 'VIN' }, waypoints: [], color: 'red' },
          { id: `${part.id}-gnd`, from: { part: 'uno', pin: 'GND.2' }, to: { part: part.id, pin: 'GND' }, waypoints: [], color: 'black' },
        );
      }
    }
    return doc;
  }

  it('two displays at 0x3C and 0x3D show different images; a repeated START reads a register', () => {
    calls.length = 0;
    const { bench, latest, lines, runTo } = load(withMore([{ id: 'oled2', type: 'ssd1306', props: { address: '0x3D' } }, { id: 'regs', type: 'test-regs' }]), 'ssd1306-raw');
    expect(bench.problems()).toEqual([]);
    runTo(300);
    expect(lines.map((l) => l.text)).toEqual(['nack3D=0', 'reg=2 18 52', 'done']);
    expect(unpack(latest.get('oled'))).toEqual(rawPattern());
    expect(unpack(latest.get('oled2'))).toEqual(new Array<number>(1024).fill(0x81));
    // Write the register, restart without STOP, read two bytes (ACK, then NACK), STOP.
    expect(calls).toEqual(['start(write)', 'write(5)', 'start(read)', 'read(true)', 'read(false)', 'stop']);
  });

  it('a second display at 0x3C is an i2c-address-conflict', () => {
    const { bench } = load(withMore([{ id: 'oled2', type: 'ssd1306', props: { address: '0x3C' } }]), 'ssd1306-raw');
    expect(bench.problems()).toEqual([expect.objectContaining({ code: 'i2c-address-conflict', parts: ['oled', 'oled2'] })]);
  });
});

describe('SSD1306 hardware scroll (BT180)', () => {
  /** `image` moved `right` columns (wrapping) and `up` rows (wrapping) — 1024 page-major bytes. */
  function moved(image: number[], right: number, up: number): number[] {
    const out = new Array<number>(1024).fill(0);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (pixel(image, (x - right + 128) % 128, (y + up) % 64) === 1) out[(y >> 3) * 128 + x] |= 1 << (y & 7);
    return out;
  }

  it('uno/oled-scroll: Adafruit’s scroll calls move the image one column (and a row) every 57 ms; stopscroll leaves it there', () => {
    const { bench, latest, lines, runTo } = load(project('ssd1306-adafruit'), 'oled-scroll');
    const when = (text: string, after = 0): number => lines.find((l) => l.text === text && l.ms >= after)?.ms ?? Number.NaN;
    while (!lines.some((l) => l.text === 'right') && bench.now() < 2000 * NS_PER_MS) runTo(bench.now() / NS_PER_MS + 1);
    const drawn = unpack(latest.get('oled')); // the scroll's first step is 57 ms away
    expect(lines.map((l) => l.text)).toEqual(['drawn', 'right']);
    expect(pixel(drawn, 16, 24)).toBe(1); // "Benchtop"'s B at (16, 24)
    expect(pixel(drawn, 100, 0)).toBe(1); // the bar along the top
    // 2 s of right scroll at one column per 5 frames of 87.6 Hz: 35 steps, then 1 s standing still.
    const right = when('right');
    runTo(right + 2900);
    expect(unpack(latest.get('oled'))).toEqual(moved(drawn, 35, 0));
    runTo(right + 3100);
    expect(when('left')).toBeGreaterThan(right + 2900);
    // The left scroll brings it back.
    runTo(when('left') + 2900);
    expect(unpack(latest.get('oled'))).toEqual(drawn);
    // The diagonal: right and up one row a step; 1 s in, 17 steps.
    runTo(when('left') + 3100);
    const diag = when('diag');
    expect(diag).toBeGreaterThan(0);
    runTo(diag + 1000);
    expect(unpack(latest.get('oled'))).toEqual(moved(drawn, 17, 17));
    // stopscroll: the vertical offset goes, the columns stay moved.
    runTo(diag + 2500);
    expect(unpack(latest.get('oled'))).toEqual(moved(drawn, 35, 0));
    // The redraw puts it back (looked at as "again" comes, before the next right scroll's first step).
    while (Number.isNaN(when('again', diag)) && bench.now() < (diag + 4000) * NS_PER_MS) runTo(bench.now() / NS_PER_MS + 1);
    expect(when('again', diag)).toBeGreaterThan(diag + 3000);
    expect(unpack(latest.get('oled'))).toEqual(drawn);
    expect(bench.problems().filter((p) => p.severity !== 'info')).toEqual([]);
  }, 60_000);
});
