import { Bench, NS_PER_MS, type ProjectDoc } from '@benchtop/core';
import { FakeMcu, type FakeStep, fakeBoard, makeBenchEnv, testDoc } from '@benchtop/core/testing';
import { describe, expect, it } from 'vitest';
import { MFRC522_CMD as CMD, MFRC522_REG as REG } from './mfrc522.ts';
import { RC522_CARD_UID, rc522, rc522Uids } from './rc522.ts';

// BT196: the RC522 module on a bench with a scripted MCU — SPI through the bench, its supply and the
// 4 V limit, RST's hard power-down and reset, the IRQ pin; BT197: its tags.

const PINS = ['D5', 'D9', 'D2', 'D18', 'D23', 'D19'];

function bench(doc: ProjectDoc, mcuKind: 'esp32' | 'atmega328p' = 'esp32', script: readonly FakeStep[] = []) {
  const board = fakeBoard('fake-board', PINS, mcuKind);
  const mcu = new FakeMcu({ pins: PINS, script, spi: [{ sck: 'D18', mosi: 'D23', miso: 'D19' }] });
  const b = new Bench(doc, makeBenchEnv([board, rc522], () => mcu));
  const cs = mcu.pins.get('D5');
  if (cs === undefined) throw new Error('no D5');
  cs.set('output', 1);
  const frame = (...bytes: number[]): number[] => {
    const attached = mcu.spiControllers[0].attached;
    cs.set('output', 0);
    const out = bytes.map((byte) => attached.reduce((v, a) => (a.selected() ? v & a.device.transfer(byte) : v), 0xff));
    cs.set('output', 1);
    return out;
  };
  const read = (reg: number): number => frame(0x80 | (reg << 1), 0)[1];
  const write = (reg: number, ...data: number[]): void => void frame(reg << 1, ...data);
  return { b, mcu, frame, read, write };
}

const wiring = (supply: string): [string, string][] => [
  ['mcu:D5', 'rfid:SDA'],
  ['mcu:D18', 'rfid:SCK'],
  ['mcu:D23', 'rfid:MOSI'],
  ['mcu:D19', 'rfid:MISO'],
  ['mcu:D2', 'rfid:IRQ'],
  ['mcu:GND', 'rfid:GND'],
  [`mcu:${supply}`, 'rfid:3.3V'],
];

describe('RC522 module (BT196)', () => {
  it('answers over the board’s SPI on 3.3 V, RST unwired (the module’s pull-up); its LED and field', () => {
    const { b, read, write, mcu } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, wiring('3V3')));
    b.runUntil(NS_PER_MS);
    expect(mcu.spiControllers[0].attached).toHaveLength(1);
    expect(b.problems().filter((p) => p.code === 'spi-unattached' || p.code === 'rc522-overvoltage')).toEqual([]);
    expect(read(REG.Version)).toBe(0x92);
    expect(b.pinState('rfid', 'RST')?.level).toBe(1);
    const visual = (): Record<string, unknown> => {
      let state: Record<string, unknown> = {};
      for (const [id, v] of b.collectFrame().parts) if (id === 'rfid') state = v as Record<string, unknown>;
      return state;
    };
    expect(visual()).toEqual({ powered: true, field: false, card: '', uid: '', kind: 'mifare-1k' });
    write(REG.TxControl, 0x83);
    expect(visual()).toMatchObject({ powered: true, field: true });
  });

  it('on 5 V: rc522-overvoltage (error) and no answer, until the supply is back in range', () => {
    const { b, read } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, wiring('5V')), 'atmega328p');
    b.runUntil(NS_PER_MS);
    const over = b.problems().filter((p) => p.code === 'rc522-overvoltage');
    expect(over).toHaveLength(1);
    expect(over[0].severity).toBe('error');
    expect(over[0].message).toContain('5.00 V');
    expect(read(REG.Version)).toBe(0xff);
  });

  it('RST low is hard power-down (no answer, the antenna off); its rising edge a hard reset', () => {
    const script: FakeStep[] = [
      { cycle: 16_000, pin: 'D9', mode: 'output', level: 0 }, // 1 ms
      { cycle: 32_000, pin: 'D9', mode: 'output', level: 1 }, // 2 ms
    ];
    const { b, read, write } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, [...wiring('3V3'), ['mcu:D9', 'rfid:RST']]), 'esp32', script);
    b.runUntil(0.5 * NS_PER_MS);
    write(REG.TxControl, 0x83);
    write(REG.WaterLevel, 0x20);
    expect([read(REG.TxControl), read(REG.WaterLevel)]).toEqual([0x83, 0x20]);
    b.runUntil(1.5 * NS_PER_MS);
    expect(b.pinState('rfid', 'RST')?.level).toBe(0);
    expect(read(REG.Version)).toBe(0xff);
    b.runUntil(2.5 * NS_PER_MS);
    expect([read(REG.Version), read(REG.TxControl), read(REG.WaterLevel)]).toEqual([0x92, 0x80, 0x08]);
  });

  it('IRQ: open-drain and active low out of reset — the MCU’s pull-up high, pulled low by an enabled interrupt', () => {
    const { b, write } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, wiring('3V3')), 'esp32', [{ cycle: 16, pin: 'D2', mode: 'input-pullup', level: 0 }]);
    b.runUntil(0.1 * NS_PER_MS);
    write(REG.ComIrq, 0x7f);
    b.runUntil(0.2 * NS_PER_MS);
    expect(b.pinState('rfid', 'IRQ')?.level).toBe(1);
    write(REG.ComIEn, 0xa1); // IRqInv, RxIEn, TimerIEn
    write(REG.TPrescaler, 0);
    write(REG.TReloadL, 100);
    write(REG.Control, 0x40); // TStartNow: ≈ 7.4 µs
    b.runUntil(0.3 * NS_PER_MS);
    expect(b.pinState('rfid', 'IRQ')?.level).toBe(0);
    write(REG.ComIrq, 0x01);
    b.runUntil(0.4 * NS_PER_MS);
    expect(b.pinState('rfid', 'IRQ')?.level).toBe(1);
    // Push-pull: driven high at the module's 3.3 V.
    write(REG.DivIEn, 0x80);
    b.runUntil(0.5 * NS_PER_MS);
    expect(b.pinState('rfid', 'IRQ')?.volts).toBeCloseTo(3.3, 2);
  });

  it('(BT197) the card and the fob as part input, one at a time; `present` at power-up and after a reset; what was written stays', () => {
    const { b, read, write } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, wiring('3V3'), { rfid: { present: 'fob' } }));
    b.runUntil(0.1 * NS_PER_MS);
    const visual = (): Record<string, unknown> => {
      let state: Record<string, unknown> = {};
      for (const [id, v] of b.collectFrame().parts) if (id === 'rfid') state = v as Record<string, unknown>;
      return state;
    };
    const seen: Record<string, unknown> = {};
    const latest = (): Record<string, unknown> => Object.assign(seen, visual());
    expect(latest()).toMatchObject({ card: 'fob', uid: '5B 7E 0D 19' });
    write(REG.TxControl, 0x83);
    write(REG.TMode, 0x80);
    write(REG.TPrescaler, 0xa9);
    write(REG.TReloadH, 0x03);
    write(REG.TReloadL, 0xe8);
    /** REQA then anticollision: the UID's first level, or null. */
    const uid = (): number[] | null => {
      const transceive = (bits: number, ...bytes: number[]): number[] | null => {
        write(REG.Command, CMD.Idle);
        write(REG.ComIrq, 0x7f);
        write(REG.FifoLevel, 0x80);
        write(REG.FifoData, ...bytes);
        write(REG.BitFraming, bits);
        write(REG.Command, CMD.Transceive);
        write(REG.BitFraming, 0x80 | bits);
        b.runUntil(b.now() + 30 * NS_PER_MS);
        if ((read(REG.ComIrq) & 0x20) === 0) return null;
        const n = read(REG.FifoLevel);
        return Array.from({ length: n }, () => read(REG.FifoData));
      };
      if (transceive(0x07, 0x26) === null) return null;
      return transceive(0x00, 0x93, 0x20);
    };
    expect(uid()?.slice(0, 4)).toEqual([0x5b, 0x7e, 0x0d, 0x19]);
    b.input('rfid', { kind: 'press' });
    expect(latest()).toMatchObject({ card: 'card', uid: RC522_CARD_UID });
    expect(uid()?.slice(0, 4)).toEqual([0xa3, 0xf1, 0xc5, 0x2e]);
    b.input('rfid', { kind: 'release' });
    expect(latest()).toMatchObject({ card: '', uid: '' });
    expect(uid()).toBeNull();
    b.input('rfid', { kind: 'key', key: 'card', down: true });
    expect(uid()).not.toBeNull();
    b.reset();
    b.runUntil(b.now() + 0.1 * NS_PER_MS);
    expect(latest()).toMatchObject({ card: 'fob' });
  });

  it('(BT197) an NTAG213 card with its 7-byte UID; a UID that doesn’t parse is rfid-uid and the default; new readers get their own UIDs', () => {
    const { b } = bench(testDoc({ mcu: 'fake-board', rfid: 'rc522' }, wiring('3V3'), { rfid: { card: 'ntag213', uid: 'A3F1C52E', present: 'card' } }));
    b.runUntil(0.1 * NS_PER_MS);
    const problem = b.problems().filter((p) => p.code === 'rfid-uid');
    expect(problem).toHaveLength(1);
    expect(problem[0].severity).toBe('warning');
    b.reset();
    expect(b.problems().filter((p) => p.code === 'rfid-uid')).toHaveLength(1); // reported again after a reset
    let state: Record<string, unknown> = {};
    for (const [id, v] of b.collectFrame().parts) if (id === 'rfid') state = v as Record<string, unknown>;
    expect(state).toMatchObject({ card: 'card', uid: '04 3C 8A 52 B1 6E 80', kind: 'ntag213' });
    const a = rc522Uids('rfid');
    const c = rc522Uids('rfid2');
    expect(a.uid).toMatch(/^([0-9A-F]{2} ){3}[0-9A-F]{2}$/);
    expect(new Set([a.uid, a.fobUid, c.uid, c.fobUid]).size).toBe(4);
  });
});
