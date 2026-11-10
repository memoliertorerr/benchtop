/**
 * BT196: the RC522 module (`rc522`) — the blue 40 × 60 mm board with an MFRC522 (mfrc522.ts), its
 * 27.12 MHz crystal, the antenna coil and an 8-pin header: SDA (the MFRC522's NSS), SCK, MOSI,
 * MISO, IRQ, GND, RST (NRSTPD), 3.3V. The board fixes the chip's interface to SPI.
 *
 * Power: the 3.3V pin to GND, 2.5 V or more (the datasheet's 2.5–3.6 V); above 4.0 V, its absolute
 * maximum, the module reports `rc522-overvoltage` (error) and stops answering until the supply is
 * back in range — wiring it to an Uno's 5 V is the classic mistake. (5 V logic on its inputs is out
 * of spec too, but is what Uno tutorials do: not reported.) RST is pulled up on the board (as most
 * sold modules are), so it may stay unwired; held low it's the chip's hard power-down, and its
 * rising edge a hard reset. IRQ follows the chip (open-drain, active low out of reset: the MCU's
 * pull-up makes it high). The power LED shows `powered`; `field` is the antenna radiating.
 *
 * BT197: the tags (cards.ts) that come with it — a card (prop `card`: `mifare-1k`, a MIFARE Classic
 * 1K, or `ntag213`; its UID `uid`, 4 or 7 bytes in hex — an NTAG's is 7) and the blue key fob (a
 * MIFARE Classic 1K, `fobUid`). One at a time lies on the antenna: `present` (`none`, `card`,
 * `fob`) at power-up and after a bench reset; while running, press puts the card on, release takes
 * it off, the keys `card`, `fob` and `none` choose. A tag keeps what was written to it across bench
 * resets and off the reader. A UID that doesn't parse reports `rfid-uid` (warning) and the kind's
 * default is used. Visual: `card` (`''`, `card`, `fob`), `uid` ("A3 F1 C5 2E"), `kind`.
 */

import { type NetState, type PartContext, type PartInput, type PartProps, type SpiDevice, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { fnv1a } from '../sensors/ds18b20.ts';
import { formatUid, type Iso14443Card, MifareClassic1k, Ntag213, parseUid } from './cards.ts';
import { Mfrc522, type Mfrc522Host } from './mfrc522.ts';

/** The MFRC522's absolute maximum supply, V (datasheet Table 155). */
export const RC522_MAX_VOLTS = 4.0;
/** The lowest supply it runs at, V (Table 156's 2.5 V). */
export const RC522_MIN_VOLTS = 2.5;

export const RC522_CARD_UID = 'A3 F1 C5 2E';
export const RC522_FOB_UID = '5B 7E 0D 19';
export const RC522_NTAG_UID = '04 3C 8A 52 B1 6E 80';
/** What can lie on the reader (the `present` prop, the key inputs). */
export const RC522_TAGS = ['none', 'card', 'fob'] as const;

/**
 * UIDs for a reader placed with part id `id`: the editor gives each new RC522's tags their own, so
 * two readers in one project don't read the same card.
 */
export function rc522Uids(id: string): { uid: string; fobUid: string } {
  const uid = (key: string): string => {
    const h = fnv1a(`rc522:${id}:${key}`);
    const bytes = [(h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff];
    if (bytes[0] === 0x88) bytes[0] = 0x89; // not the cascade tag
    return formatUid(bytes);
  };
  return { uid: uid('card'), fobUid: uid('fob') };
}

const PINS = ['SDA', 'SCK', 'MOSI', 'MISO', 'IRQ', 'GND', 'RST', '3.3V'] as const;
const SIZE = { w: 40.64, h: 60.96 };

const supplied = (s: NetState): boolean => s.strength !== Strength.hiz;

export const rc522 = definePart({
  type: 'rc522',
  title: 'RC522 RFID reader (MFRC522, 13.56 MHz)',
  category: 'input',
  size: SIZE,
  pins: PINS.map((name, i) => ({
    name,
    x: 11.43 + 2.54 * i,
    y: SIZE.h - 2.54,
    role: name === '3.3V' ? ('power' as const) : name === 'GND' ? ('ground' as const) : ('digital' as const),
  })),
  defaults: { card: 'mifare-1k', uid: RC522_CARD_UID, fobUid: RC522_FOB_UID, present: 'none' },
  createModel(ctx: PartContext, rawProps: PartProps) {
    const vcc = ctx.pin('3.3V');
    const gnd = ctx.pin('GND');
    const rst = ctx.pin('RST');
    const irq = ctx.pin('IRQ');
    const nss = ctx.pin('SDA');
    let powered = false;
    let over = false;
    let supplyVolts = 0;
    let irqOut = -2;

    // The tags, made once: what's written to them stays.
    const ntag = rawProps.card === 'ntag213';
    const problems: string[] = [];
    const tag = (text: unknown, fallback: string, sevenOnly: boolean, name: string): Uint8Array => {
      const uid = parseUid(String(text ?? ''));
      if (uid !== null && (!sevenOnly || uid.length === 7)) return uid;
      problems.push(`${name} "${String(text ?? '')}"`);
      return parseUid(fallback) ?? new Uint8Array(4);
    };
    const cardUid = tag(rawProps.uid, ntag ? RC522_NTAG_UID : RC522_CARD_UID, ntag, ntag ? 'an NTAG213 takes a 7-byte UID, not' : 'the card’s UID');
    const fobUid = tag(rawProps.fobUid, RC522_FOB_UID, false, 'the fob’s UID');
    const card: Iso14443Card = ntag ? new Ntag213(cardUid) : new MifareClassic1k(cardUid);
    const fob: Iso14443Card = new MifareClassic1k(fobUid);
    const uidMessage = problems.length > 0 ? `The RC522’s tags use their default UIDs where theirs don’t parse: ${problems.join('; ')} (4 or 7 bytes in hex).` : '';
    // A bench reset clears part problems: reported again there.
    const reportUid = (): void => {
      if (uidMessage !== '') ctx.report({ severity: 'warning', code: 'rfid-uid', message: uidMessage, parts: [] });
    };
    reportUid();
    const cardText = formatUid(cardUid);
    const fobText = formatUid(fobUid);

    const visual = { powered: false, field: false, card: '', uid: '', kind: ntag ? 'ntag213' : 'mifare-1k' };

    const update = (): void => {
      const out = chip.irqOutput();
      if (out !== irqOut) {
        irqOut = out;
        if (out < 0) irq.release();
        else if (out === 1) irq.driveVolts(supplyVolts, Strength.strong);
        else irq.drive(0, Strength.strong);
      }
      if (visual.field !== chip.field || visual.powered !== powered) {
        visual.field = chip.field;
        visual.powered = powered;
        ctx.invalidate();
      }
    };
    const host: Mfrc522Host = {
      now: () => ctx.now(),
      schedule: (delay, callback) => ctx.schedule(delay, callback),
      cancel: (id) => ctx.cancel(id),
      changed: update,
    };
    const chip = new Mfrc522(host);
    const device: SpiDevice = { transfer: (mosi) => chip.transfer(mosi) };
    ctx.attachSpi({ sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'SDA' }, device);
    nss.onChange(() => chip.select());

    const place = (which: string): void => {
      const on = which === 'card' ? card : which === 'fob' ? fob : null;
      chip.setPicc(on);
      const name = on === null ? '' : which;
      if (name === visual.card) return;
      visual.card = name;
      visual.uid = on === card ? cardText : on === fob ? fobText : '';
      ctx.invalidate();
    };
    const initial = (): string => (rawProps.present === 'card' || rawProps.present === 'fob' ? rawProps.present : 'none');

    const applyActive = (): void => {
      chip.power(powered && rst.read().level === 1);
      update();
    };
    const checkPower = (): void => {
      const v = vcc.read();
      const g = gnd.read();
      const on = supplied(v) && supplied(g);
      const volts = on ? v.volts - g.volts : 0;
      const high = on && volts > RC522_MAX_VOLTS;
      if (high !== over) {
        over = high;
        ctx.report({
          severity: 'error',
          code: 'rc522-overvoltage',
          message: high ? `The RC522's 3.3V pin is ${volts.toFixed(2)} V above GND; the MFRC522 takes ${RC522_MAX_VOLTS} V at most (2.5–3.6 V to run). Wire it to 3.3 V.` : '',
          parts: [],
        });
      }
      powered = on && !high && volts >= RC522_MIN_VOLTS;
      supplyVolts = powered ? v.volts : 0;
      // The board's pull-up on RST.
      if (powered) rst.driveVolts(v.volts, Strength.weak);
      else rst.release();
      applyActive();
    };
    vcc.onChange(checkPower);
    gnd.onChange(checkPower);
    rst.onChange(applyActive);
    place(initial());
    checkPower();

    return {
      input(event: PartInput) {
        if (event.kind === 'press') place('card');
        else if (event.kind === 'release') place('none');
        else if (event.kind === 'key' && event.down && (RC522_TAGS as readonly string[]).includes(event.key)) place(event.key);
      },
      visual: () => visual,
      reset() {
        powered = false;
        over = false;
        reportUid();
        chip.power(false);
        irqOut = -2;
        place(initial());
        checkPower();
      },
    };
  },
});
