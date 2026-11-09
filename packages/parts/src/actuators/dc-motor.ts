/**
 * BT172: a permanent-magnet DC motor (`dc-motor`, pins `+` and `-`; turning forward while + is the
 * higher). Electrically it is the analog layer's capacitor with a series and a parallel resistance
 * (`analogSpecFor`): its winding Rw (`ohms`) in series with C = J/(ke·kt) — the capacitor's voltage
 * is the back-EMF E = ke·ω — shunted by Rm = ke·kt/b for friction, so the circuit gives it its stall
 * current V/Rw, less as it speeds up, a spin-up and a braking time constant ≈ C·Rw, and a coast
 * ≈ C·Rm. From its props (`motorParams`): rated `volts` (6), no-load `rpm` at them, `ohms`,
 * `msTau` (the mechanical time constant) and `noLoadPct` (the no-load current, % of the stall
 * current), which fixes the friction: f = noLoadPct/100, ke = kt = V·(1 − f)/ω0, C = msTau/Rw,
 * Rm = Rw·(1 − f)/f. The defaults are the geared "TT" hobby motor of starter kits, seen at its
 * output shaft: 200 rpm at 6 V, 4 Ω (1.5 A stalled), 60 ms, 10 %. The winding's inductance isn't
 * modeled, so PWM that lets it coast between pulses (an L298N's ENA) settles where
 * D·(V − E)/Rw = E/Rm — 91 % of full speed at half duty — while PWM that brakes between pulses (an
 * IN pin with ENA on) gives E = D·V·Rm/(Rw + Rm), proportional to the duty.
 *
 * The model can't read the layer's state, so it integrates the same first-order equation from its
 * terminal volts V, exactly while V holds: E tends to V·Rm/(Rw + Rm) with τ = C·(Rw ∥ Rm). With its
 * terminals floating the layer publishes V = E (no current in the winding), so that pull vanishes
 * and E coasts down through Rm alone, as the layer's does — no need to tell driven from floating
 * (a net reached through a transistor has no switch-level driver anyway). Visual:
 * `rpm` (signed), `angle` (degrees, unbounded — the shaft's), `milliamps` (the winding's current).
 * Without the analog layer it doesn't turn. Our own view (apps/web views/motors.ts).
 */

import { ANALOG_PROP, NS_PER_MS, type PartProps } from '@benchtop/core';
import { definePart } from '../define.ts';


export interface MotorParams {
  /** Winding resistance, ohms. */
  rw: number;
  /** The back-EMF's capacitor, farads. */
  c: number;
  /** The friction's leak, ohms. */
  rm: number;
  /** Back-EMF constant, V·s/rad. */
  ke: number;
}

/** A motor's electrical equivalent from its props. */
export function motorParams(props: PartProps): MotorParams {
  const volts = positive(props.volts, 6);
  const rpm = positive(props.rpm, 200);
  const rw = positive(props.ohms, 4);
  const tau = positive(props.msTau, 60) / 1000;
  const f = Math.min(0.5, Math.max(0.01, positive(props.noLoadPct, 10) / 100));
  const omega = (rpm * 2 * Math.PI) / 60;
  return { rw, c: tau / rw, rm: (rw * (1 - f)) / f, ke: (volts * (1 - f)) / omega };
}

function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** While it turns faster than this (rpm), the view and the frames hear from it every FRAME_NS. */
const MOVING_RPM = 0.5;
const FRAME_NS = 20 * NS_PER_MS;
const RAD_TO_RPM = 60 / (2 * Math.PI);

export const dcMotor = definePart({
  type: 'dc-motor',
  title: 'DC motor',
  category: 'motors',
  size: { w: 27.94, h: 15.24 },
  pins: [
    { name: '+', x: 1.27, y: 5.08, role: 'passive' },
    { name: '-', x: 1.27, y: 10.16, role: 'passive' },
  ],
  defaults: { volts: 6, rpm: 200, ohms: 4, msTau: 60, noLoadPct: 10 },
  createModel(ctx, props) {
    const p = motorParams(props);
    const analog = (props as PartProps)[ANALOG_PROP] === true;
    const plus = ctx.pin('+');
    const minus = ctx.pin('-');
    const rp = (p.rw * p.rm) / (p.rw + p.rm);
    let e = 0; // back-EMF, volts
    let angle = 0; // degrees
    let v = 0; // terminal volts, + over −
    let at = ctx.now();
    let timer = -1;
    const visual = { rpm: 0, angle: 0, milliamps: 0 };
    /** Advances E and the angle to now under the last terminal state, exactly. */
    const advance = (): void => {
      const now = ctx.now();
      const dt = (now - at) / 1e9;
      at = now;
      if (!(dt > 0)) return;
      const target = (v * p.rm) / (p.rw + p.rm);
      const tau = p.c * rp;
      const decay = Math.exp(-dt / tau);
      // ∫E dt over the interval, for the angle.
      const area = target * dt + (e - target) * tau * (1 - decay);
      e = target + (e - target) * decay;
      angle += (area / p.ke) * (180 / Math.PI);
    };
    const update = (): void => {
      advance();
      v = plus.read().volts - minus.read().volts;
      ctx.invalidate();
      if (timer < 0 && analog) timer = ctx.schedule(FRAME_NS, tick);
    };
    const tick = (): void => {
      timer = -1;
      advance();
      ctx.invalidate();
      if (Math.abs((e / p.ke) * RAD_TO_RPM) > MOVING_RPM || Math.abs(v) > 0.01) timer = ctx.schedule(FRAME_NS, tick);
    };
    if (analog) {
      plus.onChange(update);
      minus.onChange(update);
    }
    return {
      visual() {
        if (analog) advance();
        visual.rpm = Math.round((e / p.ke) * RAD_TO_RPM);
        visual.angle = angle;
        visual.milliamps = Math.round(((v - e) / p.rw) * 1e5) / 100;
        return visual;
      },
      reset() {
        e = 0;
        angle = 0;
        v = 0;
        at = ctx.now();
        if (timer >= 0) ctx.cancel(timer);
        timer = -1;
        if (analog) update();
      },
    };
  },
});
