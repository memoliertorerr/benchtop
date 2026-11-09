import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, tftPixels } from './run.test-helper.ts';

// BT43: every ESP32 and two-board example runs 2 s of simulated time in Node (the real ROM, a
// direct boot) and does what its card says. Uno examples: examples-run-uno.test.ts.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;
const audioSamples = (r: ExampleRun, part: string): number => r.history(part).reduce((n, { visual }) => n + ((visual.audio as number[] | undefined)?.length ?? 0), 0);

export const ESP32_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32-blink'(r) {
    r.runTo(2000);
    let flips = 0;
    let last: boolean | undefined;
    for (const { visual } of r.history('led1')) {
      const on = (visual.brightness as number) > 0.3;
      if (last !== undefined && on !== last) flips++;
      last = on;
    }
    expect(flips).toBeGreaterThanOrEqual(2);
  },
  // BT100: WiFi — the board joins the access point at ≈ 1.6 s.
  'esp32-wifi-webserver'(r) {
    r.runTo(1700);
    expect(r.serial('esp')).toContain('server at 192.168.4.2\n');
    expect(r.lit('led1')).toBe(false);
    r.input('on', { kind: 'press' });
    r.runTo(1800);
    expect(r.visual('on')).toMatchObject({ status: '200', body: 'led on', sent: 1 });
    expect(r.lit('led1')).toBe(true);
    r.input('off', { kind: 'press' });
    r.runTo(1900);
    expect(r.visual('off')).toMatchObject({ status: '200', body: 'led off' });
    expect(r.lit('led1')).toBe(false);
    expect(r.serial('esp')).toContain('GET /led on\nGET /led off\n');
  },
  'esp32-softap-webserver'(r) {
    // BT117: the ESP32 is the access point; the client parts take addresses from its DHCP server.
    r.runTo(1500);
    expect(r.serial('esp')).toContain('ap esp32-ap at 192.168.4.1\n');
    expect(r.serial('esp').match(/joined [0-9a-f:]{17}\n/g)).toHaveLength(2);
    expect(r.lit('led1')).toBe(false);
    r.input('on', { kind: 'press' });
    r.runTo(1600);
    expect(r.visual('on')).toMatchObject({ status: '200', body: 'led on', sent: 1 });
    expect(r.lit('led1')).toBe(true);
    r.input('off', { kind: 'press' });
    r.runTo(1700);
    expect(r.visual('off')).toMatchObject({ status: '200', body: 'led off' });
    expect(r.lit('led1')).toBe(false);
    expect(r.serial('esp')).toContain('GET /led on\nGET /led off\n');
  },
  'esp32-wifi-http'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('GET 200 {"hello":"world","count":1}\n');
    expect(r.serial('esp')).toContain('POST 200 ping\n');
    expect(r.visual('api')).toMatchObject({ requests: 2 });
  },
  'esp32-wifi-tcp'(r) {
    r.runTo(2000);
    expect(r.serial('server')).toMatch(/^echo server at 192\.168\.4\.\d+\nclient 192\.168\.4\.\d+\nline hello bench\n/);
    expect(r.serial('client')).toContain('reply HELLO BENCH\n');
    expect(r.visual('ap')).toMatchObject({ stations: 2 });
  },
  // BT105: the gateway answers SNTP with the host's clock ('wall', the AP's default).
  'esp32-ntp-clock'(r) {
    r.runTo(3500);
    const lines = r.serial('esp').split('\r\n').filter((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(Date.parse(`${lines[0].replace(' ', 'T')}Z`) - Date.now())).toBeLessThan(120_000);
    expect(r.visual('ap')).toMatchObject({ stations: 1 });
  },
  'esp32-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('hello from esp32');
  },
  'esp32-button'(r) {
    r.runTo(1000);
    expect(r.lit('led1')).toBe(false);
    r.input('btn1', { kind: 'press' });
    r.runTo(1300);
    expect(r.lit('led1')).toBe(true);
    r.input('btn1', { kind: 'release' });
    r.runTo(2000);
    expect(r.lit('led1')).toBe(false);
  },
  'esp32-prefs-led'(r) {
    // BT120: the LED's state in Preferences: after a reset it comes back as it was left.
    r.runTo(1000);
    expect(r.serial('esp')).toContain('start: led off\n');
    expect(r.lit('led1')).toBe(false);
    r.input('btn1', { kind: 'press' });
    r.runTo(1100);
    r.input('btn1', { kind: 'release' });
    r.runTo(1200);
    expect(r.lit('led1')).toBe(true);
    expect(r.serial('esp')).toContain('led on\n');
    r.bench.resetBoard('esp');
    r.runTo(2500);
    expect(r.serial('esp')).toContain('start: led on\n');
    expect(r.lit('led1')).toBe(true);
  },
  'esp32-deep-sleep'(r) {
    // BT123: asleep between wakes — the timer every 5 s, the button at once; the counts in RTC memory.
    r.runTo(1000);
    expect(r.serial('esp')).toBe('boot 1: power-on, 0 presses\n');
    expect(r.bench.sleepOf('esp')).toEqual({ deep: true, wakeAt: expect.any(Number), pins: ['GPIO4 low'] });
    r.input('btn1', { kind: 'press' });
    r.runTo(1200);
    expect(r.serial('esp')).toContain('boot 2: button, 1 presses\n');
    expect(r.bench.sleepOf('esp')).toBeNull(); // awake: waiting for the release
    r.input('btn1', { kind: 'release' });
    r.runTo(2500); // two flashes, then asleep again: the timer 5 s on
    const wakeAt = (r.bench.sleepOf('esp')?.wakeAt ?? 0) / 1e9;
    expect(wakeAt).toBeGreaterThan(6.5);
    expect(wakeAt).toBeLessThan(7.5);
    r.runTo(7800);
    expect(r.serial('esp')).toContain('boot 3: timer, 1 presses\n');
  },
  'esp32-pwm-fader'(r) {
    r.runTo(1000);
    const middle = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.1 });
    r.runTo(1500);
    const low = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.9 });
    r.runTo(2000);
    const high = brightness(r, 'led1');
    expect(low).toBeLessThan(middle);
    expect(high).toBeGreaterThan(middle);
  },
  'esp32-neopixel'(r) {
    r.runTo(2000);
    expect(r.history('strip').some(({ visual }) => ((visual.pixels as number[])[0] ?? 0) !== 0)).toBe(true);
  },
  'esp32-rainbow-ring'(r) {
    r.runTo(1200);
    const first = [...((r.visual('ring')?.pixels ?? []) as number[])];
    r.runTo(2000);
    const later = (r.visual('ring')?.pixels ?? []) as number[];
    expect(first.filter((p) => p !== 0).length).toBe(16);
    expect(later).not.toEqual(first); // the rainbow turned
  },
  'esp32-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  'esp32-tft'(r) {
    r.runTo(1000);
    expect(r.serial('esp')).toContain('drawn');
    expect(tftPixels(r, 'tft', [[15, 15], [140, 30], [20, 80], [10, 130], [5, 300]])).toEqual([0xf800, 0x07e0, 0x001f, 0xffff, 0]);
  },
  // BT135: a WROVER-E (the board's module prop) keeps a 150 KB frame buffer in PSRAM.
  'esp32-psram-frame'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('frame buffer 153600 in psram 1');
    expect(r.serial('esp')).toContain('frame 2');
    expect(tftPixels(r, 'tft', [[20, 50], [200, 120], [20, 250], [20, 310]])).toEqual([0xf800, 0x07e0, 0x001f, 0]);
  },
  // BT161: touch — the ESP32's readings fall when touched; a touch wakes it from deep sleep.
  'esp32-touch-led'(r) {
    r.runTo(500);
    expect(r.serial('esp')).toContain('touch led ready');
    expect((r.visual('led1')?.brightness as number | undefined) ?? 0).toBeLessThan(0.3);
    r.input('pad', { kind: 'press' });
    r.runTo(800);
    expect(r.serial('esp')).toContain('led on');
    expect(r.visual('led1')?.brightness as number).toBeGreaterThan(0.5);
    r.input('pad', { kind: 'release' });
    r.runTo(1100);
    expect(r.serial('esp')).toContain('led off');
    const readings = [...r.serial('esp').matchAll(/touch (\d+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...readings) - Math.min(...readings)).toBeGreaterThan(20);
  },
  'esp32-touch-wake'(r) {
    r.runTo(1000);
    expect(r.serial('esp')).toContain('boot 1: power-on');
    expect(r.bench.sleepOf('esp')?.pins).toContain('touch T3 (GPIO15)');
    r.input('pad', { kind: 'press' });
    r.runTo(1200);
    r.input('pad', { kind: 'release' });
    r.runTo(2000);
    expect(r.serial('esp')).toContain('boot 2: touch pad 3');
  },
  'esp32-dac-sine'(r) {
    r.runTo(2000);
    expect(audioSamples(r, 'spk1')).toBeGreaterThanOrEqual(20 * 1024);
  },
  'esp32-mic-level'(r) {
    r.listen('mic1', 440, 2000);
    const readings = r.serial('esp').split('\r\n').filter(Boolean).map(Number);
    expect(readings.length).toBeGreaterThanOrEqual(3);
    for (const hz of readings.slice(1)) expect(Math.abs(hz - 440)).toBeLessThanOrEqual(10);
  },
  'esp32-i2c-scan'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('found 0x3C');
    expect(r.serial('esp')).toContain('found 0x68');
  },
  'uart-chat'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('ping 1 -> pong 1');
    expect(r.serial('uno')).toContain('got pong 1');
  },
  'uart-relay'(r) {
    r.runTo(2000);
    expect(r.serial('esp')).toContain('ping');
  },
};

describe('every ESP32 and two-board example runs as described (BT43)', () => {
  const withEsp32 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32/')));
  it('has a check for each', () => {
    expect(withEsp32.map((e) => e.id).filter((id) => ESP32_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withEsp32) {
    it(
      example.id,
      () => {
        const check = ESP32_CHECKS[example.id];
        if (check === undefined) throw new Error(`no check for ${example.id}`);
        check(runExample(example));
      },
      60_000,
    );
  }
});
