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
 * IN pin with ENA on) gives E = D·V·Rm/(Rw + Rm), proportional to the duty. BT178: the winding's
 * inductance (`mH`, 1 by default: τ = L/Rw ≈ 0.25 ms) is the element's `henries`, so a PWM'd
 * motor's current freewheels through a flyback diode between pulses (or kicks a switch without
 * one), and a low-side MOSFET's duty sets its speed.
 *
 * The model can't read the layer's state, so it integrates the same equations from its terminal
 * volts V — the element's state depends on V alone, whatever drives it — exactly while V holds:
 * without inductance E tends to V·Rm/(Rw + Rm) with τ = C·(Rw ∥ Rm); with it (BT178) the winding's
 * current i and E move together, L·di/dt = V − Rw·i − E and C·dE/dt = i − E/Rm, solved with the
 * 2 × 2 matrix exponential (Sylvester's formula). With its terminals floating the layer publishes
 * V = E (no current in the winding), so the pull vanishes and E coasts down through Rm alone, as the
 * layer's does — no need to tell driven from floating (a net reached through a transistor has no
 * switch-level driver anyway). Visual:
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
  /** BT178: the winding's inductance, henries (0: none). */
  l: number;
}

/** A motor's electrical equivalent from its props. */
export function motorParams(props: PartProps): MotorParams {
  const volts = positive(props.volts, 6);
  const rpm = positive(props.rpm, 200);
  const rw = positive(props.ohms, 4);
  const tau = positive(props.msTau, 60) / 1000;
  const f = Math.min(0.5, Math.max(0.01, positive(props.noLoadPct, 10) / 100));
  const omega = (rpm * 2 * Math.PI) / 60;
  const mh = Number(props.mH);
  const l = Number.isFinite(mh) && mh >= 0 ? mh / 1000 : 1e-3;
  return { rw, c: tau / rw, rm: (rw * (1 - f)) / f, ke: (volts * (1 - f)) / omega, l };
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
  defaults: { volts: 6, rpm: 200, ohms: 4, msTau: 60, noLoadPct: 10, mH: 1 },
  createModel(ctx, props) {
    const p = motorParams(props);
    const analog = (props as PartProps)[ANALOG_PROP] === true;
    const plus = ctx.pin('+');
    const minus = ctx.pin('-');
    const rp = (p.rw * p.rm) / (p.rw + p.rm);
    // BT178: the 2 × 2 system [i, E]' = A·[i, E] + [V/L, 0], its eigenvalues (real or a pair).
    const a11 = p.l > 0 ? -p.rw / p.l : 0;
    const a12 = p.l > 0 ? -1 / p.l : 0;
    const a21 = 1 / p.c;
    const a22 = -1 / (p.rm * p.c);
    const trace = a11 + a22;
    const disc = trace * trace - 4 * (a11 * a22 - a12 * a21);
    let e = 0; // back-EMF, volts
    let i = 0; // BT178: the winding's current, amps (with inductance)
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
      if (p.l > 0) {
        // [i, E] = steady + e^{A·dt}·([i, E] − steady); the angle from E's trapezoid (E is the slow one).
        const di = i - target / p.rm;
        const de = e - target;
        let m11: number;
        let m12: number;
        let m21: number;
        let m22: number;
        if (disc > 0) {
          const root = Math.sqrt(disc);
          const l1 = (trace + root) / 2;
          const l2 = (trace - root) / 2;
          const x1 = Math.exp(l1 * dt) / (l1 - l2);
          const x2 = Math.exp(l2 * dt) / (l1 - l2);
          // Sylvester: e^{At} = (e^{λ1 t}(A − λ2 I) − e^{λ2 t}(A − λ1 I)) / (λ1 − λ2).
          m11 = x1 * (a11 - l2) - x2 * (a11 - l1);
          m12 = (x1 - x2) * a12;
          m21 = (x1 - x2) * a21;
          m22 = x1 * (a22 - l2) - x2 * (a22 - l1);
        } else {
          const alpha = trace / 2;
          const beta = Math.sqrt(-disc) / 2;
          const k = Math.exp(alpha * dt);
          const sb = beta > 0 ? Math.sin(beta * dt) / beta : dt;
          const cb = Math.cos(beta * dt);
          m11 = k * (cb + sb * (a11 - alpha));
          m12 = k * sb * a12;
          m21 = k * sb * a21;
          m22 = k * (cb + sb * (a22 - alpha));
        }
        const e0 = e;
        i = target / p.rm + m11 * di + m12 * de;
        e = target + m21 * di + m22 * de;
        angle += ((((e0 + e) / 2) * dt) / p.ke) * (180 / Math.PI);
        return;
      }
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
        visual.milliamps = Math.round((p.l > 0 ? i : (v - e) / p.rw) * 1e5) / 100;
        return visual;
      },
      reset() {
        e = 0;
        i = 0;
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
