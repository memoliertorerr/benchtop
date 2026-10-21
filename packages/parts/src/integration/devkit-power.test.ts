import { assembleBench, type BenchEnv, NS_PER_MS, parseProject, type ProjectDoc } from '@benchtop/core';
import { esp32McuFactory } from '@benchtop/esp32';
import { describe, expect, it } from 'vitest';
import { benchEnvParts } from '../catalog.ts';

// BT44: the DevKit V1's VIN carries USB's 5 V while the board is USB-powered (prop usbPowered,
// default true). No firmware (and no ROM) is needed: the power checks are the bench's.

const env = (): BenchEnv => ({ part: benchEnvParts, createMcu: esp32McuFactory(undefined) });

function bench(props: Record<string, boolean>, wires: [string, string][]) {
  const doc: ProjectDoc = {
    format: 1,
    name: 'devkit power',
    parts: [
      { id: 'esp', type: 'esp32-devkit-v1', x: 0, y: 0, rotation: 0, props },
      { id: 'strip', type: 'neopixel-strip', x: 60, y: 0, rotation: 0, props: {} },
    ],
    wires: wires.map(([a, b], i) => {
      const [pa, na] = a.split(':');
      const [pb, nb] = b.split(':');
      return { id: `w${i}`, from: { part: pa, pin: na }, to: { part: pb, pin: nb }, waypoints: [], color: 'green' };
    }),
    firmware: {},
  };
  const parsed = parseProject(doc);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const b = assembleBench(parsed.doc, env(), {});
  b.runUntil(50 * NS_PER_MS);
  return b;
}

const strip: [string, string][] = [
  ['esp:VIN', 'strip:VCC'],
  ['esp:GND.2', 'strip:GND'],
  ['esp:D4', 'strip:DIN'],
];
const codes = (b: ReturnType<typeof bench>) => b.problems().map((p) => p.code).filter((c) => c !== 'esp32-rom-missing' && c !== 'mcu-halted');

describe('ESP32 DevKit V1 power (BT44)', () => {
  it('VIN is a 5 V supply while USB-powered: a NeoPixel strip on VIN is powered', () => {
    const b = bench({}, strip);
    expect(b.pinState('strip', 'VCC')).toMatchObject({ level: 1, volts: 5 });
    expect(codes(b)).not.toContain('unpowered-part');
  });

  it('without USB power VIN is an input: the strip on it is unpowered', () => {
    const b = bench({ usbPowered: false }, strip);
    expect(b.pinState('strip', 'VCC')?.volts).toBe(0);
    expect(codes(b)).toContain('unpowered-part');
  });

  it('VIN wired to a GPIO is 5 V on a 3.3 V pin (the BT39 rule still fires)', () => {
    const b = bench({}, [['esp:VIN', 'esp:D4']]);
    expect(codes(b)).toContain('esp32-overvoltage');
  });
});
