/**
 * BT201: how an Arduino AVR board (Uno, Nano, Mega) is powered — its rails, driven by its model at
 * supply strength (no `PinDef.volts` on them: a board's positive rails come and go), and the
 * bench's `power` (core bench/power.ts): on while the ATmega's 5V rail is at or above its brown-out
 * level.
 *
 * `usbPowered` (default true): USB's 5 V on the 5V rail, as every board had before BT201. Off, or
 * when VIN outgrows it (the Uno's and Mega's comparator cuts USB off once VIN passes 6.6 V — the
 * Rev3 schematic's LMV358 comparing VIN/2 with 3.3 V), the rail comes from VIN through the 5 V
 * regulator (the Uno's and Mega's NCP1117ST50, the Nano's 1117: VIN − dropout, at most 5 V; the
 * dropout taken as 1.1 V; 20 V its maximum input). With neither, whatever drives the 5V pin from
 * outside is the rail (a 5 V supply straight onto it, bypassing the regulator). The 3.3V pin: the
 * Uno's and Mega's LP2985-33 from the 5V rail (dropout 0.28 V), the Nano's from its USB chip — only
 * on USB. IOREF (the Uno's, the Mega's) follows the 5V rail. GND is always ground (static).
 *
 * The ATmega's brown-out detector at 2.7 V (BODLEVEL as the boards' fuses set it; 50 mV of
 * hysteresis) decides `power.on`; the bench resets the MCU when it comes back. Problems:
 * `board-unpowered` (info) while off; `board-overvoltage` (error) with VIN over the regulator's
 * 20 V or the 5V rail over the ATmega's 6.0 V absolute maximum; `board-undervoltage` (warning)
 * while it runs below its clock's safe supply (16 MHz: 3.78 V on the ATmega328P — the data sheet's
 * 10 MHz at 2.7 V to 20 MHz at 4.5 V —, 4.5 V on the ATmega2560). Not modelled: the power-on
 * start-up delay (the fuses' 65 ms), supply currents, the MCU's pins following a low rail (they
 * still drive 5 V highs). The ON LED lights from 1.8 V on the rail.
 */

import { type NetState, type PartContext, Strength } from '@benchtop/core';

export interface ArduinoPowerSpec {
  /** The board, for messages: "Uno". */
  readonly board: string;
  /** The board's ground pin to read the rails against. */
  readonly ground: string;
  /** VIN above this cuts USB off; undefined: no comparator (the Nano). */
  readonly usbCutoff?: number;
  /** The 3.3V pin: an LDO from the 5V rail, or the USB chip's (USB only). */
  readonly rail3v3: 'ldo' | 'usb';
  /** The lowest supply its 16 MHz clock is safe at, V. */
  readonly clockMin: number;
  /** It has an IOREF pin (the Uno, the Mega): the 5V rail, which it's wired to on the board. */
  readonly ioref?: boolean;
}

export const REGULATOR_DROPOUT = 1.1;
export const REGULATOR_MAX_IN = 20;
export const LDO_3V3_DROPOUT = 0.28;
export const AVR_BROWN_OUT = 2.7;
export const AVR_BROWN_OUT_HYSTERESIS = 0.05;
export const AVR_MAX_VCC = 6.0;
export const ON_LED_VOLTS = 1.8;

const volts = (s: NetState, ground: number): number => (s.strength === Strength.hiz ? 0 : s.volts - ground);

export interface ArduinoPower {
  /** The bench's convention. */
  readonly power: { on: boolean };
  /** The ON LED. */
  readonly led: { on: boolean };
  /** Recompute (and report) from the pins; a bench reset calls it after clearing problems. */
  reset(): void;
}

export function arduinoPower(ctx: PartContext, usbPowered: boolean, spec: ArduinoPowerSpec): ArduinoPower {
  const vin = ctx.pin('VIN');
  const five = ctx.pin('5V');
  const three = ctx.pin('3.3V');
  const gnd = ctx.pin(spec.ground);
  const ioref = spec.ioref === true ? ctx.pin('IOREF') : null;
  const power = { on: false };
  const led = { on: false };
  /** What the board drives on its rails (−1: released). */
  let driven5 = -1;
  let driven3 = -1;
  let drivenRef = -1;
  let over = false;
  let under = false;
  let unpowered = false;
  let fresh = true;

  const report = (code: string, severity: 'error' | 'warning' | 'info', active: boolean, message: string): void => {
    ctx.report({ severity, code, message: active ? message : '', parts: [] });
  };

  const update = (): void => {
    const ground = gnd.read().volts;
    const vinV = volts(vin.read(), ground);
    const regulator = vinV > REGULATOR_DROPOUT ? Math.min(5, vinV - REGULATOR_DROPOUT) : 0;
    const usb = usbPowered && !(spec.usbCutoff !== undefined && vinV > spec.usbCutoff);
    const source = usb ? 5 : regulator;
    if (source > 0) {
      if (source !== driven5) {
        driven5 = source;
        five.driveVolts(ground + source, Strength.supply);
      }
    } else if (driven5 >= 0) {
      driven5 = -1;
      five.release();
    }
    const rail = source > 0 ? source : volts(five.read(), ground);
    if (ioref !== null) {
      if (rail > 0 && rail !== drivenRef) {
        drivenRef = rail;
        ioref.driveVolts(ground + rail, Strength.supply);
      } else if (rail <= 0 && drivenRef >= 0) {
        drivenRef = -1;
        ioref.release();
      }
    }
    const v3 = spec.rail3v3 === 'usb' ? (usbPowered ? 3.3 : 0) : rail > LDO_3V3_DROPOUT ? Math.min(3.3, rail - LDO_3V3_DROPOUT) : 0;
    if (v3 > 0) {
      if (v3 !== driven3) {
        driven3 = v3;
        three.driveVolts(ground + v3, Strength.supply);
      }
    } else if (driven3 >= 0) {
      driven3 = -1;
      three.release();
    }
    const on = power.on ? rail >= AVR_BROWN_OUT : rail >= AVR_BROWN_OUT + AVR_BROWN_OUT_HYSTERESIS;
    power.on = on;
    const lit = rail >= ON_LED_VOLTS;
    if (lit !== led.on) {
      led.on = lit;
      ctx.invalidate();
    }
    const high = vinV > REGULATOR_MAX_IN || rail > AVR_MAX_VCC;
    if (high !== over || fresh) {
      over = high;
      report(
        'board-overvoltage',
        'error',
        high,
        vinV > REGULATOR_MAX_IN
          ? `The ${spec.board}'s VIN is at ${vinV.toFixed(2)} V; its 5 V regulator takes ${REGULATOR_MAX_IN} V at most (7–12 V is right).`
          : `The ${spec.board}'s 5V rail is at ${rail.toFixed(2)} V; the ATmega takes ${AVR_MAX_VCC} V at most.`,
      );
    }
    const low = on && rail < spec.clockMin;
    if (low !== under || fresh) {
      under = low;
      report('board-undervoltage', 'warning', low, `The ${spec.board} runs on ${rail.toFixed(2)} V: below ${spec.clockMin} V its 16 MHz clock is out of the ATmega's spec.`);
    }
    if (!on !== unpowered || fresh) {
      unpowered = !on;
      report(
        'board-unpowered',
        'info',
        !on,
        `The ${spec.board} has no power${rail > 0 ? ` (its 5V rail is at ${rail.toFixed(2)} V, under the ATmega's ${AVR_BROWN_OUT} V brown-out level)` : ''}: ${usbPowered ? 'USB' : 'with USB off, VIN (7–12 V) or 5V'} must feed it.`,
      );
    }
    fresh = false;
  };
  vin.onChange(update);
  gnd.onChange(update);
  five.onChange(update);
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
