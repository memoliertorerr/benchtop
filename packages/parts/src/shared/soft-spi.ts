/**
 * Bit-banged SPI into a part (BT181): mode 0, MSB first — the data pin shifted in on every clock
 * rising edge while chip select is low, a byte handed over on its eighth edge. Chip select going
 * high (or not low: floating counts as deselected, as the bench's hardware SPI does) restarts the
 * byte. A hardware SPI controller toggles no pin, so a part that also takes hardware SPI through
 * `attachSpi` never sees one byte twice. Nothing is allocated per edge.
 */

import type { NetState, PinHandle } from '@benchtop/core';

export interface SoftSpi {
  /** Drops a partial byte (a reset). */
  reset(): void;
}

/** Listens on `clock`, `data` and `select`; `onByte` gets each byte as its eighth bit is clocked in. */
export function listenSoftSpi(clock: PinHandle, data: PinHandle, select: PinHandle, onByte: (byte: number) => void): SoftSpi {
  let high = clock.read().level === 1;
  let shift = 0;
  let bits = 0;
  clock.onChange((state: NetState) => {
    const now = state.level === 1;
    if (now === high) return;
    high = now;
    if (!now || select.read().level !== 0) return;
    shift = ((shift << 1) | (data.read().level === 1 ? 1 : 0)) & 0xff;
    if (++bits === 8) {
      bits = 0;
      onByte(shift);
    }
  });
  select.onChange((state: NetState) => {
    if (state.level !== 0) bits = 0;
  });
  return {
    reset() {
      bits = 0;
      shift = 0;
    },
  };
}
