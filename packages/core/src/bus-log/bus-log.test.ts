import { describe, expect, it } from 'vitest';
import type { I2cDevice } from '../contracts/bus.ts';
import type { PartDefinition } from '../contracts/part.ts';
import { NS_PER_MS } from '../contracts/time.ts';
import { Bench } from '../bench/bench.ts';
import { FakeMcu, fakeBoard, makeBenchEnv, testDoc, toggleSteps } from '../testing.ts';
import { BusDecoder, describeTransaction, MAX_BYTES, type BusTransaction } from './decode.ts';
import { BUS, BusLog, type BusSource } from './log.ts';

// BT86: the bus log's ring, the decoder, and the bench's logging of I2C, SPI and UART traffic.

function decodeAll(log: BusLog, now = Infinity): BusTransaction[] {
  const decoder = new BusDecoder();
  return [...decoder.feed(log.read(0), log.sources), ...decoder.flush(now, log.sources), ...decoder.pending()];
}

describe('BusLog', () => {
  it('keeps the newest records, counts what it overwrote, reads from an absolute index', () => {
    const log = new BusLog(8);
    const src = log.addSource({ bus: 'uart', board: 'b', part: null, label: 'b Serial TX' });
    for (let i = 0; i < 12; i++) log.push(i * 10, BUS.UART_TX, src.id, 65 + i, 0);
    expect(log.written).toBe(12);
    expect(log.first).toBe(4);
    const all = log.read(0);
    expect(all).toMatchObject({ from: 4, lost: 4 });
    expect([...all.a]).toEqual([69, 70, 71, 72, 73, 74, 75, 76]);
    const tail = log.read(10);
    expect([...tail.times]).toEqual([100, 110]);
    expect(log.read(12).times.length).toBe(0);
    const capped = log.read(0, 3);
    expect([...capped.a]).toEqual([74, 75, 76]);
    expect(capped.lost).toBe(9);
  });
});

describe('BusDecoder', () => {
  const sources: BusSource[] = [
    { id: 0, bus: 'i2c', board: 'uno', part: 'lcd', label: 'lcd (I2C 0x27)' },
    { id: 1, bus: 'spi', board: 'uno', part: 'tft', label: 'tft (SPI)' },
    { id: 2, bus: 'uart', board: 'uno', part: null, label: 'uno Serial TX', baud: () => 115_200, direction: 'tx' },
  ];
  const log = (records: [number, number, number, number, number][]): BusLog => {
    const l = new BusLog();
    for (const s of sources) l.addSource(s);
    for (const [t, kind, source, a, b] of records) l.push(t, kind, source, a, b);
    return l;
  };

  it('I2C: a write, a read with a repeated START, a NACKed address', () => {
    const txs = decodeAll(
      log([
        [100, BUS.I2C_START, 0, 0x27, 1],
        [110, BUS.I2C_WRITE, 0, 0x08, 1],
        [120, BUS.I2C_WRITE, 0, 0x0c, 1],
        [130, BUS.I2C_STOP, 0, 0, 0],
        [200, BUS.I2C_START, 0, 0x27, 1],
        [210, BUS.I2C_WRITE, 0, 0x01, 1],
        [220, BUS.I2C_START, 0, 0x27 | 0x80, 1],
        [230, BUS.I2C_READ, 0, 0x55, 1],
        [240, BUS.I2C_READ, 0, 0xaa, 0],
        [250, BUS.I2C_STOP, 0, 0, 0],
        [300, BUS.I2C_START, 0, 0x27, 0],
        [310, BUS.I2C_STOP, 0, 0, 0],
      ]),
    );
    expect(txs).toEqual([
      { bus: 'i2c', source: 0, t: 100, end: 130, count: 2, address: 0x27, read: false, ack: true, bytes: [8, 12], acks: [true, true], restarted: false },
      { bus: 'i2c', source: 0, t: 200, end: 210, count: 1, address: 0x27, read: false, ack: true, bytes: [1], acks: [true], restarted: true },
      { bus: 'i2c', source: 0, t: 220, end: 250, count: 2, address: 0x27, read: true, ack: true, bytes: [0x55, 0xaa], acks: [true, false], restarted: false },
      { bus: 'i2c', source: 0, t: 300, end: 310, count: 0, address: 0x27, read: false, ack: false, bytes: [], acks: [], restarted: false },
    ]);
    expect(describeTransaction(txs[0], sources)).toBe('0.000 ms  lcd (I2C 0x27)  W 0x27  08 0c');
    expect(describeTransaction(txs[3], sources)).toContain('NACK');
  });

  it('SPI: CS frames, and transfers without CS grouped by 100 µs gaps', () => {
    const txs = decodeAll(
      log([
        [0, BUS.SPI_SELECT, 1, 0, 0],
        [10, BUS.SPI_XFER, 1, 0x2a, 0xff],
        [20, BUS.SPI_XFER, 1, 0x00, 0xff],
        [30, BUS.SPI_DESELECT, 1, 0, 0],
        [1000, BUS.SPI_XFER, 1, 1, 0],
        [2000, BUS.SPI_XFER, 1, 2, 0],
        [500_000, BUS.SPI_XFER, 1, 3, 0],
      ]),
      1_000_000,
    );
    expect(txs.map((t) => (t.bus === 'spi' ? [t.framed, t.mosi] : null))).toEqual([
      [true, [0x2a, 0]],
      [false, [1, 2]],
      [false, [3]],
    ]);
  });

  it('UART: bursts end at a gap of two byte-times; flush closes the last one; long ones are capped', () => {
    const byte = 1e9 / 11_520; // one 10-bit frame at 115200 baud
    const records: [number, number, number, number, number][] = [];
    [...'hello\n'].forEach((c, i) => records.push([i * byte, BUS.UART_TX, 2, c.charCodeAt(0), 0]));
    [...'ok\n'].forEach((c, i) => records.push([NS_PER_MS + i * byte, BUS.UART_TX, 2, c.charCodeAt(0), 0]));
    const decoder = new BusDecoder();
    const l = log(records);
    const first = decoder.feed(l.read(0), l.sources);
    expect(first.map((t) => (t.bus === 'uart' ? String.fromCharCode(...t.bytes) : ''))).toEqual(['hello\n']);
    expect(decoder.flush(NS_PER_MS + 2 * byte, l.sources)).toEqual([]); // not quiet long enough yet
    const last = decoder.flush(2 * NS_PER_MS, l.sources);
    expect(last.map((t) => (t.bus === 'uart' ? String.fromCharCode(...t.bytes) : ''))).toEqual(['ok\n']);
    expect(describeTransaction(last[0], l.sources)).toContain('"ok\\n"');

    const big = new BusLog(MAX_BYTES * 2);
    for (const s of sources) big.addSource(s);
    for (let i = 0; i < MAX_BYTES + 10; i++) big.push(i, BUS.SPI_XFER, 1, i & 0xff, 0);
    const [tx] = decodeAll(big);
    expect(tx.count).toBe(MAX_BYTES + 10);
    expect(tx.bus === 'spi' && tx.mosi.length).toBe(MAX_BYTES);
  });
});

describe('the bench logs its buses (BT86)', () => {
  const BOARD_PINS = ['D1', 'D2', 'SDA', 'SCL', 'SCK', 'MOSI', 'MISO'];
  const board = fakeBoard('fake-board', BOARD_PINS);
  const device: I2cDevice = { address: 0x3c, start: () => true, write: (b) => b !== 0xee, read: () => 0x42, stop: () => {} };
  const busPart: PartDefinition = {
    type: 'bus-part',
    title: 'Bus part',
    category: 'displays',
    size: { w: 10, h: 5 },
    pins: ['SDA', 'SCL', 'SCK', 'MOSI', 'MISO', 'CS'].map((name, i) => ({ name, x: i * 2.54, y: 0, role: 'digital' as const })),
    defaults: {},
    createModel(ctx) {
      ctx.attachI2c('SDA', 'SCL', device);
      ctx.attachSpi({ sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }, { transfer: (b) => b ^ 0xff });
      return {};
    },
  };

  it('I2C calls, SPI transfers framed by CS, and UART bytes both ways, with their times', () => {
    // D2 drives the part's CS: low from 1 ms to 2 ms; the UART sends "hi" at 0.5 ms.
    const script = [...toggleSteps('D2', 0, 16_000, 3, 1), { cycle: 8_000, tx: [104, 105] }].sort((a, b) => a.cycle - b.cycle);
    const mcu = new FakeMcu({ pins: BOARD_PINS, script, i2c: [{ sda: 'SDA', scl: 'SCL' }], spi: [{ sck: 'SCK', mosi: 'MOSI', miso: 'MISO' }] });
    const bench = new Bench(
      testDoc({ uno: 'fake-board', dev: 'bus-part' }, [
        ['uno:SDA', 'dev:SDA'],
        ['uno:SCL', 'dev:SCL'],
        ['uno:SCK', 'dev:SCK'],
        ['uno:MOSI', 'dev:MOSI'],
        ['uno:MISO', 'dev:MISO'],
        ['uno:D2', 'dev:CS'],
      ]),
      makeBenchEnv([board, busPart], () => mcu),
    );
    bench.runUntil(1.5 * NS_PER_MS); // CS low since 1 ms
    const i2c = mcu.i2cControllers[0].attached[0];
    expect(i2c.address).toBe(0x3c);
    i2c.start(false);
    i2c.write(0x00);
    i2c.write(0xee); // the device NACKs this one
    i2c.stop();
    const spi = mcu.spiControllers[0].attached[0];
    expect(spi.device.transfer(0x2a)).toBe(0xd5);
    bench.runUntil(3 * NS_PER_MS);
    bench.sendSerial('uno', Uint8Array.of(0x41));
    const log = bench.busLog();
    const labels = log.sources.map((s) => s.label);
    expect(labels).toContain('dev (I2C 0x3c)');
    expect(labels).toContain('uno Serial TX');
    const txs = decodeAll(log);
    const i2cTx = txs.find((t) => t.bus === 'i2c');
    expect(i2cTx).toMatchObject({ address: 0x3c, read: false, bytes: [0x00, 0xee], acks: [true, false], t: 1.5 * NS_PER_MS });
    const spiTx = txs.find((t) => t.bus === 'spi');
    expect(spiTx).toMatchObject({ framed: true, mosi: [0x2a], miso: [0xd5], t: NS_PER_MS, end: 2 * NS_PER_MS });
    const uart = txs.filter((t) => t.bus === 'uart').map((t) => [log.sources[t.source].direction, String.fromCharCode(...(t.bus === 'uart' ? t.bytes : [])), t.t]);
    expect(uart).toEqual([
      ['tx', 'hi', 0.5 * NS_PER_MS],
      ['rx', 'A', 3 * NS_PER_MS],
    ]);
    expect(log.sources[i2cTx!.source].board).toBe('uno');
  });
});
