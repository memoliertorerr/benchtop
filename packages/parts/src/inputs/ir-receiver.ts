/**
 * IR receiver module (VS1838B-style, BT52): a 38 kHz demodulator whose DAT output is active low —
 * low while it sees the carrier, pulled high otherwise. Pins from @wokwi/elements 1.9.2
 * ir-receiver-element.
 *
 * It "sees" an NEC remote through input `{ kind: 'key', key: 'ir:<command>', down }` (the
 * command as a number, `ir:0x30` or `ir:48`; the remote's view sends it to every receiver in the
 * document): a key going down sends one NEC frame, address 0x00 — 9 ms mark, 4.5 ms space, 32
 * bits LSB first (address, ~address, command, ~command), each a 562.5 µs mark then a 562.5 µs
 * (0) or 1,687.5 µs (1) space, and a final 562.5 µs mark (NEC protocol as documented by NEC's
 * µPD6121 datasheet, frame length 67.5 ms). While the key stays down a repeat code follows every
 * 108 ms from the frame's start: 9 ms mark, 2.25 ms space, 562.5 µs mark. A key pressed while a
 * frame is still going out is ignored, as a real remote's would be. Unpowered (VCC floating), DAT
 * is released and keys do nothing.
 */

import { type PartContext, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';

const PX = 25.4 / 96;
const US = 1000;
/** NEC timing, ns. */
export const NEC = {
  leaderMark: 9_000 * US,
  leaderSpace: 4_500 * US,
  bitMark: 562.5 * US,
  zeroSpace: 562.5 * US,
  oneSpace: 1_687.5 * US,
  repeatSpace: 2_250 * US,
  repeatPeriod: 108_000 * US,
} as const;

/** Durations of an NEC frame (mark, space, mark, …, final mark), ns. */
export function necFrame(address: number, command: number): number[] {
  const durations = [NEC.leaderMark, NEC.leaderSpace];
  const bytes = [address & 0xff, ~address & 0xff, command & 0xff, ~command & 0xff];
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) durations.push(NEC.bitMark, (byte >> bit) & 1 ? NEC.oneSpace : NEC.zeroSpace);
  }
  durations.push(NEC.bitMark);
  return durations;
}

const REPEAT = [NEC.leaderMark, NEC.repeatSpace, NEC.bitMark];

/** [name, x px, y px] from the element's pinInfo. */
const PIN_INFO: readonly (readonly [string, number, number])[] = [
  ['GND', 20.977, 87.75],
  ['VCC', 30.578, 87.75],
  ['DAT', 40.18, 87.75],
];
export const IR_RECEIVER_PIN_PX = PIN_INFO;

export const irReceiver = definePart({
  type: 'ir-receiver',
  title: 'IR receiver (38 kHz, NEC)',
  category: 'input',
  size: { w: 16.178, h: 23.482 },
  pins: PIN_INFO.map(([name, x, y]) => ({
    name,
    x: Math.round(x * PX * 1000) / 1000,
    y: Math.round(y * PX * 1000) / 1000,
    role: name === 'VCC' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const),
  })),
  defaults: {},
  createModel(ctx: PartContext) {
    const dat = ctx.pin('DAT');
    const vcc = ctx.pin('VCC');
    let generation = 0;
    let sending = false;
    let held = false;
    let command = 0;
    let frameStart = 0;

    const powered = (): boolean => vcc.read().strength !== Strength.hiz;
    const idle = (): void => {
      if (powered()) dat.drive(1, Strength.weak);
      else dat.release();
    };

    /** Plays `durations` from now: mark (low), space (high), mark, …; then idle, and a repeat while held. */
    const play = (durations: readonly number[]): void => {
      const gen = generation;
      sending = true;
      frameStart = ctx.now();
      let i = 0;
      const next = (): void => {
        if (gen !== generation) return;
        if (i === durations.length) {
          idle();
          sending = false;
          if (held) {
            const wait = frameStart + NEC.repeatPeriod - ctx.now();
            ctx.schedule(Math.max(0, wait), () => {
              if (gen === generation && held && !sending && powered()) play(REPEAT);
            });
          }
          return;
        }
        if (i % 2 === 0) dat.drive(0, Strength.strong);
        else dat.drive(1, Strength.weak);
        ctx.schedule(durations[i++], next);
      };
      next();
    };

    vcc.onChange(() => {
      if (!sending) idle();
    });
    idle();

    return {
      input(event) {
        if (event.kind !== 'key' || !event.key.startsWith('ir:')) return;
        const code = Number(event.key.slice(3));
        if (!Number.isInteger(code) || code < 0 || code > 0xff) return;
        if (!event.down) {
          if (code === command) held = false;
          return;
        }
        if (sending || !powered()) return;
        command = code;
        held = true;
        play(necFrame(0x00, code));
      },
      reset() {
        generation++;
        sending = false;
        held = false;
        idle();
      },
    };
  },
});
