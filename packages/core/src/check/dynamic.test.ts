import { describe, expect, it } from 'vitest';
import type { BoardSpec } from '../contracts/part.ts';
import { type NetState, Strength } from '../contracts/signal.ts';
import type { Netlist } from '../netlist/netlist.ts';
import { FakeMcuPin } from '../testing.ts';
import { DynamicChecks, MAX_PIN_AMPS } from './dynamic.ts';

// BT47: pin-overcurrent, on one board pin whose net volts the test sets. Each run() is one 10 ms
// check; (drive − net volts) / 25 Ω is the pin's current.

function setup(options: { solved?: boolean; mcu?: BoardSpec['mcu']; vcc?: number } = {}) {
  const pin = new FakeMcuPin('PB5');
  let volts = 0;
  let conflict = false;
  const state = (): NetState => ({ level: volts > 2.5 ? 1 : 0, strength: Strength.strong, conflict, volts });
  const netlist = { pinsOfNet: () => [] } as unknown as Netlist;
  const checks = new DynamicChecks(
    [{ board: 'b', header: '13', mcu: options.mcu ?? 'atmega328p', pin, net: 0, vcc: options.vcc ?? 5, changes: 0 }],
    [],
    netlist,
    state,
    () => options.solved ?? true,
  );
  const codes = () => checks.run().map((p) => p.code);
  return {
    pin,
    checks,
    codes,
    net(v: number, c = false) {
      volts = v;
      conflict = c;
    },
  };
}

describe('pin-overcurrent (BT47)', () => {
  it('reports a pin past 40 mA with its current, holds it for 1 s of checks, then clears', () => {
    const t = setup();
    t.pin.set('output', 1);
    t.net(2); // (5 − 2) / 25 Ω = 120 mA
    expect(t.checks.run()).toEqual([
      { severity: 'error', code: 'pin-overcurrent', message: 'b:13 carries about 120 mA; ATmega328P pins take at most 40 mA.', parts: ['b'] },
    ]);
    t.pin.set('output', 0);
    t.net(0);
    for (let i = 0; i < 99; i++) expect(t.codes(), `check ${i}`).toEqual(['pin-overcurrent']);
    expect(t.codes()).toEqual([]);
  });

  it('sinks count too, and the limit is strict: 40 mA is fine, 42 mA is not', () => {
    const t = setup();
    t.pin.set('output', 0);
    t.net(1); // sinking 40 mA
    expect(t.codes()).toEqual([]);
    t.net(1.05); // 42 mA
    expect(t.codes()).toEqual(['pin-overcurrent']);
    expect(MAX_PIN_AMPS.atmega2560).toBe(0.04);
  });

  it('ignores nets the analog layer leaves at switch level, inputs, pull-ups and conflicts', () => {
    const switchLevel = setup({ solved: false });
    switchLevel.pin.set('output', 1);
    switchLevel.net(0);
    expect(switchLevel.codes()).toEqual([]);
    const t = setup();
    t.net(0);
    for (const mode of ['input', 'input-pullup', 'analog'] as const) {
      t.pin.set(mode, 1);
      expect(t.codes(), mode).toEqual([]);
    }
    t.pin.set('output', 1);
    t.net(0, true); // a short: the 'short' problem's business
    expect(t.codes()).toEqual([]);
  });

  it('drives a DAC pin at its volts (ESP32 at 3.3 V logic)', () => {
    const t = setup({ mcu: 'esp32', vcc: 3.3 });
    t.pin.setVolts(2);
    t.net(0); // 80 mA from the DAC into a dead short to ground through nothing but the driver
    expect(t.checks.run()[0]?.message).toBe('b:13 carries about 80 mA; ESP32 pins take at most 40 mA.');
    t.checks.reset();
    t.pin.setVolts(undefined);
    expect(t.codes()).toEqual([]); // reset drops the hold
  });
});

// AVR per-port current: board pins on nets of their own (net i holds volts[i]); a pin driving 1
// into a net at v sources (Vcc − v) / 25 Ω, driving 0 into it sinks v / 25 Ω.

function groupSetup(pins: readonly (readonly [header: string, id: string, net?: number])[], mcu: BoardSpec['mcu'] = 'atmega328p') {
  const vcc = mcu === 'esp32' ? 3.3 : 5;
  const mcuPins = new Map<string, FakeMcuPin>();
  const volts: number[] = [];
  const boardPins = pins.map(([header, id, net], i) => {
    let pin = mcuPins.get(id);
    if (pin === undefined) mcuPins.set(id, (pin = new FakeMcuPin(id)));
    volts.push(0);
    return { board: 'b', header, mcu, pin, net: net ?? i, vcc, changes: 0 };
  });
  const state = (net: number): NetState => ({ level: volts[net] > vcc / 2 ? 1 : 0, strength: Strength.strong, conflict: false, volts: volts[net] });
  const netlist = { pinsOfNet: () => [] } as unknown as Netlist;
  const checks = new DynamicChecks(boardPins, [], netlist, state, () => true);
  return {
    checks,
    codes: () => checks.run().map((p) => p.code),
    /** Drives `id` at `level` into a net that makes it carry `mA` (sourcing for 1, sinking for 0). */
    drive(id: string, level: 0 | 1, mA: number) {
      mcuPins.get(id)!.set('output', level);
      for (const p of boardPins) if (p.pin.id === id) volts[p.net] = level === 1 ? vcc - (mA / 1000) * 25 : (mA / 1000) * 25;
    },
  };
}

/** The Uno's headers: D0–D7 on PD0–PD7, D8–D13 on PB0–PB5, A0–A5 on PC0–PC5. */
const UNO = [
  ...Array.from({ length: 8 }, (_, d) => [String(d), `PD${d}`] as const),
  ...Array.from({ length: 6 }, (_, d) => [String(d + 8), `PB${d}`] as const),
  ...Array.from({ length: 6 }, (_, a) => [`A${a}`, `PC${a}`] as const),
];

describe('port-overcurrent', () => {
  it('sums sourced current per group: ten pins at 12.5 mA in the 150 mA C0–C5, D0–D4 group pass, at 16 mA they warn', () => {
    const t = groupSetup(UNO);
    const ten = ['PD0', 'PD1', 'PD2', 'PD3', 'PD4', 'PC0', 'PC1', 'PC2', 'PC3', 'PC4'];
    for (const id of ten) t.drive(id, 1, 12.5);
    expect(t.codes()).toEqual([]);
    for (const id of ten) t.drive(id, 1, 16);
    expect(t.checks.run()).toEqual([
      {
        severity: 'warning',
        code: 'port-overcurrent',
        message: "b pins 0, 1, 2, 3, 4, A0, A1, A2, A3, A4 source about 160 mA together; the ATmega328P's pin group C0–C5, D0–D4 may source at most 150 mA.",
        parts: ['b'],
      },
    ]);
  });

  it('sinking has its own groups and limits: nine pins at 12 mA into B0–B5, D5–D7 are past its 100 mA', () => {
    const t = groupSetup(UNO);
    for (const id of ['PD5', 'PD6', 'PD7', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5']) t.drive(id, 0, 12);
    expect(t.checks.run()[0]?.message).toBe("b pins 5, 6, 7, 8, 9, 10, 11, 12, 13 sink about 108 mA together; the ATmega328P's pin group B0–B5, D5–D7 may sink at most 100 mA.");
    // The same nine sourcing is fine: that group's sourcing limit is 150 mA.
    for (const id of ['PD5', 'PD6', 'PD7', 'PB0', 'PB1', 'PB2', 'PB3', 'PB4', 'PB5']) t.drive(id, 1, 12);
    t.checks.reset();
    expect(t.codes()).toEqual([]);
  });

  it('never adds sourced and sunk current together, and names only the pins carrying it', () => {
    const t = groupSetup(UNO);
    // C0–C2 source 30 mA each, C3–C5 sink 30 mA each: 90 mA either way, under both limits
    // (an absolute sum, 180 mA, would be over both).
    for (const id of ['PC0', 'PC1', 'PC2']) t.drive(id, 1, 30);
    for (const id of ['PC3', 'PC4', 'PC5']) t.drive(id, 0, 30);
    expect(t.codes()).toEqual([]);
    t.drive('PC2', 0, 30); // now 120 mA sunk; A2's 30 mA counts, A0/A1 source and aren't named
    expect(t.checks.run().map((p) => p.message)).toEqual([
      "b pins A2, A3, A4, A5 sink about 120 mA together; the ATmega328P's pin group C0–C5 may sink at most 100 mA.",
    ]);
  });

  it('holds a report for 1 s of checks after the last one over the limit, like a pin, and reset drops it', () => {
    const t = groupSetup(UNO);
    for (const id of ['PD0', 'PD1', 'PD2', 'PD3', 'PD4']) t.drive(id, 0, 25); // 125 mA into D0–D4
    expect(t.codes()).toEqual(['port-overcurrent']);
    for (const id of ['PD0', 'PD1', 'PD2', 'PD3', 'PD4']) t.drive(id, 0, 0);
    for (let i = 0; i < 99; i++) expect(t.codes(), `check ${i}`).toEqual(['port-overcurrent']);
    expect(t.codes()).toEqual([]);
    for (const id of ['PD0', 'PD1', 'PD2', 'PD3', 'PD4']) t.drive(id, 0, 25);
    expect(t.codes()).toEqual(['port-overcurrent']);
    t.checks.reset();
    for (const id of ['PD0', 'PD1', 'PD2', 'PD3', 'PD4']) t.drive(id, 0, 0);
    expect(t.codes()).toEqual([]);
  });

  it('counts an MCU pin once per net, however many headers it has there', () => {
    // A4 and SDA are one pin on one net (the board joins them): 4 × 30 mA = 120 mA is over the
    // 100 mA sink limit only if SDA counted A4's current a second time.
    const t = groupSetup([['A0', 'PC0'], ['A1', 'PC1'], ['A2', 'PC2'], ['A4', 'PC4', 3], ['SDA', 'PC4', 3]]);
    for (const id of ['PC0', 'PC1', 'PC2', 'PC4']) t.drive(id, 0, 24); // 96 mA
    expect(t.codes()).toEqual([]);
  });

  it('uses the ATmega2560 groups (F0–F7, K0–K7: 100 mA) and has none for the ESP32', () => {
    const mega = groupSetup(Array.from({ length: 16 }, (_, a) => [`A${a}`, a < 8 ? `PF${a}` : `PK${a - 8}`] as const), 'atmega2560');
    for (let a = 0; a < 16; a++) mega.drive(a < 8 ? `PF${a}` : `PK${a - 8}`, 1, 7); // 112 mA
    expect(mega.checks.run()[0]?.message).toContain("source about 112 mA together; the ATmega2560's pin group F0–F7, K0–K7 may source at most 100 mA.");
    const esp32 = groupSetup(Array.from({ length: 10 }, (_, i) => [`D${i}`, `GPIO${i}`] as const), 'esp32');
    for (let i = 0; i < 10; i++) esp32.drive(`GPIO${i}`, 1, 30); // 300 mA, 30 mA a pin
    expect(esp32.codes()).toEqual([]);
  });
});
