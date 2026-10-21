import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, sevenSegmentText, tftPixels } from './run.test-helper.ts';

// BT43: every Uno (and, since BT45/BT47, Nano and Mega) example runs 2 s of simulated time in Node and does what
// its card says — at least one assertion each, on what a user would see (LEDs, text, pixels,
// angles, serial). ESP32 and two-board examples: examples-run-esp32.test.ts.

const press = { kind: 'press' } as const;
const release = { kind: 'release' } as const;
const key = (k: string, down: boolean) => ({ kind: 'key', key: k, down }) as const;

/** How many times an LED went from dark to lit or back. */
function flips(r: ExampleRun, part: string): number {
  let n = 0;
  let last: boolean | undefined;
  for (const { visual } of r.history(part)) {
    const on = ((visual.brightness as number) ?? 0) > 0.3;
    if (last !== undefined && on !== last) n++;
    last = on;
  }
  return n;
}

export const UNO_CHECKS: Record<string, (r: ExampleRun) => void> = {
  blink(r) {
    r.runTo(2000);
    expect(flips(r, 'led1')).toBeGreaterThanOrEqual(3);
  },
  button(r) {
    r.runTo(500);
    expect(r.lit('led1')).toBe(false);
    r.input('btn1', press);
    r.runTo(800);
    expect(r.lit('led1')).toBe(true);
    r.input('btn1', release);
    r.runTo(2000);
    expect(r.lit('led1')).toBe(false);
  },
  fade(r) {
    r.runTo(2000);
    const levels = new Set(r.history('led1').map(({ visual }) => Math.round((visual.brightness as number) * 10)));
    expect(levels.size).toBeGreaterThanOrEqual(5);
  },
  'traffic-light'(r) {
    const phase = (ms: number): string => {
      r.runTo(ms);
      return ['led1', 'led2', 'led3'].map((p) => (r.lit(p) ? 1 : 0)).join('');
    };
    expect([phase(350), phase(850), phase(1350), phase(1850)]).toEqual(['100', '110', '001', '010']);
  },
  simon(r) {
    r.runTo(1000);
    expect(r.serial('uno')).toContain('round 1');
    // The first step played (one LED lit with its tone); press that LED's button.
    const shown = ['led1', 'led2', 'led3', 'led4'].findIndex((led) => r.history(led).some(({ visual }) => (visual.brightness as number) > 0.3));
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(r.history('bz').some(({ visual }) => visual.sounding === true)).toBe(true);
    r.input(`btn${shown + 1}`, press);
    r.runTo(1300);
    r.input(`btn${shown + 1}`, release);
    r.runTo(2000);
    expect(r.serial('uno')).toContain('round 2');
  },
  'serial-echo'(r) {
    r.runTo(100);
    r.bench.sendSerial('uno', new TextEncoder().encode('hello'));
    r.runTo(2000);
    expect(r.serial('uno')).toContain('hello');
  },
  'nano-analog'(r) {
    r.runTo(500);
    const last = () => r.serial('nano').split('\r\n').filter(Boolean).at(-1)?.split(' ').map(Number) ?? [];
    const [a6, a7] = last();
    expect(Math.abs(a6 - 256) <= 2 && Math.abs(a7 - 768) <= 2, `${a6} ${a7}`).toBe(true);
    r.input('pot1', { kind: 'value', value: 0.5 });
    r.runTo(2000);
    expect(Math.abs((last()[0] ?? 0) - 512)).toBeLessThanOrEqual(2);
  },
  'mega-chaser'(r) {
    r.runTo(2000);
    // The lit segment over time, as a sequence of changes.
    const order: number[] = [];
    for (const { visual } of r.history('bar')) {
      const lit = ((visual.values ?? []) as number[]).findIndex((v) => v > 0.3);
      if (lit >= 0 && order.at(-1) !== lit) order.push(lit);
    }
    expect(order.slice(0, 13)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 7, 6]);
    expect(r.bench.problems().filter((p) => p.severity === 'error')).toEqual([]);
  },
  'mega-serial-ports'(r) {
    r.runTo(1500);
    const lines = r.serial('mega').split('\r\n');
    for (const line of ['ports', 'S1 1', 'S2 2', 'S3 3']) expect(lines).toContain(line);
  },
  'mega-analog'(r) {
    const last = () => r.serial('mega').trimEnd().split('\n').at(-1)?.split(' ').map(Number) ?? [];
    r.runTo(500);
    const readings = last();
    expect(readings).toHaveLength(16);
    [0.2, 0.4, 0.6, 0.8].forEach((v, k) => expect(Math.abs(readings[[0, 5, 8, 15][k]] - Math.floor(v * 1024)), `pot${k + 1}`).toBeLessThanOrEqual(3));
    r.input('pot4', { kind: 'value', value: 1 });
    r.runTo(2000);
    expect(last()[15]).toBeGreaterThanOrEqual(1020);
  },
  potentiometer(r) {
    r.runTo(2000);
    const readings = r.serial('uno').split('\r\n').filter(Boolean).map(Number);
    expect(readings.some((v) => Math.abs(v - 512) <= 4)).toBe(true);
  },
  'logic-analyzer'(r) {
    const probe = r.bench.addProbe({ part: 'uno', pin: '7' });
    r.runTo(2000);
    expect(r.bench.readProbe(probe, 0, 1 << 20)?.times.length ?? 0).toBeGreaterThan(1000); // 1 kHz on D7
  },
  lcd1602(r) {
    r.runTo(2000);
    expect(r.rows('lcd1', 16)[0]).toBe('Hello, Benchtop!');
  },
  'lcd-i2c'(r) {
    r.runTo(1200);
    expect(r.rows('lcd1', 16)[0]).toBe('Hello, Benchtop!');
  },
  'lcd-thermometer'(r) {
    r.runTo(2000);
    expect(r.rows('lcd', 16).slice(0, 2)).toEqual(['Temp   24.0 C   ', 'Humid  40.0 %   ']);
  },
  oled(r) {
    r.runTo(2000);
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  'oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('uno')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  tft(r) {
    r.runTo(1100);
    expect(r.serial('uno')).toContain('drawn');
    expect(tftPixels(r, 'tft', [[15, 15], [140, 30], [20, 80], [10, 130], [5, 300]])).toEqual([0xf800, 0x07e0, 0x001f, 0xffff, 0]);
  },
  'seven-segment'(r) {
    r.runTo(2000);
    expect(sevenSegmentText(r.visual('disp'))).toBe('1234');
  },
  bargraph(r) {
    r.runTo(2000);
    expect(((r.visual('bar')?.values ?? []) as number[]).map((v) => (v > 0.3 ? 1 : 0)).join('')).toBe('1111110000');
  },
  neopixel(r) {
    r.runTo(2000);
    expect(((r.visual('ring')?.pixels ?? []) as number[]).some((p) => p !== 0)).toBe(true);
  },
  dht22(r) {
    r.runTo(2300); // the sketch's first reading comes at 2.1 s
    expect(r.serial('uno')).toContain('T=23.40 H=45.60');
  },
  'hc-sr04'(r) {
    r.runTo(2000);
    expect(r.serial('uno')).toMatch(/\b100\b/);
  },
  'distance-meter'(r) {
    r.runTo(2000);
    expect(sevenSegmentText(r.visual('disp'))).toBe(' 100');
  },
  ds1307(r) {
    r.runTo(2100);
    expect(r.serial('uno')).toContain('2026-10-20 00:00:00');
  },
  mpu6050(r) {
    r.runTo(2000);
    expect(r.serial('uno')).toContain('WHO=0x68');
  },
  'ir-remote'(r) {
    r.runTo(100);
    r.input('ir1', key('ir:48', true)); // the remote's "1"
    r.runTo(130);
    r.input('ir1', key('ir:48', false));
    r.runTo(400);
    r.input('ir1', key('ir:168', true)); // "play", held through two repeats
    r.runTo(700);
    r.input('ir1', key('ir:168', false));
    r.runTo(2000);
    expect(r.serial('uno')).toBe('ready\r\nkey 1 0x30\r\nkey play 0xA8\r\nrepeat\r\nrepeat\r\n');
  },
  scale(r) {
    r.runTo(700);
    r.input('cell', { kind: 'value', value: 750 });
    r.runTo(2000);
    expect(r.serial('uno').split('\r\n')).toContain('g=750.0');
  },
  'flame-alarm'(r) {
    r.runTo(300);
    expect(r.serial('uno')).toMatch(/^clear a0=10\d\d\r\n$/);
    r.input('flame', { kind: 'value', value: 0.8 });
    r.runTo(600);
    expect(r.serial('uno')).toMatch(/FLAME a0=\d+\r\n$/);
    expect(r.history('bz1').some(({ visual }) => visual.frequency === 2000)).toBe(true);
  },
  'gas-meter'(r) {
    r.runTo(300);
    expect(r.serial('uno').split('\r\n')[0]).toMatch(/^a0=9\d alarm=0$/);
    r.input('gas', { kind: 'value', value: 2000 });
    r.runTo(2000);
    expect(r.serial('uno').split('\r\n').filter(Boolean).at(-1)).toMatch(/ alarm=1$/);
  },
  'a4988-stepper'(r) {
    r.runTo(2000);
    expect(r.serial('uno')).toBe('full\r\nsixteenth\r\n');
    // Sampled every 5 ms, the brief 360° peak may fall between samples (the 1 ms integration test pins it).
    const peak = Math.max(...r.history('motor').map(({ visual }) => visual.angle as number));
    expect(peak).toBeGreaterThanOrEqual(358);
    expect(peak).toBeLessThanOrEqual(360);
    expect(r.visual('motor')?.angle as number).toBeCloseTo(0, 6);
  },
  keypad(r) {
    r.runTo(300);
    r.input('pad', key('5', true));
    r.runTo(400);
    r.input('pad', key('5', false));
    r.runTo(2000);
    expect(r.serial('uno').split('\r\n')).toContain('5');
  },
  encoder(r) {
    r.runTo(300);
    r.input('enc', key('cw', true));
    r.runTo(600);
    r.input('enc', key('cw', true));
    r.runTo(2000);
    expect(r.serial('uno')).toContain('count=2');
  },
  servo(r) {
    r.runTo(2000);
    const angles = new Set(r.history('servo').map(({ visual }) => Math.round(visual.angle as number)));
    expect(angles.size).toBeGreaterThanOrEqual(5);
  },
  'servo-knob'(r) {
    r.runTo(1000);
    expect(Math.abs((r.visual('servo')?.angle as number) - 90)).toBeLessThanOrEqual(3);
    r.input('pot', { kind: 'value', value: 0.25 });
    r.runTo(2000);
    expect(Math.abs((r.visual('servo')?.angle as number) - 45)).toBeLessThanOrEqual(3);
  },
  'keypad-lock'(r) {
    r.runTo(200);
    for (const k of ['1', '2', '3', '4', '#']) {
      r.input('pad', key(k, true));
      r.runTo(Math.floor(r.bench.now() / 1e6) + 60);
      r.input('pad', key(k, false));
      r.runTo(Math.floor(r.bench.now() / 1e6) + 60);
    }
    r.runTo(2000);
    expect(r.serial('uno')).toContain('unlocked');
    expect(Math.abs((r.visual('servo')?.angle as number) - 90)).toBeLessThanOrEqual(3);
  },
  stepper(r) {
    r.runTo(2000);
    expect(Math.abs(r.visual('motor')?.angle as number)).toBeGreaterThan(10);
  },
  relay(r) {
    r.runTo(2000);
    expect(r.history('relay').some(({ visual }) => visual.contactsNO === true)).toBe(true);
    expect(flips(r, 'led1')).toBeGreaterThanOrEqual(2);
  },
  buzzer(r) {
    r.runTo(2000);
    expect(r.history('bz1').some(({ visual }) => visual.frequency === 440)).toBe(true);
  },
  'speaker-melody'(r) {
    r.runTo(2000);
    expect(r.history('spk1').reduce((n, { visual }) => n + ((visual.audio as number[] | undefined)?.length ?? 0), 0)).toBeGreaterThanOrEqual(10 * 1024);
  },
  'pcm-playback'(r) {
    r.runTo(2000);
    expect(r.history('spk1').reduce((n, { visual }) => n + ((visual.audio as number[] | undefined)?.length ?? 0), 0)).toBeGreaterThanOrEqual(30 * 1024);
  },
  'mic-level'(r) {
    r.listen('mic1', 440, 2000);
    const readings = r.serial('uno').split('\r\n').filter(Boolean).map(Number);
    expect(readings.slice(1).every((hz) => Math.abs(hz - 440) <= 10) && readings.length >= 3).toBe(true);
  },
  'vu-meter'(r) {
    r.runTo(500);
    expect(((r.visual('bar')?.values ?? []) as number[]).every((v) => v < 0.3)).toBe(true); // quiet
    r.listen('mic1', 440, 1200);
    expect(((r.visual('bar')?.values ?? []) as number[]).filter((v) => v > 0.3).length).toBeGreaterThanOrEqual(8);
    r.runTo(2000); // silence again
    expect(((r.visual('bar')?.values ?? []) as number[]).every((v) => v < 0.3)).toBe(true);
  },
};

describe('every Uno, Nano and Mega example runs as described (BT43, BT45, BT47)', () => {
  const unoOnly = EXAMPLES.filter((e) => Object.values(e.boards).every((b) => /^(uno|nano|mega)\//.test(b.firmware)));
  it('has a check for each', () => {
    expect(unoOnly.map((e) => e.id).filter((id) => UNO_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of unoOnly) {
    it(example.id, () => {
      const check = UNO_CHECKS[example.id];
      if (check === undefined) throw new Error(`no check for ${example.id}`);
      check(runExample(example));
    });
  }
});
