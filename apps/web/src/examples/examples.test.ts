import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProject } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../packages/core/src/firmware/fixtures.test-helper.ts';
import { type Manifest, SKETCH_SOURCE, sketchSourceSha256 } from '../../../../scripts/fixture-boards.ts';
import { CATEGORIES, EXAMPLES, loadFirmware, loadProject, loadSketch } from './manifest.ts';

// BT38/BT43: every gallery example is a committed project that parses, whose boards are boards
// in it; its loaders return exactly the committed files; its sketch is the fixture sketch folder,
// byte for byte; and the fixtures manifest says its firmware was built from that sketch as it is
// now. (examples-run-*.test.ts run each one.)

const realFetch = globalThis.fetch;
beforeAll(() => {
  // ESP32 examples fetch their .bin by the URL the bundler gives; here that's a file path.
  globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = decodeURIComponent(String(input)).replace(/^\/@fs/, '').replace(/\?.*$/, '');
    const path = existsSync(url) ? url : join(REPO_ROOT, url);
    return existsSync(path) ? new Response(readFileSync(path)) : new Response(null, { status: 404 });
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'firmware', 'manifest.json'), 'utf8')) as Manifest;

describe('examples gallery (BT38, BT43, BT45, BT47, BT56)', () => {
  it('has unique ids, the planned categories and examples', () => {
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect([...CATEGORIES]).toEqual(['Basics', 'Displays', 'Sensors', 'Motors', 'Sound', 'Environment', 'ESP32', 'Mega', 'Two boards']);
    for (const e of EXAMPLES) expect(CATEGORIES).toContain(e.category);
    const planned = [
      'blink', 'button', 'fade', 'serial-echo', 'potentiometer', 'lcd1602', 'oled', 'servo', 'neopixel', 'dht22', 'hc-sr04', 'esp32-blink', 'esp32-serial-hello',
      // BT43
      'traffic-light', 'simon', 'servo-knob', 'lcd-thermometer', 'distance-meter', 'keypad-lock', 'oled-clock', 'speaker-melody', 'vu-meter',
      'esp32-rainbow-ring', 'esp32-oled-clock', 'esp32-pwm-fader', 'uart-chat',
      // BT45, BT47
      'nano-analog', 'mega-chaser', 'mega-serial-ports', 'mega-analog',
      // BT51–BT53
      'tft', 'esp32-tft', 'ir-remote', 'scale', 'flame-alarm', 'gas-meter', 'a4988-stepper',
      // BT56
      'gas-fan', 'pir-hallway', 'parking-sensor', 'thermostat',
    ];
    for (const id of planned) expect(EXAMPLES.some((e) => e.id === id), id).toBe(true);
    for (const category of CATEGORIES) expect(EXAMPLES.some((e) => e.category === category), category).toBe(true);
  });

  for (const example of EXAMPLES) {
    it(`${example.id}: project, boards, firmware and sketch are the committed files, the firmware built from that sketch`, async () => {
      const file = JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures', 'projects', `${example.project}.json`), 'utf8'));
      const parsed = parseProject(file);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const loaded = await loadProject(example);
      expect((loaded as { default?: unknown }).default ?? loaded).toEqual(file);
      expect(example.description.length).toBeGreaterThan(20);
      for (const [board, files] of Object.entries(example.boards)) {
        const part = parsed.doc.parts.find((p) => p.id === board);
        expect(part !== undefined && CATALOG.get(part.type)?.board !== undefined, `${board} is a board`).toBe(true);
        // Firmware: the committed bytes.
        const firmware = readFileSync(join(REPO_ROOT, 'fixtures', 'firmware', files.firmware));
        expect(Buffer.from(await loadFirmware(files)).equals(firmware)).toBe(true);
        // Sketch: every source file of the folder, byte for byte.
        const dir = join(REPO_ROOT, 'fixtures', 'sketches', files.sketch);
        const onDisk = Object.fromEntries(readdirSync(dir).filter((n) => SKETCH_SOURCE.test(n)).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
        const sketch = await loadSketch(files);
        expect(sketch.files).toEqual(onDisk);
        expect(sketch.main).toBe(`${files.sketch.split('/').pop()}.ino`);
        // The manifest: this firmware was built from the sketch as it is now.
        const output = manifest.outputs.find((o) => o.file === files.firmware);
        expect(output?.source, `${files.firmware} in the manifest with its source`).toBe(sketchSourceSha256(dir));
      }
      // BT50: a committed spec runs it headless in verify (npm run bench -- test fixtures/specs),
      // on the same project and firmware.
      const specPath = join(REPO_ROOT, 'fixtures', 'specs', 'examples', `${example.id}.bench.json`);
      expect(existsSync(specPath), `fixtures/specs/examples/${example.id}.bench.json`).toBe(true);
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { project: string; firmware: Record<string, string>; expect: string[] };
      expect(spec.project).toBe(`../../projects/${example.project}.json`);
      expect(spec.firmware).toEqual(Object.fromEntries(Object.entries(example.boards).map(([board, b]) => [board, `../../firmware/${b.firmware}`])));
      expect(spec.expect.length).toBeGreaterThan(0);
    });
  }

  it('has no spec for an example that no longer exists', () => {
    const ids = new Set(EXAMPLES.map((e) => e.id));
    const specs = readdirSync(join(REPO_ROOT, 'fixtures', 'specs', 'examples')).filter((n) => n.endsWith('.bench.json'));
    expect(specs.map((n) => n.slice(0, -'.bench.json'.length)).filter((id) => !ids.has(id))).toEqual([]);
  });
});
