import { describe, expect, it } from 'vitest';
import { PICO_PINOUT, raspberryPiPico, raspberryPiPico2, raspberryPiPico2W, raspberryPiPicoW } from './raspberry-pi-pico.ts';

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

  it('its rails are its model’s (BT202: 3V3 from the buck-boost, VBUS and VSYS over USB); every ground is one bus', () => {
    expect(pin('3V3').volts).toBeUndefined();
    expect(pin('3V3').role).toBe('power');
    expect(pin('GND.1').volts).toBe(0);
    expect(raspberryPiPico.defaults).toEqual({ usbPowered: true });
    expect(raspberryPiPico.buses?.[0]).toHaveLength(8);
  });
});

describe('Raspberry Pi Pico 2 board part (BT66)', () => {
  it('is the Pico with an RP2350: the same footprint, pins, pin map, power and LED', () => {
    expect(raspberryPiPico2.type).toBe('raspberry-pi-pico-2');
    expect(raspberryPiPico2.title).toBe('Raspberry Pi Pico 2');
    expect(raspberryPiPico2.board?.mcu).toBe('rp2350');
    expect(raspberryPiPico2.size).toEqual(raspberryPiPico.size);
    expect(raspberryPiPico2.pins).toEqual(raspberryPiPico.pins);
    expect(raspberryPiPico2.board?.pinMap).toEqual(raspberryPiPico.board?.pinMap);
    expect(raspberryPiPico2.defaults).toEqual(raspberryPiPico.defaults);
    expect(raspberryPiPico2.buses).toEqual(raspberryPiPico.buses);
  });
});

describe('Raspberry Pi Pico W board part (BT110)', () => {
  it('is the Pico with the CYW43: the same footprint and header, its LED on WL_GPIO0 instead of TP5', () => {
    expect(raspberryPiPicoW.type).toBe('raspberry-pi-pico-w');
    expect(raspberryPiPicoW.board?.mcu).toBe('rp2040');
    expect(raspberryPiPicoW.size).toEqual(raspberryPiPico.size);
    const names = (def: typeof raspberryPiPico): string[] => def.pins.map((p) => p.name);
    expect(names(raspberryPiPicoW).filter((n) => n !== 'WL_GPIO0')).toEqual(names(raspberryPiPico).filter((n) => n !== 'TP5'));
    const map = raspberryPiPicoW.board?.pinMap ?? {};
    expect(map.WL_GPIO0).toBe('WL_GPIO0');
    expect(map.TP5).toBeUndefined();
    expect(Object.values(map)).not.toContain('GPIO25'); // the CYW43's CS: not on the header
    expect(raspberryPiPicoW.buses).toEqual(raspberryPiPico.buses);
  });
});

describe('Raspberry Pi Pico 2 W board part (BT113)', () => {
  it('is the Pico W around an RP2350: the same pins and pin map', () => {
    expect(raspberryPiPico2W.type).toBe('raspberry-pi-pico-2w');
    expect(raspberryPiPico2W.board?.mcu).toBe('rp2350');
    expect(raspberryPiPico2W.pins).toEqual(raspberryPiPicoW.pins);
    expect(raspberryPiPico2W.board?.pinMap).toEqual(raspberryPiPicoW.board?.pinMap);
  });
});
