import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { moduleError, sketchFqbn, validateInlineSketch } from '../../../scripts/compile.ts';
import { isAllowedFqbn, isAllowedHost, isAllowedOrigin, validateSketchPath } from './safety.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BLINK = join(ROOT, 'fixtures', 'sketches', 'uno', 'blink');
const scratch = mkdtempSync(join(tmpdir(), 'benchtop-safety-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('sketch path validation', () => {
  it('accepts a fixture sketch folder', () => {
    expect(validateSketchPath(BLINK)).toEqual({ ok: true, dir: BLINK, name: 'blink' });
  });

  it('refuses relative paths', () => {
    expect(validateSketchPath('fixtures/sketches/uno/blink')).toMatchObject({ ok: false, error: expect.stringMatching(/absolute/) });
    expect(validateSketchPath('./blink')).toMatchObject({ ok: false });
  });

  it('refuses any .. segment, even one that resolves inside a valid sketch', () => {
    expect(validateSketchPath(`${BLINK}/../blink`)).toMatchObject({ ok: false, error: expect.stringMatching(/\.\./) });
  });

  it('refuses a folder without <name>/<name>.ino', () => {
    expect(validateSketchPath(join(ROOT, 'fixtures', 'sketches', 'uno'))).toMatchObject({ ok: false, error: expect.stringMatching(/uno\.ino/) });
    const wrong = join(scratch, 'sketch');
    mkdirSync(wrong);
    writeFileSync(join(wrong, 'other.ino'), 'void setup(){}\nvoid loop(){}\n');
    expect(validateSketchPath(wrong)).toMatchObject({ ok: false });
  });

  it('refuses files, missing folders and non-strings', () => {
    expect(validateSketchPath(join(BLINK, 'blink.ino'))).toMatchObject({ ok: false, error: expect.stringMatching(/folder/) });
    expect(validateSketchPath(join(scratch, 'missing'))).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(validateSketchPath(42)).toMatchObject({ ok: false });
    expect(validateSketchPath('')).toMatchObject({ ok: false });
    expect(validateSketchPath(`/${'a'.repeat(5000)}`)).toMatchObject({ ok: false });
  });

  it('refuses paths under node_modules and system folders', () => {
    const nm = join(scratch, 'node_modules', 'pkg');
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, 'pkg.ino'), '');
    expect(validateSketchPath(nm)).toMatchObject({ ok: false, error: expect.stringMatching(/node_modules/) });
    expect(validateSketchPath('/usr/lib')).toMatchObject({ ok: false, error: expect.stringMatching(/system/) });
    expect(validateSketchPath('/System/Library')).toMatchObject({ ok: false, error: expect.stringMatching(/system/) });
    expect(validateSketchPath('/bin')).toMatchObject({ ok: false, error: expect.stringMatching(/system/) });
  });

  it('checks where a symlink points, not just its name', () => {
    const link = join(scratch, 'innocent');
    symlinkSync(join(scratch, 'node_modules', 'pkg'), link);
    expect(validateSketchPath(link)).toMatchObject({ ok: false, error: expect.stringMatching(/node_modules/) });
  });
});

describe('request guards', () => {
  it('allows only loopback Host headers naming the bridge port (DNS-rebinding guard)', () => {
    expect(isAllowedHost('127.0.0.1:5175', 5175)).toBe(true);
    expect(isAllowedHost('localhost:5175', 5175)).toBe(true);
    expect(isAllowedHost('evil.example:5175', 5175)).toBe(false);
    expect(isAllowedHost('127.0.0.1:80', 5175)).toBe(false);
    expect(isAllowedHost('127.0.0.1', 5175)).toBe(false);
    expect(isAllowedHost(undefined, 5175)).toBe(false);
  });

  it('allows only the bridge page and the Vite dev server as origins', () => {
    expect(isAllowedOrigin('http://127.0.0.1:5175', 5175)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5175', 5175)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', 5175)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', 5175)).toBe(true);
    expect(isAllowedOrigin('https://evil.example', 5175)).toBe(false);
    expect(isAllowedOrigin('http://localhost:5174', 5175)).toBe(false);
    expect(isAllowedOrigin('null', 5175)).toBe(false);
    expect(isAllowedOrigin(undefined, 5175)).toBe(false);
  });

  it('allows only the Uno, Nano, Mega, ESP32, Pico and Pico 2 (RISC-V) FQBNs', () => {
    expect(isAllowedFqbn('arduino:avr:uno')).toBe(true);
    expect(isAllowedFqbn('arduino:avr:nano')).toBe(true);
    expect(isAllowedFqbn('esp32:esp32:esp32')).toBe(true);
    expect(isAllowedFqbn('rp2040:rp2040:rpipico')).toBe(true); // BT61
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2:arch=riscv')).toBe(true); // BT66
    expect(isAllowedFqbn('rp2040:rp2040:rpipicow')).toBe(true); // BT110
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2w:arch=riscv')).toBe(true); // BT113
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2')).toBe(false); // Arm cores: not simulated
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2:arch=arm')).toBe(false);
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2:arch=riscv,opt=x')).toBe(false);
    expect(isAllowedFqbn('arduino:avr:mega')).toBe(true);
    expect(isAllowedFqbn('arduino:avr:leonardo')).toBe(false);
    expect(isAllowedFqbn('arduino:avr:uno --build-property x=y')).toBe(false);
    expect(isAllowedFqbn(undefined)).toBe(false);
    // BT132: the S3's PSRAM option comes from the sketch's own `benchtop: psram` line, never as an FQBN.
    expect(isAllowedFqbn('esp32:esp32:esp32s3:PSRAM=opi')).toBe(false);
  });

  it('BT132: an ESP32-S3 sketch with a `// benchtop: psram` line builds with OPI PSRAM; nothing else changes the FQBN', () => {
    expect(sketchFqbn('esp32:esp32:esp32s3', '// psram-frame\n// benchtop: psram\n#include <SPI.h>\n')).toBe('esp32:esp32:esp32s3:PSRAM=opi');
    expect(sketchFqbn('esp32:esp32:esp32s3', '  //benchtop:  PSRAM\n')).toBe('esp32:esp32:esp32s3:PSRAM=opi');
    expect(sketchFqbn('esp32:esp32:esp32s3', 'void setup() {}\n')).toBe('esp32:esp32:esp32s3');
    expect(sketchFqbn('esp32:esp32:esp32s3', 'int x; // benchtop: psram\n')).toBe('esp32:esp32:esp32s3'); // a line of its own
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: psramfoo --build-property x=y\n')).toBe('esp32:esp32:esp32s3');
    // BT135: the ESP32's PSRAM, the S3's USB-OTG, both on one line or two; other boards none.
    expect(sketchFqbn('esp32:esp32:esp32', '// benchtop: psram\n')).toBe('esp32:esp32:esp32:PSRAM=enabled');
    expect(sketchFqbn('esp32:esp32:esp32', '// benchtop: usb-otg\n')).toBe('esp32:esp32:esp32');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: usb-otg\n')).toBe('esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: usb-otg, psram\n')).toBe('esp32:esp32:esp32s3:PSRAM=opi,USBMode=default,CDCOnBoot=cdc');
    // BT150: the S2's own USB is the OTG controller: CDC On Boot alone. BT154: its PSRAM (an N4R2's) is the menu's "Enabled".
    expect(sketchFqbn('esp32:esp32:esp32s2', '// benchtop: usb-otg\n')).toBe('esp32:esp32:esp32s2:CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s2', '// benchtop: psram\n')).toBe('esp32:esp32:esp32s2:PSRAM=enabled');
    expect(sketchFqbn('esp32:esp32:esp32s2', '// benchtop: psram usb-otg\n')).toBe('esp32:esp32:esp32s2:PSRAM=enabled,CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: usb-otg\n// benchtop: psram\n')).toBe('esp32:esp32:esp32s3:PSRAM=opi,USBMode=default,CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: usb-otg=1 PSRAM=opi;x\n')).toBe('esp32:esp32:esp32s3');
    expect(sketchFqbn('esp32:esp32:esp32c3', '// benchtop: psram\n')).toBe('esp32:esp32:esp32c3');
    expect(sketchFqbn('arduino:avr:uno', '// benchtop: psram\n')).toBe('arduino:avr:uno');
  });

  it('BT137: a board module picks the PSRAM option; a comment\u2019s psram then adds nothing; other words stay', () => {
    expect(sketchFqbn('esp32:esp32:esp32', 'void setup() {}\n', 'WROVER-E')).toBe('esp32:esp32:esp32:PSRAM=enabled');
    expect(sketchFqbn('esp32:esp32:esp32', '// benchtop: psram\n', 'WROOM-32')).toBe('esp32:esp32:esp32');
    expect(sketchFqbn('esp32:esp32:esp32', '// benchtop: psram\n', 'auto')).toBe('esp32:esp32:esp32:PSRAM=enabled');
    // BT143: the module's flash size too (the N8s 8 MB, the N16R8 16 MB).
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: psram\n', 'N8R2')).toBe('esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=8M');
    expect(sketchFqbn('esp32:esp32:esp32s3', '', 'N8R8')).toBe('esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: psram usb-otg\n', 'N8')).toBe('esp32:esp32:esp32s3:FlashSize=8M,USBMode=default,CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: usb-otg\n', 'N8R8')).toBe('esp32:esp32:esp32s3:PSRAM=opi,FlashSize=8M,USBMode=default,CDCOnBoot=cdc');
    expect(sketchFqbn('esp32:esp32:esp32s3', '', 'N16R8')).toBe('esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M');
    expect(sketchFqbn('esp32:esp32:esp32', '', 'WROOM-32E-N16')).toBe('esp32:esp32:esp32:FlashSize=16M');
    expect(sketchFqbn('esp32:esp32:esp32', '// benchtop: psram\n', 'WROVER-E-N16R8')).toBe('esp32:esp32:esp32:PSRAM=enabled,FlashSize=16M');
    expect(sketchFqbn('esp32:esp32:esp32s3', '// benchtop: psram\n')).toBe('esp32:esp32:esp32s3:PSRAM=opi');
    expect(sketchFqbn('arduino:avr:uno', '// benchtop: psram\n', 'WROVER-E')).toBe('arduino:avr:uno');
    // BT154: the S2's N4 builds without PSRAM whatever the comment says; its N4R2 with it.
    expect(sketchFqbn('esp32:esp32:esp32s2', '// benchtop: psram\n', 'N4')).toBe('esp32:esp32:esp32s2');
    expect(sketchFqbn('esp32:esp32:esp32s2', '// benchtop: usb-otg\n', 'N4R2')).toBe('esp32:esp32:esp32s2:PSRAM=enabled,CDCOnBoot=cdc');
  });

  it('BT137: a module must be absent, auto, or one its FQBN knows', () => {
    expect(moduleError('esp32:esp32:esp32', undefined)).toBeNull();
    expect(moduleError('esp32:esp32:esp32', 'auto')).toBeNull();
    expect(moduleError('esp32:esp32:esp32', 'WROVER-E')).toBeNull();
    expect(moduleError('esp32:esp32:esp32s3', 'N8R2')).toBeNull();
    const esp32 = 'module must be auto or one of WROOM-32, WROVER-E, WROOM-32E-N8, WROOM-32E-N16, WROVER-E-N16R8';
    const s3 = 'module must be auto or one of N8, N8R2, N8R8, N16R8';
    expect(moduleError('esp32:esp32:esp32', 'N8R8')).toBe(esp32);
    expect(moduleError('esp32:esp32:esp32s3', 'toString')).toBe(s3);
    expect(moduleError('esp32:esp32:esp32s3', 7)).toBe(s3);
    expect(moduleError('arduino:avr:uno', 'WROVER-E')).toBe('module: arduino:avr:uno has no modules to choose (auto only)');
    const sketch = { fqbn: 'esp32:esp32:esp32', files: { 'a.ino': '' }, main: 'a.ino' };
    expect(validateInlineSketch({ ...sketch, module: 'N8' })).toEqual({ ok: false, error: esp32 });
    expect(validateInlineSketch({ ...sketch, module: 'WROVER-E' })).toEqual({ ok: true, ...sketch, module: 'WROVER-E' });
    expect(validateInlineSketch({ ...sketch, module: 'auto' })).toEqual({ ok: true, ...sketch });
  });
});
