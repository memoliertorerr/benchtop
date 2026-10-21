/**
 * Transfer functions of the input parts: what voltage (or resistance) a part shows for a given
 * physical value. Pure, so the analog solver (BT21) can reuse them when it turns the resistive
 * ones into links. Until then the parts drive their outputs as ideal sources.
 */

/** Fixed resistor of the LDR and NTC modules (VCC→AO), ohms. */
export const MODULE_DIVIDER_OHMS = 10_000;
/** The LDR's resistance is capped here (darkness). */
export const LDR_MAX_OHMS = 1_000_000;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Wiper of a pot between `low` and `high` volts at `position` 0..1. */
export function potVolts(low: number, high: number, position: number): number {
  return low + (high - low) * clamp(position, 0, 1);
}

/** Joystick axis −1..1 → volts between `low` and `high` (decided: right and up read high). */
export function joystickVolts(low: number, high: number, axis: number): number {
  return low + ((high - low) * (clamp(axis, -1, 1) + 1)) / 2;
}

/** LDR resistance: rl10 · (lux / 10)^(−gamma), capped at 1 MΩ. */
export function ldrOhms(lux: number, rl10: number, gamma: number): number {
  if (!(lux > 0)) return LDR_MAX_OHMS;
  return Math.min(LDR_MAX_OHMS, rl10 * (lux / 10) ** -gamma);
}

/** A divider with `top` ohms to `high` and `bottom` ohms to `low`: the midpoint's volts. */
export function dividerVolts(low: number, high: number, top: number, bottom: number): number {
  return low + ((high - low) * bottom) / (top + bottom);
}

/** Photoresistor module AO: 10 kΩ VCC→AO, LDR AO→GND (brighter → lower). */
export function ldrModuleVolts(low: number, high: number, lux: number, rl10: number, gamma: number): number {
  return dividerVolts(low, high, MODULE_DIVIDER_OHMS, ldrOhms(lux, rl10, gamma));
}

/** NTC thermistor resistance from °C (β model, `r25` ohms at 25 °C). */
export function ntcOhms(celsius: number, r25: number, beta: number): number {
  const kelvin = celsius + 273.15;
  return r25 * Math.exp(beta * (1 / kelvin - 1 / 298.15));
}

/** NTC module OUT: 10 kΩ VCC→OUT, NTC OUT→GND (hotter → lower). */
export function ntcModuleVolts(low: number, high: number, celsius: number, r25: number, beta: number): number {
  return dividerVolts(low, high, MODULE_DIVIDER_OHMS, ntcOhms(celsius, r25, beta));
}

/** Sound module AO: decided V·(0.5 + 0.45·level), a DC envelope (no audio waveform). */
export function soundVolts(low: number, high: number, level: number): number {
  return low + (high - low) * (0.5 + 0.45 * clamp(level, 0, 1));
}

/** Flame sensor module AO (BT53, decided): V·(1 − 0.9·intensity) — more infrared, lower; intensity 0..1. */
export function flameVolts(low: number, high: number, intensity: number): number {
  return low + (high - low) * (1 - 0.9 * clamp(intensity, 0, 1));
}

/** MQ-2 load resistor (AO→GND) and R0 (Rs in 1000 ppm H2, the datasheet's reference), ohms. */
export const MQ2_LOAD_OHMS = 10_000;
export const MQ2_R0_OHMS = 10_000;

/**
 * MQ-2 sensitivity Rs/R0 at `ppm` (BT53, decided): the datasheet's log-log LPG line through
 * ≈ 1.6 at 200 ppm with slope −0.47 — 19.3·ppm^−0.47 — capped at 9.8, its clean-air ratio.
 */
export function mq2Ratio(ppm: number): number {
  if (!(ppm > 0)) return 9.8;
  return Math.min(9.8, 19.3 * ppm ** -0.47);
}

/** MQ-2 module AO: the sensor (Rs) from VCC to AO, 10 kΩ from AO to GND (more gas, higher). */
export function mq2Volts(low: number, high: number, ppm: number): number {
  return dividerVolts(low, high, mq2Ratio(ppm) * MQ2_R0_OHMS, MQ2_LOAD_OHMS);
}
