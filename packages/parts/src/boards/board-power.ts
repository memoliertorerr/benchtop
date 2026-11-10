/**
 * BT202: how a 3.3 V board (the ESP32 DevKits, the Picos) is powered — its rails driven by its
 * model at supply strength (only GND keeps `PinDef.volts`), and the bench's `power` (core
 * bench/power.ts): on while the MCU's 3V3 rail is at or above its brown-out level.
 *
 * `usbPowered` (default true): USB's 5 V on the board's USB pins (the DevKit V1's VIN, the
 * Espressif DevKits' 5V, the Picos' VBUS and VSYS — nominal 5 V, the diodes' drop left out, as
 * before BT202). The input (that pin's volts, from USB or from outside) feeds the 3.3 V regulator:
 *
 * - an LDO (the DevKit V1's AMS1117-3.3 from VIN, 15 V its maximum; the Espressif DevKits' from
 *   5V, whose input is taken as 6 V at most): VIN − dropout up to 3.3 V, the dropout taken as
 *   1.1 V (the AMS1117's);
 * - the Picos' RT6150 buck-boost: 3.3 V for VSYS from 1.8 to 5.5 V (the Pico data sheet's range),
 *   off while 3V3_EN is held low (the board pulls it up to VSYS).
 *
 * With the regulator off, whatever drives the 3V3 pin from outside is the rail (a LiPo through an
 * external regulator). `power.on`: the rail at or above the brown-out level — ESP-IDF's default
 * on the ESP32 (2.43 V), taken as 2.5 V on the C3, S3 and S2; 1.8 V on the Picos (their IOVDD's
 * range starts at 1.62 V) — with 50 mV of hysteresis. Problems: `board-unpowered` (info) while
 * off; `board-overvoltage` (error) with the input over its maximum or the rail over the chip's
 * 3.6 V (3.63 V on the RP2040/RP2350); `board-undervoltage` (warning) while an ESP32 runs below its
 * module's 3.0 V. A brown-out here is a power cycle: the chip comes back with a power-on reset,
 * not the ESP32's BROWNOUT_RST. The power LED lights from 1.8 V on the rail.
 */

import { type NetState, type PartContext, Strength } from '@benchtop/core';

export interface BoardPowerSpec {
  /** For messages: "ESP32 DevKit V1". */
  readonly board: string;
  readonly ground: string;
  /** Pins USB drives at 5 V while `usbPowered`. */
  readonly usbPins: readonly string[];
  /** The regulator's input pin. */
  readonly input: string;
  /** The 3.3 V rail's pin. */
  readonly rail: string;
  readonly regulator: { readonly kind: 'ldo'; readonly dropout: number; readonly maxIn: number } | { readonly kind: 'buck-boost'; readonly minIn: number; readonly maxIn: number; readonly enable: string };
  readonly brownOut: number;
  /** The rail's absolute maximum, V. */
  readonly maxRail: number;
  /** Below this, running, it's `board-undervoltage` (the ESP32 modules' 3.0 V); none on the Picos. */
  readonly minRail?: number;
  /** For messages: "ESP32", "RP2040". */
  readonly chip: string;
}

export const LDO_DROPOUT = 1.1;
export const BROWN_OUT_HYSTERESIS = 0.05;
export const POWER_LED_VOLTS = 1.8;

const volts = (s: NetState, ground: number): number => (s.strength === Strength.hiz ? 0 : s.volts - ground);

export interface BoardSupply {
  readonly power: { on: boolean };
  readonly led: { on: boolean };
  reset(): void;
}

export function boardPower(ctx: PartContext, usbPowered: boolean, spec: BoardPowerSpec): BoardSupply {
  const gnd = ctx.pin(spec.ground);
  const input = ctx.pin(spec.input);
  const rail = ctx.pin(spec.rail);
  const usbPins = spec.usbPins.map((name) => ctx.pin(name));
  const regulator = spec.regulator;
  const enable = regulator.kind === 'buck-boost' ? ctx.pin(regulator.enable) : null;
  const power = { on: false };
  const led = { on: false };
  let driven = -1;
  let enablePull = -1;
  let over = false;
  let under = false;
  let unpowered = false;
  let fresh = true;
  if (usbPowered) for (const pin of usbPins) pin.driveVolts(5, Strength.supply);

  const report = (code: string, severity: 'error' | 'warning' | 'info', active: boolean, message: string): void => {
    ctx.report({ severity, code, message: active ? message : '', parts: [] });
  };

  const update = (): void => {
    const ground = gnd.read().volts;
    const vin = volts(input.read(), ground);
    let out = 0;
    if (regulator.kind === 'ldo') out = vin > regulator.dropout ? Math.min(3.3, vin - regulator.dropout) : 0;
    else if (enable !== null) {
      // 3V3_EN: the board's pull-up to VSYS; held low, the buck-boost is off.
      const pull = vin > 0 ? vin : -1;
      if (pull !== enablePull) {
        enablePull = pull;
        if (pull > 0) enable.driveVolts(ground + pull, Strength.weak);
        else enable.release();
      }
      const enabled = enable.read().level !== 0;
      out = enabled && vin >= regulator.minIn ? 3.3 : 0;
    }
    if (out > 0) {
      if (out !== driven) {
        driven = out;
        rail.driveVolts(ground + out, Strength.supply);
      }
    } else if (driven >= 0) {
      driven = -1;
      rail.release();
    }
    const v = out > 0 ? out : volts(rail.read(), ground);
    const on = power.on ? v >= spec.brownOut : v >= spec.brownOut + BROWN_OUT_HYSTERESIS;
    power.on = on;
    const lit = v >= POWER_LED_VOLTS;
    if (lit !== led.on) {
      led.on = lit;
      ctx.invalidate();
    }
    const inHigh = vin > regulator.maxIn;
    const high = inHigh || v > spec.maxRail;
    if (high !== over || fresh) {
      over = high;
      report(
        'board-overvoltage',
        'error',
        high,
        inHigh
          ? `The ${spec.board}'s ${spec.input} is at ${vin.toFixed(2)} V; ${regulator.kind === 'ldo' ? 'its 3.3 V regulator' : 'its buck-boost'} takes ${regulator.maxIn} V at most.`
          : `The ${spec.board}'s 3V3 rail is at ${v.toFixed(2)} V; the ${spec.chip} takes ${spec.maxRail} V at most.`,
      );
    }
    const low = on && spec.minRail !== undefined && v < spec.minRail;
    if (low !== under || fresh) {
      under = low;
      report('board-undervoltage', 'warning', low, `The ${spec.board} runs on ${v.toFixed(2)} V: under ${spec.minRail ?? 0} V the ${spec.chip}'s module is out of spec (flash and radio may fail).`);
    }
    if (!on !== unpowered || fresh) {
      unpowered = !on;
      report(
        'board-unpowered',
        'info',
        !on,
        `The ${spec.board} has no power${v > 0 ? ` (its 3V3 rail is at ${v.toFixed(2)} V, under the ${spec.chip}'s ${spec.brownOut} V brown-out level)` : ''}: ${usbPowered ? 'USB' : `with USB off, ${spec.input} or 3V3`} must feed it.`,
      );
    }
    fresh = false;
  };
  gnd.onChange(update);
  input.onChange(update);
  rail.onChange(update);
  enable?.onChange(update);
  update();

  return {
    power,
    led,
    reset() {
      fresh = true;
      update();
    },
  };
}
