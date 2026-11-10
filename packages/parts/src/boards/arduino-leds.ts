/**
 * The onboard LEDs every Arduino AVR board has (Uno, Nano, Mega): `ledL` follows D13 (brightness
 * 0..1, so PWM dims it); `ledPower` is the ON LED (BT201: lit while the 5V rail is up — see
 * arduino-power.ts, which `arduinoBoardModel` joins to the LEDs); `ledTx`/`ledRx` flash for 30 ms on serial
 * traffic, which the bench's owner reports as input `{ kind: 'key', key: 'serial-tx' |
 * 'serial-rx', down: true }` (no board pin shows it: the USB bridge chip isn't modeled).
 */

import { type PartContext, type PartModel, type PartProps, Strength } from '@benchtop/core';
import { DutyChannel } from '../shared/duty.ts';
import { type ArduinoPowerSpec, arduinoPower } from './arduino-power.ts';

const FLASH_NS = 30_000_000;

/** The board's part model: its L, power, TX and RX LEDs. */
export function arduinoLedsModel(ctx: PartContext, power: { readonly on: boolean } = { on: true }): PartModel {
  const ledL = new DutyChannel(ctx);
  ctx.pin('13').onChange((state) => ledL.set(state.level === 1 && state.strength >= Strength.weak));
  let ledTx = false;
  let ledRx = false;
  let txUntil = 0;
  let rxUntil = 0;
  let armed = false;
  const lightsOff = (): void => {
    const now = ctx.now();
    if (ledTx && now >= txUntil) ledTx = false;
    if (ledRx && now >= rxUntil) ledRx = false;
    ctx.invalidate();
    if (ledTx || ledRx) ctx.schedule(Math.max(ledTx ? txUntil : 0, ledRx ? rxUntil : 0) - now, lightsOff);
    else armed = false;
  };
  const flash = (tx: boolean): void => {
    const until = ctx.now() + FLASH_NS;
    if (tx) {
      ledTx = true;
      txUntil = until;
    } else {
      ledRx = true;
      rxUntil = until;
    }
    ctx.invalidate();
    if (!armed) {
      armed = true;
      ctx.schedule(FLASH_NS, lightsOff);
    }
  };
  return {
    input(event) {
      if (event.kind === 'key' && event.down && (event.key === 'serial-tx' || event.key === 'serial-rx')) {
        flash(event.key === 'serial-tx');
      }
    },
    visual: () => ({ ledL: ledL.brightness, ledPower: power.on, ledTx, ledRx }),
    reset() {
      ledL.reset();
      ledTx = false;
      ledRx = false;
      armed = false;
      ctx.invalidate();
    },
  };
}

/**
 * BT201: an Arduino AVR board's model — its LEDs and its power (`usbPowered`, default true), with
 * the bench's `power` convention.
 */
export function arduinoBoardModel(spec: ArduinoPowerSpec): (ctx: PartContext, props: PartProps) => PartModel & { power: { on: boolean } } {
  return (ctx, props) => {
    const supply = arduinoPower(ctx, props.usbPowered !== false, spec);
    const leds = arduinoLedsModel(ctx, supply.led);
    return {
      ...leds,
      power: supply.power,
      reset() {
        leds.reset?.();
        supply.reset();
      },
    };
  };
}
