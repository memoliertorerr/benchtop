import { beforeAll, describe, expect, it } from 'vitest';
import { bootFixture, runUntil } from '../test-support/boot.test-helper.ts';
import type { Esp32Soc } from '../soc/soc.ts';
import { CODE_UNIMPLEMENTED } from '../soc/periph.ts';

// BT32: the real serial-hello firmware (committed .bin) boots directly on the cached ROM, on
// both cores, and prints exactly "hello from esp32\r\n" on UART0 by 2.0 s simulated — byte for
// byte, nothing before or after (an `E (…)` line or a Guru Meditation would be an emulation bug).

let soc: Esp32Soc;
let uart: string[];
let wall = 0;
const UART_TIMES: number[] = [];

beforeAll(() => {
  const booted = bootFixture('serial-hello');
  soc = booted.soc;
  uart = booted.uart;
  const listener = soc.onUart;
  soc.onUart = (port, byte) => {
    listener?.(port, byte);
    if (port === 0) UART_TIMES.push(soc.seconds());
  };
  const started = performance.now();
  runUntil(soc, 2.0);
  wall = (performance.now() - started) / 1000;
}, 60_000);

describe('serial-hello direct boot', () => {
  it('prints exactly "hello from esp32\\r\\n" on UART0 by 2.0 s', () => {
    expect(soc.stopReason).toBe('');
    expect(JSON.stringify(uart[0])).toBe(JSON.stringify('hello from esp32\r\n'));
    expect(uart[1] + uart[2]).toBe('');
    expect(soc.seconds()).toBeGreaterThanOrEqual(2.0);
  });

  it('runs at 240 MHz after initArduino, and the UART bytes are 115200 baud apart', () => {
    expect(soc.cpuHz).toBe(240e6);
    // 10 bits per byte. IDF's uart_ll_set_baudrate programs 80 MHz · 16 / 115200 = 11111 sixteenths:
    // CLKDIV 694, FRAG 7 → 115201 baud, 86.805 µs a frame. Bytes reach listeners at the slice
    // boundary after their stop bit (≤ 256 / 240 MHz ≈ 1.07 µs late), without drift.
    const clkdiv = soc.uarts[0].regs[0x14 >>> 2];
    expect([clkdiv & 0xfffff, (clkdiv >>> 20) & 0xf]).toEqual([694, 7]);
    const frame = 10 / (80e6 / (694 + 7 / 16));
    const span = UART_TIMES[UART_TIMES.length - 1] - UART_TIMES[0];
    expect(span / (UART_TIMES.length - 1)).toBeCloseTo(frame, 7);
    for (let i = 1; i < UART_TIMES.length; i++) expect(Math.abs(UART_TIMES[i] - UART_TIMES[i - 1] - frame)).toBeLessThan(1.1e-6);
  });

  it('reports the boot (unknown registers, instructions, speed)', () => {
    const instructions = soc.cores[0].instructions + soc.cores[1].instructions;
    const unknown = soc.problems.problems.filter((p) => p.code === CODE_UNIMPLEMENTED);
    console.info(
      [
        `serial-hello: 2.0 s simulated in ${wall.toFixed(2)} s wall; ${instructions.toLocaleString('en-US')} instructions (${(instructions / wall / 1e6).toFixed(1)} MIPS)`,
        `PRO slept ${((soc.cores[0].slept / soc.cores[0].cycles) * 100).toFixed(1)} % of its cycles, APP ${((soc.cores[1].slept / soc.cores[1].cycles) * 100).toFixed(1)} %`,
        `unknown registers (${soc.problems.totals.get(CODE_UNIMPLEMENTED)} accesses, first ${unknown.length} distinct):`,
        ...unknown.map((p) => `  ${p.message}`),
      ].join('\n'),
    );
    expect(unknown.length).toBeLessThanOrEqual(32);
    expect(soc.problems.problems.filter((p) => p.code !== CODE_UNIMPLEMENTED)).toEqual([]);
  });
});
