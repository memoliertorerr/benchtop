import { describe, expect, it } from 'vitest';
import type { PeriphHost } from './block.ts';
import { FlashChip } from './flash-chip.ts';
import { Qmi } from './qmi.ts';

// BT65: QMI's direct mode on the flash chip, the way the bootrom drives it.

const host: PeriphHost = { now: () => 0, setIrq: () => {}, unmodelled: () => {} };
const XOR = 1;
const EN = 1;
const CS = 4;
const NOPUSH = 1 << 20;
const WIDE = 1 << 18;

function setup() {
  const flash = new Uint8Array(0x400000).fill(0xff);
  const chip = new FlashChip(flash);
  const changes: [number, number][] = [];
  chip.onChange = (a, b) => changes.push([a, b]);
  const qmi = new Qmi('QMI', 0x400d0000, host, chip);
  /** One transaction: CS on, push, CS off; returns what DIRECT_RX received. */
  const txn = (...pushes: number[]): number[] => {
    qmi.write(0x00, EN | CS, 0);
    for (const p of pushes) qmi.write(0x04, p, 0);
    const rx: number[] = [];
    while ((qmi.read(0x00) & (1 << 16)) === 0) rx.push(qmi.read(0x08));
    qmi.write(0x00, 0, 0);
    return rx;
  };
  return { flash, qmi, txn, changes };
}

describe('QMI direct mode and the flash chip', () => {
  it('reads the JEDEC ID and status', () => {
    const { txn } = setup();
    expect(txn(0x9f | NOPUSH, 0, 0, 0)).toEqual([0xef, 0x40, 0x16]);
    expect(txn(0x05 | NOPUSH, 0)).toEqual([0]);
    expect(txn(0x35 | NOPUSH, 0)).toEqual([0x02]); // QE set
  });

  it('erases and programs a page after write enable, ANDing bits; reads them back', () => {
    const { flash, txn, changes } = setup();
    flash.fill(0x0f, 0x3fe000, 0x3ff000);
    txn(0x20, 0x3f, 0xe0, 0x00); // no write enable: ignored
    expect(flash[0x3fe000]).toBe(0x0f);
    txn(0x06);
    expect(txn(0x05 | NOPUSH, 0)).toEqual([0x02]); // WEL
    txn(0x20 | NOPUSH, 0x3f | NOPUSH, 0xe0 | NOPUSH, 0x00 | NOPUSH);
    expect(flash[0x3fe000]).toBe(0xff);
    txn(0x06);
    txn(0x02 | NOPUSH, 0x3f | NOPUSH, 0xe0 | NOPUSH, 0xfe | NOPUSH, 0x2a | NOPUSH, 0x07 | NOPUSH, 0x0f | NOPUSH);
    // 0x3fe0fe, 0x3fe0ff, then wrap to the page start 0x3fe000
    expect([flash[0x3fe0fe], flash[0x3fe0ff], flash[0x3fe000]]).toEqual([0x2a, 0x07, 0x0f]);
    expect(changes).toEqual([
      [0x3fe000, 0x3ff000],
      [0x3fe000, 0x3fe100],
    ]);
    expect(txn(0x03 | NOPUSH, 0x3f | NOPUSH, 0xe0 | NOPUSH, 0xfe | NOPUSH, 0, 0)).toEqual([0x2a, 0x07]);
  });

  it('shifts pushes made before enabling, and a 16-bit entry low byte first', () => {
    const { qmi } = setup();
    qmi.write(0x04, 0x9f | NOPUSH, 0); // queued while disabled
    expect(qmi.read(0x00) & (1 << 11)).toBe(0); // not TXEMPTY
    qmi.write(0x00, EN | CS, XOR); // EN and CS on through the XOR alias, as the bootrom does
    qmi.write(0x04, WIDE, 0);
    expect(qmi.read(0x08)).toBe(0x40ef); // first byte in the low half
    qmi.write(0x00, EN | CS, XOR);
  });

  it('keeps EBh continuous read mode until a 0xFF first byte', () => {
    const { flash, txn } = setup();
    flash.set([1, 2, 3], 0x100);
    // EB, address 000100, mode A0, 2 dummy bytes, then data
    expect(txn(0xeb | NOPUSH, 0x00 | NOPUSH, 0x01 | NOPUSH, 0x00 | NOPUSH, 0xa0 | NOPUSH, 0 | NOPUSH, 0 | NOPUSH, 0, 0)).toEqual([1, 2]);
    // continuous: the next transaction starts at the address
    expect(txn(0x00 | NOPUSH, 0x01 | NOPUSH, 0x01 | NOPUSH, 0x00 | NOPUSH, 0 | NOPUSH, 0 | NOPUSH, 0)).toEqual([2]);
    txn(0xff, 0xff);
    expect(txn(0x9f | NOPUSH, 0)).toEqual([0xef]);
  });
});
