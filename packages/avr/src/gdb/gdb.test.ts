import { parseElf32, SymbolTable } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { readFixture } from '../../../core/src/firmware/fixtures.test-helper.ts';
import { createAtmega328p, UNO_CLOCK_HZ } from '../atmega328p.ts';
import { encodePacket, RspDecoder } from './rsp.ts';
import { type GdbControl, GdbSession } from './server.ts';

// The GDB Remote Serial Protocol stub (BT26): framing, the AVR register/memory view, and the
// command dispatcher on a real ATmega328P running debug-demo.elf.

const bytes = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const ELF = readFixture('fixtures/firmware/uno/debug-demo.elf');

describe('RSP framing', () => {
  it('encodes with the mod-256 checksum', () => {
    expect(['qSupported', 'g', '?', 'OK', 'S05'].map(encodePacket)).toEqual(['$qSupported#37', '$g#67', '$?#3f', '$OK#9a', '$S05#b8']);
    expect(encodePacket('a#b}c$d*')).toBe(`$a}\x03b}]c}\x04d}\x0a#${encodePacket('a#b}c$d*').slice(-2)}`);
  });

  it('decodes acks, a packet split across chunks, two packets in one chunk, interrupts and escapes', () => {
    const d = new RspDecoder();
    expect(d.feed(bytes('+$qSupp'))).toEqual([{ type: 'ack' }]);
    expect(d.feed(bytes('orted#3'))).toEqual([]);
    expect(d.feed(bytes('7'))).toEqual([{ type: 'packet', data: 'qSupported' }]);
    expect(d.feed(bytes('$g#67$?#3f'))).toEqual([
      { type: 'packet', data: 'g' },
      { type: 'packet', data: '?' },
    ]);
    expect(d.feed(Uint8Array.of(0x03, 0x2d))).toEqual([{ type: 'interrupt' }, { type: 'nack' }]);
    // '}' + (byte ^ 0x20): '}\x03' is '#'; the checksum covers the bytes as sent.
    expect(d.feed(bytes(encodePacket('X#Y}')))).toEqual([{ type: 'packet', data: 'X#Y}' }]);
    expect(d.feed(bytes('$g#00'))).toEqual([{ type: 'bad' }]);
    expect(d.feed(bytes('$g#zz+'))).toEqual([{ type: 'bad' }, { type: 'ack' }]);
  });
});

/** A session on a real MCU; continue runs synchronously to the next breakpoint (or 1 s). */
function harness() {
  const mcu = createAtmega328p();
  mcu.load({ format: 'elf', bytes: ELF });
  const debug = mcu.debug();
  const out: string[] = [];
  const events: string[] = [];
  let session: GdbSession;
  const control: GdbControl = {
    debug,
    continue() {
      const result = mcu.runUntil(mcu.cycles + UNO_CLOCK_HZ);
      if (result.reason === 'breakpoint') session.stopped('breakpoint');
      else events.push('still running');
    },
    interrupt() {
      session.stopped('interrupt');
    },
    step() {
      debug.step();
      return 'step';
    },
    reset() {
      mcu.reset();
      events.push('reset');
    },
    close() {
      events.push('close');
    },
  };
  session = new GdbSession(control, (data) => out.push(data));
  /** Sends one packet; returns what came back (acks included). */
  const send = (data: string): string[] => {
    out.length = 0;
    session.receive(bytes(encodePacket(data)));
    return [...out];
  };
  /** The reply packet's data for one command. */
  const ask = (data: string): string => {
    const replies = send(data).filter((r) => r.startsWith('$'));
    return replies.length === 0 ? '<none>' : replies[0].slice(1, replies[0].lastIndexOf('#'));
  };
  return { mcu, debug, session, send, ask, events };
}

describe('AVR target', () => {
  it('g is 39 bytes: R0–R31, SREG, SP little-endian, PC as a 4-byte byte address (0 after reset); G round-trips', () => {
    const { ask } = harness();
    const g = ask('g');
    expect(g).toHaveLength(78);
    expect(g.slice(70)).toBe('00000000');
    const changed = `${'11'.repeat(32)}82fe08${'26030000'}`; // SREG 0x82, SP 0x08fe, PC 0x0326
    expect(ask(`G${changed}`)).toBe('OK');
    expect(ask('g')).toBe(changed);
    expect(ask('G1234')).toBe('E01');
  });

  it('m and M over flash (0x0), data (0x800000) and EEPROM (0x810000); out of range is E01', () => {
    const { ask } = harness();
    expect(ask('m0,2')).toBe('0c94'); // the reset vector's JMP
    expect(ask('M800100,2:abcd')).toBe('OK');
    expect(ask('m800100,2')).toBe('abcd');
    expect(ask('m810000,1')).toBe('ff');
    expect(ask('M810000,1:5a')).toBe('OK');
    expect(ask('m810000,1')).toBe('5a');
    expect(ask('m8000,1')).toBe('E01'); // past 32 KiB of flash
    expect(ask('m800900,1')).toBe('E01'); // past the data space
    expect(ask('m900000,1')).toBe('E01'); // no such space
    expect(ask('M800100,2:abc')).toBe('E01');
  });
});

describe('GDB session', () => {
  const addSlow = SymbolTable.fromElf(parseElf32(ELF)).lookup('addSlow')!.address;
  const pcOf = (g: string): number => Number.parseInt(g.slice(70, 72), 16) | (Number.parseInt(g.slice(72, 74), 16) << 8);

  it('answers the usual opening, breakpoints, continue and step', () => {
    const { ask, send } = harness();
    expect(send('qSupported:multiprocess+;swbreak+')).toEqual(['+', encodePacket('PacketSize=1000;QStartNoAckMode+')]);
    expect(ask('?')).toBe('S05');
    expect(ask('qAttached')).toBe('1');
    expect(ask('qC')).toBe('QC1');
    expect(ask('qfThreadInfo')).toBe('m1');
    expect(ask('qsThreadInfo')).toBe('l');
    expect(ask('Hg0')).toBe('OK');
    expect(ask('vCont?')).toBe('vCont;c;C;s;S');
    expect(ask('qXfer:features:read:target.xml:0,fff')).toBe('');
    expect(ask(`Z0,${addSlow.toString(16)},2`)).toBe('OK');
    expect(ask(`Z2,${addSlow.toString(16)},2`)).toBe(''); // watchpoints: not supported
    expect(ask('c')).toBe('S05');
    expect(pcOf(ask('g'))).toBe(addSlow);
    expect(ask('s')).toBe('S05');
    expect(pcOf(ask('g'))).toBe(addSlow + 2);
    expect(ask('vCont;c:1')).toBe('S05'); // next loop, same breakpoint
    expect(pcOf(ask('g'))).toBe(addSlow);
    expect(ask('vCont;s:1')).toBe('S05');
    expect(ask(`z0,${addSlow.toString(16)},2`)).toBe('OK');
    expect(ask('Z0,1,2')).toBe('E01'); // odd: not an instruction address
  });

  it('a bad checksum gets "-", a nack resends, and no acks after QStartNoAckMode', () => {
    const { session, send } = harness();
    const out: string[] = [];
    const s = session as unknown as { write: (d: string) => void };
    const original = s.write;
    s.write = (d) => {
      out.push(d);
      original(d);
    };
    session.receive(bytes('$g#00'));
    expect(out).toEqual(['-']);
    out.length = 0;
    session.receive(bytes(`${encodePacket('?')}-`));
    expect(out).toEqual(['+', '$S05#b8', '$S05#b8']);
    expect(send('QStartNoAckMode')).toEqual(['+', '$OK#9a']);
    expect(send('?')).toEqual(['$S05#b8']);
    out.length = 0;
    session.receive(bytes('$g#00'));
    expect(out).toEqual([]);
  });

  it('k resets and closes; D says OK and closes', () => {
    const k = harness();
    expect(k.send('k')).toEqual(['+']);
    expect(k.events).toEqual(['reset', 'close']);
    const d = harness();
    expect(d.ask('D')).toBe('OK');
    expect(d.events).toEqual(['close']);
  });
});
