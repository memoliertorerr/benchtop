/**
 * Hobby servo (SG90-like). Pulse width = falling time − rising time on PWM; target angle =
 * (width − minPulseUs)/(maxPulseUs − minPulseUs)·180, clamped, with props minPulseUs 544 and
 * maxPulseUs 2400 (Servo.h's MIN/MAX_PULSE_WIDTH, so Servo.write angles match). Pulses shorter
 * than 300 µs or longer than 3000 µs are ignored. The horn moves toward the target at prop
 * `speed` (600 °/s, an SG90's 0.1 s per 60°), computed lazily from ctx.now() — no timers; each
 * pulse invalidates while it moves. Visual: `angle` (the horn), `target`, `pulseUs`, `periodUs`.
 * Pins from @wokwi/elements 1.9.2 servo-element.
 */

import { NS_PER_US } from '@benchtop/core';
import { definePart } from '../define.ts';

const MIN_VALID_NS = 300 * NS_PER_US;
const MAX_VALID_NS = 3000 * NS_PER_US;

/** Target angle for a pulse of `widthUs` between `minUs` and `maxUs`, clamped to 0..180. */
export function servoAngle(widthUs: number, minUs: number, maxUs: number): number {
  const angle = ((widthUs - minUs) / (maxUs - minUs)) * 180;
  return angle < 0 ? 0 : angle > 180 ? 180 : angle;
}

export const servo = definePart({
  type: 'servo',
  title: 'Servo',
  category: 'motors',
  size: { w: 45, h: 31.63 },
  pins: [
    { name: 'GND', x: 0, y: 13.229, role: 'ground' },
    { name: 'V+', x: 0, y: 15.743, role: 'power' },
    { name: 'PWM', x: 0, y: 18.256, role: 'digital' },
  ],
  defaults: { minPulseUs: 544, maxPulseUs: 2400, speed: 600 },
  createModel(ctx, props) {
    const pwm = ctx.pin('PWM');
    const degPerNs = props.speed / 1e9;
    let riseAt = -1;
    let lastRise = -1;
    let target = 90;
    let from = 90;
    let fromTime = 0;
    let pulseUs = 0;
    let periodUs = 0;
    const visual = { angle: 90, target: 90, pulseUs: 0, periodUs: 0 };
    /** The horn's angle at `now`, moving from `from` toward `target`. */
    const horn = (now: number): number => {
      const travel = (now - fromTime) * degPerNs;
      if (target > from) return Math.min(target, from + travel);
      return Math.max(target, from - travel);
    };
    pwm.onChange((state) => {
      const now = ctx.now();
      if (state.level === 1) {
        if (riseAt < 0) {
          if (lastRise >= 0) periodUs = (now - lastRise) / NS_PER_US;
          lastRise = now;
          riseAt = now;
        }
        return;
      }
      if (riseAt < 0) return;
      const width = now - riseAt;
      riseAt = -1;
      if (width < MIN_VALID_NS || width > MAX_VALID_NS) return;
      pulseUs = width / NS_PER_US;
      const next = servoAngle(pulseUs, props.minPulseUs, props.maxPulseUs);
      const angle = horn(now);
      if (next !== target) {
        from = angle;
        fromTime = now;
        target = next;
      }
      ctx.invalidate();
    });
    return {
      visual() {
        visual.angle = Math.round(horn(ctx.now()) * 100) / 100;
        visual.target = Math.round(target * 100) / 100;
        visual.pulseUs = Math.round(pulseUs * 10) / 10;
        visual.periodUs = Math.round(periodUs * 10) / 10;
        return visual;
      },
      reset() {
        riseAt = -1;
        lastRise = -1;
        target = 90;
        from = 90;
        fromTime = 0;
        pulseUs = 0;
        periodUs = 0;
        ctx.invalidate();
      },
    };
  },
});
