import { describe, expect, it } from 'vitest';
import { createTestSoc } from '../test-support/soc.test-helper.ts';
import { REF_HZ } from './context.ts';
import type { Esp32Soc } from './soc.ts';
import { CODE_UART_OVERFLOW } from './uart.ts';

// BT35: UART RX on the SoC (no firmware: the PRO_CPU sleeps in WAITI and the test reads the
// registers): line-rate arrival, RXFIFO_FULL, RXFIFO_TOUT, overflow.

const UART0 = 0x3ff40000;

function sleeping(): Esp32Soc {
  const soc = createTestSoc();
  soc.memory.load(0x40080000, Uint8Array.of(0x00, 0x70, 0x00)); // waiti 0
  soc.cores[0].pc = 0x40080000;
  const bus = soc.buses[0];
  bus.write32(UART0 + 0x14, 347 | (4 << 20)); // CLKDIV 347 + 4/16 at the 40 MHz APB: 115 190 baud
  return soc;
}

const w = (soc: Esp32Soc, offset: number, value: number): void => soc.buses[0].write32(UART0 + offset, value);
const r = (soc: Esp32Soc, offset: number): number => soc.buses[0].read32(UART0 + offset) >>> 0;
/** One 8N1 frame at CLKDIV 347.25 on 40 MHz, in reference cycles. */
const FRAME = (10 * 347.25 * REF_HZ) / 40e6;

describe('UART RX (BT35)', () => {
  it('delivers bytes into the RX FIFO one frame apart, at the configured baud', () => {
    const soc = sleeping();
    soc.uarts[0].receive(new TextEncoder().encode('abc'));
    soc.runUntil(Math.floor(FRAME) - 1);
    expect(r(soc, 0x1c) & 0xff).toBe(0); // RXFIFO_CNT: the first stop bit hasn't ended
    soc.runUntil(Math.ceil(FRAME));
    expect(r(soc, 0x1c) & 0xff).toBe(1);
    soc.runUntil(Math.ceil(3 * FRAME));
    expect(r(soc, 0x1c) & 0xff).toBe(3);
    // MEM_RX_STATUS: WR_ADDR − RD_ADDR is the fill level (uart_ll_get_rxfifo_len).
    const mem = r(soc, 0x60);
    expect((((mem >>> 13) & 0x7ff) - ((mem >>> 2) & 0x7ff) + 128) % 128).toBe(3);
    expect([r(soc, 0x00), r(soc, 0x00), r(soc, 0x00)]).toEqual([0x61, 0x62, 0x63]);
    expect(r(soc, 0x1c) & 0xff).toBe(0);
  });

  it('raises RXFIFO_FULL at the threshold and RXFIFO_TOUT after the idle time, on source 34', () => {
    const soc = sleeping();
    w(soc, 0x24, 2 | (1 << 31) | (2 << 24) | (10 << 8)); // full at 2, timeout 2 units = 16 bit times
    w(soc, 0x0c, 1 | (1 << 8)); // INT_ENA FULL, TOUT
    soc.uarts[0].receive(Uint8Array.of(1, 2));
    soc.runUntil(Math.ceil(FRAME) + 10);
    expect(r(soc, 0x1c) & 0xff).toBe(1);
    expect(r(soc, 0x04) & 0x101).toBe(0);
    soc.runUntil(Math.ceil(2 * FRAME) + 1);
    expect(r(soc, 0x04) & 1).toBe(1); // RXFIFO_FULL
    expect(soc.matrix.lines[34]).toBe(1);
    w(soc, 0x10, 1); // INT_CLR FULL: still 2 bytes, so it comes back
    expect(r(soc, 0x04) & 1).toBe(1);
    r(soc, 0x00); // one byte read: below the threshold
    w(soc, 0x10, 1);
    expect(r(soc, 0x04) & 1).toBe(0);
    // TOUT: 16 bit times after the last byte's stop bit.
    const lastByte = 2 * FRAME;
    soc.runUntil(Math.floor(lastByte + 1.6 * FRAME) - 5);
    expect(r(soc, 0x04) & 0x100).toBe(0);
    soc.runUntil(Math.ceil(lastByte + 1.6 * FRAME) + 5);
    expect(r(soc, 0x04) & 0x100).toBe(0x100);
    expect(soc.seconds()).toBeLessThan(0.001);
  });

  it('loses bytes to a full FIFO with RXFIFO_OVF and a Problem, never silently', () => {
    const soc = sleeping();
    soc.uarts[0].receive(new Uint8Array(130).fill(0x55));
    soc.runUntil(Math.ceil(130 * FRAME) + 10);
    expect(soc.uarts[0].rxPending()).toBe(128);
    expect(soc.uarts[0].overflows).toBe(2);
    expect(r(soc, 0x04) & (1 << 4)).toBe(1 << 4);
    expect(soc.problems.problems.find((p) => p.code === CODE_UART_OVERFLOW)?.message).toMatch(/UART0 RX FIFO overflowed/);
  });
});
