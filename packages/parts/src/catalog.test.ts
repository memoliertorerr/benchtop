import { describe, expect, it } from 'vitest';
import { CATALOG, benchEnvParts } from './catalog.ts';
import { PART_CATEGORIES } from './categories.ts';

const categories = new Set<string>(PART_CATEGORIES.map((c) => c.id));

describe('part catalog', () => {
  it('lists the BT9, BT16–BT20, BT34, BT41, BT45, BT47, BT51–BT53, BT55, BT61, BT83, BT84 and BT89 parts', () => {
    expect([...CATALOG.keys()].sort()).toEqual(
      [
        'speaker',
        'microphone',
        'arduino-uno',
        'arduino-nano',
        'arduino-mega',
        'esp32-devkit-v1',
        'raspberry-pi-pico',
        'raspberry-pi-pico-2',
        'breadboard',
        'breadboard-half',
        'breadboard-mini',
        'buzzer',
        'led',
        'potentiometer',
        'pushbutton',
        'resistor',
        'rgb-led',
        'slide-switch',
        'lcd1602',
        'lcd2004',
        'lcd1602-i2c',
        'lcd2004-i2c',
        'seven-segment',
        'seven-segment-2',
        'seven-segment-4',
        'led-bar-graph',
        'ssd1306',
        'ili9341',
        'microsd-card',
        'ir-receiver',
        'ir-remote',
        'hx711',
        'flame-sensor',
        'gas-sensor',
        'a4988',
        'slide-potentiometer',
        'analog-joystick',
        'ky-040',
        'membrane-keypad',
        'dip-switch-8',
        'tilt-switch',
        'pir-motion-sensor',
        'photoresistor-sensor',
        'ntc-temperature-sensor',
        'small-sound-sensor',
        'big-sound-sensor',
        'dht22',
        'hc-sr04',
        'ds1307',
        'mpu6050',
        'servo',
        'stepper-28byj48',
        'stepper-bipolar',
        'neopixel-strip',
        'neopixel-ring',
        'neopixel-matrix',
        'relay-ks2e-m-dc5',
        'battery-9v',
        'battery-2aa',
        'battery-4aa',
        'battery-lipo',
        'battery-cr2032',
        'bench-supply',
        'ground',
        'lm7805',
        'ams1117-3v3',
        'mcp1700-3v3',
        'environment',
        'gas-leak',
        'heater',
        'flame',
        'lamp',
        'sound-source',
        'fan',
        'person',
        'object',
      ].sort(),
    );
    expect(benchEnvParts('led')).toBe(CATALOG.get('led'));
    expect(benchEnvParts('nope')).toBeUndefined();
  });

  it.each([...CATALOG.values()].map((d) => [d.type, d] as const))('%s is well-formed', (_type, def) => {
    expect(categories.has(def.category)).toBe(true);
    const names = def.pins.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    // Leads may stick out of the drawing (the buzzer's legs end 2.2 mm below its 20 mm box),
    // but never far: size is the element's own box, which rotation is about.
    for (const pin of def.pins) {
      expect(pin.x).toBeGreaterThanOrEqual(-5);
      expect(pin.x).toBeLessThanOrEqual(def.size.w + 5);
      expect(pin.y).toBeGreaterThanOrEqual(-5);
      expect(pin.y).toBeLessThanOrEqual(def.size.h + 5);
    }
    for (const bus of def.buses ?? []) for (const name of bus) expect(names).toContain(name);
    for (const link of def.links ?? []) {
      expect(names).toContain(link.a);
      expect(names).toContain(link.b);
    }
    for (const header of Object.keys(def.board?.pinMap ?? {})) expect(names).toContain(header);
  });

  it('maps the Uno header to the ATmega328P ports and marks its supply pins', () => {
    const uno = CATALOG.get('arduino-uno')!;
    expect(uno.pins).toHaveLength(31);
    expect(uno.board?.mcu).toBe('atmega328p');
    expect(uno.board?.pinMap).toMatchObject({ '0': 'PD0', '7': 'PD7', '8': 'PB0', '13': 'PB5', A0: 'PC0', A5: 'PC5' });
    expect(Object.keys(uno.board?.pinMap ?? {})).toHaveLength(20);
    const volts = Object.fromEntries(uno.pins.filter((p) => p.volts !== undefined).map((p) => [p.name, p.volts]));
    expect(volts).toEqual({ '5V': 5, '3.3V': 3.3, IOREF: 5, 'GND.1': 0, 'GND.2': 0, 'GND.3': 0 });
    expect(uno.pins.find((p) => p.name === 'VIN')?.volts).toBeUndefined();
  });
});
