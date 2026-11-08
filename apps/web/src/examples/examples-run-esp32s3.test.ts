import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './manifest.ts';
import { type ExampleRun, runExample, tftPixels } from './run.test-helper.ts';

// BT126: every ESP32-S3 example runs 2 s of simulated time in Node (the S3's real ROM, a direct
// boot) and does what its card says.

const brightness = (r: ExampleRun, part: string): number => (r.visual(part)?.brightness as number | undefined) ?? 0;

export const ESP32S3_CHECKS: Record<string, (r: ExampleRun) => void> = {
  'esp32s3-rgb-blink'(r) {
    r.runTo(2000);
    const colors = new Set(r.history('s3').map(({ visual }) => ((visual.pixels as number[] | undefined) ?? [0])[0]));
    for (const color of [0xff0000, 0x00ff00, 0x0000ff, 0x404040]) expect(colors).toContain(color);
  },
  'esp32s3-serial-hello'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('hello from esp32s3');
    expect(r.serial('s3')).toContain('tick 1');
  },
  'esp32s3-pot-led'(r) {
    r.runTo(1000);
    const middle = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.1 });
    r.runTo(1500);
    const low = brightness(r, 'led1');
    r.input('pot', { kind: 'value', value: 0.6 });
    r.runTo(2000);
    const high = brightness(r, 'led1');
    expect(low).toBeLessThan(middle);
    expect(high).toBeGreaterThan(middle);
  },
  'esp32s3-oled-clock'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('2026-01-01 00:00:01');
    expect(((r.visual('oled')?.fb ?? []) as number[]).some((v) => v !== 0)).toBe(true);
  },
  // BT129: the S3's WiFi (its symbols come with the example: run.test-helper reads the .syms.tsv) and sleep.
  'esp32s3-wifi-rgb-server'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('server at 192.168.4.2');
    const pixel = (): number => ((r.visual('s3')?.pixels as number[] | undefined) ?? [-1])[0];
    let t = 2000;
    for (const [client, color] of [['green', 0x00ff00], ['blue', 0x0000ff], ['red', 0xff0000], ['off', 0]] as const) {
      r.input(client, { kind: 'press' });
      r.runTo((t += 100));
      expect(pixel(), client).toBe(color);
      expect(r.serial('s3')).toContain(`led ${client}`);
    }
  },
  'esp32s3-deep-sleep'(r) {
    r.runTo(1000);
    expect(r.serial('s3')).toContain('boot 1: power-on, 0 presses');
    r.input('btn1', { kind: 'press' });
    r.runTo(1100);
    r.input('btn1', { kind: 'release' });
    r.runTo(2000);
    expect(r.serial('s3')).toContain('boot 2: button, 1 presses');
  },
  // BT132: a 150 KB frame buffer in PSRAM, pushed whole to the ILI9341 every frame.
  'esp32s3-psram-frame'(r) {
    r.runTo(2000);
    expect(r.serial('s3')).toContain('frame buffer 153600 in psram 1');
    expect(r.serial('s3')).toContain('frame 3');
    expect(tftPixels(r, 'tft', [[20, 50], [200, 120], [20, 250], [20, 310]])).toEqual([0xf800, 0x07e0, 0x001f, 0]);
  },
  // BT135: Serial over USB-OTG — the bench's USB host opens the port; typed colors set the RGB LED.
  'esp32s3-usb-rgb'(r) {
    const pixel = (): number => ((r.visual('s3')?.pixels as number[] | undefined) ?? [0])[0];
    r.runTo(300);
    expect(r.serial('s3')).toContain('usb serial ready');
    r.send('s3', 'green\n');
    r.runTo(500);
    expect(pixel()).toBe(0x00ff00);
    r.send('s3', 'purple\n');
    r.send('s3', 'blue\n');
    r.runTo(700);
    expect(pixel()).toBe(0x0000ff);
    expect(r.serial('s3')).toContain('led green\nunknown purple\nled blue\n');
  },
  // BT139: the S3's own USB as a keyboard, mouse and media keys, and as a MIDI controller — what the bench's USB host received.
  'esp32s3-usb-keys'(r) {
    r.runTo(400);
    expect(r.serial('s3')).toContain('usb keys ready');
    r.input('type', { kind: 'press' });
    r.runTo(500);
    r.input('type', { kind: 'release' });
    r.input('volume', { kind: 'press' });
    r.runTo(700);
    r.input('volume', { kind: 'release' });
    r.runTo(800);
    const usb = r.bench.usbOf('s3');
    expect(usb?.functions).toEqual(['serial (CDC-ACM)', 'keyboard', 'mouse', 'media keys']);
    expect(usb?.typed).toBe('Hello from Benchtop!\n');
    expect(usb?.events.map((e) => e.text)).toEqual(['media: Volume Up']);
  },
  'esp32s3-usb-midi'(r) {
    r.runTo(400);
    r.input('c4', { kind: 'press' });
    r.runTo(500);
    r.input('c4', { kind: 'release' });
    r.input('volume', { kind: 'value', value: 1 });
    r.runTo(700);
    const lines = r.bench.usbOf('s3')?.events.map((e) => e.text) ?? [];
    expect(lines).toContain('MIDI: note on ch 1 C4 (60) velocity 100');
    expect(lines).toContain('MIDI: note off ch 1 C4 (60)');
    expect(lines.at(-1)).toBe('MIDI: control change ch 1 #7 = 127');
  },
};

describe('every ESP32-S3 example runs as described (BT126)', () => {
  const withS3 = EXAMPLES.filter((e) => Object.values(e.boards).some((b) => 'firmware' in b && b.firmware.startsWith('esp32s3/')));
  it('has a check for each', () => {
    expect(withS3.length).toBe(10);
    expect(withS3.map((e) => e.id).filter((id) => ESP32S3_CHECKS[id] === undefined)).toEqual([]);
  });
  for (const example of withS3) {
    it(
      example.id,
      () => {
        const check = ESP32S3_CHECKS[example.id];
        if (check === undefined) throw new Error(`no check for ${example.id}`);
        check(runExample(example));
      },
      60_000,
    );
  }
});
