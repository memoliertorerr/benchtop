import { beforeEach, describe, expect, it } from 'vitest';
import type { BusRow } from '../../sim/protocol.ts';
import { applyChunk, busDropped, busPending, busRows, clearBus, MAX_ROWS, rowSummary, rowsText, shownRows, sourcesOf } from './bus-store.ts';

// BT87: the Bus tab's store — what frames carry, kept and filtered.

const i2c = (t: number, bytes: number[], extra: Partial<BusRow> = {}): BusRow =>
  ({ bus: 'i2c', source: 0, t, end: t + 100, count: bytes.length, address: 0x27, read: false, ack: true, bytes, acks: bytes.map(() => true), restarted: false, label: 'lcd1 (I2C 0x27)', board: 'uno', part: 'lcd1', ...extra }) as BusRow;
const spi = (t: number, mosi: number[]): BusRow => ({ bus: 'spi', source: 1, t, end: t, count: mosi.length, mosi, miso: mosi.map(() => 0xff), framed: true, label: 'tft (SPI)', board: 'uno', part: 'tft' });
const uart = (t: number, text: string, direction: 'tx' | 'rx' = 'tx'): BusRow => {
  const bytes = [...text].map((c) => c.charCodeAt(0));
  return { bus: 'uart', source: 2, t, end: t, count: bytes.length, bytes, label: `uno Serial ${direction.toUpperCase()}`, board: 'uno', part: null, direction };
};

describe('bus store', () => {
  beforeEach(() => clearBus());

  it('appends rows, replaces the open ones, restarts on a load or reset, counts losses', () => {
    applyChunk({ rows: [i2c(0, [8]), spi(10, [0x2a])], pending: [uart(20, 'hel')], lost: 0, restart: false });
    expect(busRows.value).toHaveLength(2);
    expect(busPending.value).toHaveLength(1);
    applyChunk({ rows: [uart(20, 'hello\r\n')], pending: [], lost: 5, restart: false });
    expect(busRows.value.map((r) => r.bus)).toEqual(['i2c', 'spi', 'uart']);
    expect(busPending.value).toEqual([]);
    expect(busDropped.value).toBe(5);
    applyChunk({ rows: [i2c(0, [1])], pending: [], lost: 0, restart: true });
    expect(busRows.value).toHaveLength(1);
    expect(busDropped.value).toBe(0);
  });

  it(`keeps the newest ${MAX_ROWS} rows and counts the rest`, () => {
    applyChunk({ rows: Array.from({ length: MAX_ROWS + 25 }, (_, i) => i2c(i, [i & 0xff])), pending: [], lost: 0, restart: false });
    expect(busRows.value).toHaveLength(MAX_ROWS);
    expect(busRows.value[0].t).toBe(25);
    expect(busDropped.value).toBe(25);
  });

  it('filters by kind and source; lists the sources', () => {
    const rows = [i2c(0, [8]), spi(10, [0x2a]), uart(20, 'hi'), uart(30, 'A', 'rx')];
    expect(shownRows(rows, [], new Set(['i2c', 'uart']), '').map((r) => r.bus)).toEqual(['i2c', 'uart', 'uart']);
    expect(shownRows(rows, [], new Set(['i2c', 'spi', 'uart']), 'tft (SPI)')).toHaveLength(1);
    expect(sourcesOf(rows, [])).toEqual(['lcd1 (I2C 0x27)', 'tft (SPI)', 'uno Serial RX', 'uno Serial TX']);
  });

  it('summarizes rows for people and copies them as text', () => {
    expect(rowSummary(i2c(0, [0x08, 0x0c]))).toBe('W 0x27  08 0c');
    expect(rowSummary(i2c(0, [0x55, 0xaa], { read: true, acks: [true, false] }))).toBe('R 0x27  55 aa');
    expect(rowSummary(i2c(0, [0x01], { acks: [false] }))).toBe('W 0x27  01  (1 NACK)');
    expect(rowSummary(i2c(0, [], { ack: false }))).toBe('W 0x27 NACK  ');
    expect(rowSummary(spi(0, [0x2a, 0, 1]))).toBe('MOSI 2a 00 01  /  MISO ff ff ff');
    expect(rowSummary(uart(0, 'ok\r\n'))).toBe('→ "ok\\r\\n"');
    expect(rowSummary(uart(0, 'A', 'rx'))).toBe('← "A"');
    expect(rowSummary({ ...spi(0, [1, 2, 3]), count: 5000 })).toContain('… (5000 bytes)');
    expect(rowsText([i2c(1_500_000, [8]), uart(2_000_000, 'hi')])).toBe('1.500 ms\tlcd1 (I2C 0x27)\tW 0x27  08\n2.000 ms\tuno Serial TX\t→ "hi"');
  });
});
