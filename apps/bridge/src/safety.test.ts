import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
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
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2')).toBe(false); // Arm cores: not simulated
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2:arch=arm')).toBe(false);
    expect(isAllowedFqbn('rp2040:rp2040:rpipico2:arch=riscv,opt=x')).toBe(false);
    expect(isAllowedFqbn('arduino:avr:mega')).toBe(true);
    expect(isAllowedFqbn('arduino:avr:leonardo')).toBe(false);
    expect(isAllowedFqbn('arduino:avr:uno --build-property x=y')).toBe(false);
    expect(isAllowedFqbn(undefined)).toBe(false);
  });
});
