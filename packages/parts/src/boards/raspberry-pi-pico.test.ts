import { describe, expect, it } from 'vitest';
import { PICO_PINOUT, raspberryPiPico } from './raspberry-pi-pico.ts';

// BT61: the Pico's pin table against its datasheet (pinout and mechanical drawing).

const pin = (name: string) => {
  const p = raspberryPiPico.pins.find((q) => q.name === name);
  if (p === undefined) throw new Error(`no pin ${name}`);
  return p;
};

describe('Raspberry Pi Pico board part', () => {
  it('has 40 header pins on a 2.54 mm grid, two rows 17.78 mm apart, on a 21 × 51 mm board', () => {
    expect(PICO_PINOUT).toHaveLength(40);
    expect(raspberryPiPico.size).toEqual({ w: 21, h: 51 });
    const header = raspberryPiPico.pins.filter((p) => p.name !== 'TP5');
    expect(new Set(header.map((p) => p.x))).toEqual(new Set([1.61, 19.39]));
    expect(pin('VBUS').x - pin('GP0').x).toBeCloseTo(17.78, 6);
    for (const p of header) {
      const k = (p.y - 1.37) / 2.54;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
  });

  it('numbers the pins as the board does: 1–20 down the left, 21–40 up the right', () => {
    expect([pin('GP0').y, pin('GP15').y]).toEqual([1.37, 49.63]); // pins 1 and 20
    expect([pin('GP16').x, pin('GP16').y]).toEqual([19.39, 49.63]); // pin 21, bottom right
    expect([pin('VBUS').x, pin('VBUS').y]).toEqual([19.39, 1.37]); // pin 40, top right
    expect(PICO_PINOUT.slice(29, 36)).toEqual(['RUN', 'GP26', 'GP27', 'AGND', 'GP28', 'ADC_VREF', '3V3']);
  });

  it('maps GP0–GP22, GP26–GP28 and the LED test pad to the RP2040\'s GPIOs', () => {
    const map = raspberryPiPico.board?.pinMap ?? {};
    expect(raspberryPiPico.board?.mcu).toBe('rp2040');
    expect(Object.keys(map)).toHaveLength(27);
    expect([map.GP0, map.GP22, map.GP26, map.GP28, map.TP5]).toEqual(['GPIO0', 'GPIO22', 'GPIO26', 'GPIO28', 'GPIO25']);
  });

  it('keeps TP5 off the header grid, so no breadboard hole lies under it', () => {
    const tp5 = pin('TP5');
    expect(Math.abs((((tp5.x - 1.61) / 2.54) % 1) - 0.5)).toBeLessThan(0.45);
    expect(Math.abs((((tp5.y - 1.37) / 2.54) % 1) - 0.5)).toBeLessThan(0.45);
  });

  it('powers 3V3 and, over USB, VBUS and VSYS; every ground is one bus', () => {
    expect(pin('3V3').volts).toBe(3.3);
    expect(raspberryPiPico.defaults).toEqual({ usbPowered: true });
    expect(raspberryPiPico.buses?.[0]).toHaveLength(8);
  });
});
