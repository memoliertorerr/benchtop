import { describe, expect, it } from 'vitest';
import { fqbnOf, micropythonFqbnOf } from './fqbn.ts';

describe('fqbnOf (BT45: per board, not per MCU)', () => {
  it('gives each board its own FQBN, and none to parts that are not boards', () => {
    expect(fqbnOf('arduino-uno')).toBe('arduino:avr:uno');
    expect(fqbnOf('arduino-nano')).toBe('arduino:avr:nano');
    expect(fqbnOf('arduino-mega')).toBe('arduino:avr:mega');
    expect(fqbnOf('esp32-devkit-v1')).toBe('esp32:esp32:esp32');
    expect(fqbnOf('raspberry-pi-pico')).toBe('rp2040:rp2040:rpipico');
    expect(fqbnOf('raspberry-pi-pico-2')).toBe('rp2040:rp2040:rpipico2:arch=riscv'); // BT66: its RISC-V cores
    expect(fqbnOf('led')).toBeUndefined();
    expect(fqbnOf('no-such-part')).toBeUndefined();
  });
});

describe('micropythonFqbnOf (BT63)', () => {
  it('names MicroPython for the Pico and the Pico 2, and nothing for boards it does not run on', () => {
    expect(micropythonFqbnOf('raspberry-pi-pico')).toBe('micropython:rp2:pico');
    expect(micropythonFqbnOf('raspberry-pi-pico-2')).toBe('micropython:rp2:pico2'); // BT67
    expect(micropythonFqbnOf('arduino-uno')).toBeUndefined();
    expect(micropythonFqbnOf('led')).toBeUndefined();
  });
});

