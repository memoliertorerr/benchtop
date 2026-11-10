/**
 * BT187: the DS18B20 1-Wire thermometer (`ds18b20`; Dallas/Maxim's datasheet), a TO-92 with legs
 * GND, DQ, VDD (flat face forward, as the transistors). DQ is open drain: the sensor pulls it low or
 * lets go, and a pull-up (4.7 kΩ to VDD, the datasheet's Figure 9) makes the 1 — without one the
 * line floats when released and the part reports `onewire-no-pullup` (warning).
 *
 * Signalling, from DQ's edges: a low of 240 µs or more is a reset (the master's is at least 480 µs;
 * a write slot is at most 120 µs — the threshold between is decided); 30 µs after its release the
 * sensor answers with a 120 µs presence pulse (the datasheet's 15–60 µs and 60–240 µs). A write
 * slot's bit is read from the master's low: released within 30 µs (the typical sampling point inside
 * the datasheet's 15–60 µs window) is a 1. In a read slot the sensor sends a 0 by holding the line
 * low for 25 µs from the master's falling edge, a 1 by leaving it. All data LSB first. Releases are
 * timers from pin listeners, so a RunSplitter keeps MCU runs at 200 µs while idle (a reset's 480 µs
 * then always outlasts the switch) and 10 µs from any falling edge until the bus has been quiet for
 * 2 ms. Several sensors on one line are each their own model; the line's wired-AND does the rest.
 *
 * ROM commands (Figure 5): 33h read ROM, 55h match ROM, F0h search ROM (each bit, its complement,
 * then the master's choice — a mismatch drops out until the next reset), ECh alarm search (the
 * same, only while the last conversion was above TH or below TL, comparing whole degrees — the
 * datasheet's rule), CCh skip ROM. The ROM code: family 28h, the 48-bit `serial` prop (12 hex
 * digits, printed MSB first as Linux names them: 28-<serial>) LSB first, and the CRC-8 (x⁸ + x⁵ +
 * x⁴ + 1) of those seven bytes. Function commands (Figure 10): 44h convert (93.75/187.5/375/750 ms at
 * 9–12 bits; read slots answer 0 while busy, 1 when done), 4Eh write scratchpad (TH, TL, config),
 * BEh read scratchpad (9 bytes, the CRC last, then 1s), 48h copy scratchpad to the EEPROM (10 ms
 * busy), B8h recall it, B4h read power supply (0 parasite-powered: VDD tied to GND, else 1).
 * Power-up: the temperature register at 85 °C (0550h), TH/TL/config from the EEPROM — TH 75, TL 70,
 * 12 bits — and the reserved bytes FFh 0Ch 10h (unspecified; the values commonly read). Powered
 * means GND grounded and VDD at 3 V or more over it (the datasheet's 3.0–5.5 V), or VDD on GND
 * (parasite power: a conversion's strong pull-up isn't checked).
 *
 * A conversion samples the temperature when it starts and rounds it to the resolution's step.
 * Temperature: the `temperature` prop (°C) at power-up, the `temperature` channel while running (a
 * slider), or the environment's field at the part. Visual: `temperature` (now), `reading` (the
 * temperature register in °C) and `converting`.
 */

import { NS_PER_MS, NS_PER_US, type NetState, type PartInput, type PartProps, Strength } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { RunSplitter } from '../shared/run-splitter.ts';

export const DS18B20_FAMILY = 0x28;
/** A low this long or longer is a reset. */
export const ONEWIRE_RESET_NS = 240 * NS_PER_US;
/** A write slot released sooner than this is a 1. */
export const ONEWIRE_SAMPLE_NS = 30 * NS_PER_US;
const PRESENCE_WAIT_NS = 30 * NS_PER_US;
const PRESENCE_NS = 120 * NS_PER_US;
const READ_HOLD_NS = 25 * NS_PER_US;
const IDLE_SPLIT_NS = 200 * NS_PER_US;
const BUSY_SPLIT_NS = 10 * NS_PER_US;
const QUIET_NS = 2 * NS_PER_MS;
/** Convert T's maximum time at 9, 10, 11 and 12 bits (Table 3). */
export const CONVERT_NS = [93.75 * NS_PER_MS, 187.5 * NS_PER_MS, 375 * NS_PER_MS, 750 * NS_PER_MS] as const;
const COPY_NS = 10 * NS_PER_MS;

/** Dallas/Maxim CRC-8 (x⁸ + x⁵ + x⁴ + 1, LSB first) of `bytes`. */
export function crc8(bytes: ArrayLike<number>, length = bytes.length): number {
  let crc = 0;
  for (let i = 0; i < length; i++) {
    let b = bytes[i] & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return crc;
}

/** The 8-byte ROM code for a 12-hex-digit serial (MSB first); a bad serial becomes 000000000001. */
export function romCode(serial: string): Uint8Array {
  const clean = /^[0-9a-fA-F]{12}$/.test(serial) ? serial : '000000000001';
  const rom = new Uint8Array(8);
  rom[0] = DS18B20_FAMILY;
  for (let i = 0; i < 6; i++) rom[1 + i] = parseInt(clean.slice(10 - 2 * i, 12 - 2 * i), 16);
  rom[7] = crc8(rom, 7);
  return rom;
}

/** FNV-1a over a string, 32 bits. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * A serial for a sensor placed with part id `id` (12 hex digits from two FNV-1a hashes of it): the
 * editor gives each new DS18B20 its own, so two on one line don't share a ROM code.
 */
export function ds18b20Serial(id: string): string {
  const hex = (v: number): string => (v & 0xffffff).toString(16).padStart(6, '0');
  return hex(fnv1a(`ds18b20:${id}`)) + hex(fnv1a(`${id}:ds18b20`));
}

/** The temperature register for °C at `bits` resolution (9–12): rounded to its step, −55…125 °C. */
export function temperatureRaw(celsius: number, bits: number): number {
  const t = Math.min(125, Math.max(-55, celsius));
  const step = 1 << (12 - bits);
  const raw = Math.round((t * 16) / step) * step;
  return raw & 0xffff;
}

/** The temperature register as °C. */
export function rawCelsius(raw: number): number {
  return ((raw << 16) >> 16) / 16;
}

/** Where a transaction is. Wait: dropped out or finished, until the next reset; SearchSend: a ROM
 * bit then its complement; SearchChoose: the master's choice; Busy: read slots answer the busy flag. */
const Step = {
  Wait: 0,
  RomCommand: 1,
  ReadRom: 2,
  MatchRom: 3,
  SearchSend: 4,
  SearchChoose: 5,
  FunctionCommand: 6,
  WriteScratchpad: 7,
  ReadScratchpad: 8,
  Busy: 9,
  Power: 10,
} as const;
type Step = (typeof Step)[keyof typeof Step];

/** What the low that just began is, decided at its falling edge. */
const SLOT_WRITE = 0;
const SLOT_READ = 1;
/** The sensor's own presence pulse, or a low during it. */
const SLOT_OWN = 2;

const clampT = (v: number): number => (v < -55 ? -55 : v > 125 ? 125 : v);

export const ds18b20 = definePart({
  type: 'ds18b20',
  title: 'DS18B20 temperature sensor',
  category: 'sensors',
  size: { w: 7.62, h: 10.2 },
  pins: [
    { name: 'GND', x: 1.27, y: 10.2, role: 'ground' },
    { name: 'DQ', x: 3.81, y: 10.2, role: 'digital' },
    { name: 'VDD', x: 6.35, y: 10.2, role: 'power' },
  ],
  defaults: { temperature: 22, serial: '000000000001' },
  createModel(ctx, props) {
    const p = props as PartProps;
    const dq = ctx.pin('DQ');
    const vdd = ctx.pin('VDD');
    const gnd = ctx.pin('GND');
    const splitter = new RunSplitter(ctx);
    const rom = romCode(String(p.serial));
    const scratch = new Uint8Array(9);
    const eeprom = new Uint8Array([0x4b, 0x46, 0x7f]);
    let temperature = clampT(Number(p.temperature));
    let powered = false;
    let parasite = false;
    let alarm = false;
    let step: Step = Step.Wait;
    /** Sending (read slots) or receiving (write slots). */
    let sending = false;
    let bitIndex = 0;
    let byte = 0;
    let byteIndex = 0;
    let searchPhase = 0;
    let busyUntil = 0;
    let convertTimer = -1;
    let pendingRaw = -1;
    let lowSince = -1;
    let lastEdge = 0;
    let fine = false;
    let floated = false;
    let presenceTimer = -1;
    /** From a reset's release until the presence pulse is over. */
    let inPresence = false;
    let slot = SLOT_WRITE;
    const visual = { temperature, reading: 85, converting: false };

    const fillScratch = (): void => {
      scratch[0] = 0x50;
      scratch[1] = 0x05;
      scratch[2] = eeprom[0];
      scratch[3] = eeprom[1];
      scratch[4] = eeprom[2];
      scratch[5] = 0xff;
      scratch[6] = 0x0c;
      scratch[7] = 0x10;
      scratch[8] = crc8(scratch, 8);
    };
    const resolution = (): number => 9 + ((scratch[4] >> 5) & 3);
    const finishConversion = (): void => {
      if (pendingRaw < 0) return;
      scratch[0] = pendingRaw & 0xff;
      scratch[1] = pendingRaw >> 8;
      scratch[8] = crc8(scratch, 8);
      const whole = (pendingRaw << 16) >> 20; // the temperature's whole degrees, signed
      const th = (scratch[2] << 24) >> 24;
      const tl = (scratch[3] << 24) >> 24;
      alarm = whole > th || whole < tl;
      visual.reading = rawCelsius(pendingRaw);
      visual.converting = false;
      pendingRaw = -1;
      ctx.invalidate();
    };
    const onConverted = (): void => {
      convertTimer = -1;
      finishConversion();
    };

    const hold = (): void => dq.drive(0, Strength.strong);
    const letGo = (): void => dq.release();
    const releaseRead = (): void => letGo();
    const presenceStart = (): void => {
      if (!powered) return;
      hold();
      presenceTimer = ctx.schedule(PRESENCE_NS, presenceEnd);
    };
    const presenceEnd = (): void => {
      letGo(); // its rising edge still belongs to the presence pulse
      presenceTimer = -1;
      inPresence = false;
    };
    const quietCheck = (): void => {
      // Back to the idle split once the bus has been high for QUIET_NS.
      if (!fine) return;
      if (lowSince < 0 && ctx.now() - lastEdge >= QUIET_NS) {
        fine = false;
        splitter.arm(IDLE_SPLIT_NS);
      } else ctx.schedule(QUIET_NS, quietCheck);
    };

    const startStep = (next: Step): void => {
      step = next;
      sending = next === Step.ReadRom || next === Step.SearchSend || next === Step.ReadScratchpad || next === Step.Busy || next === Step.Power;
      bitIndex = 0;
      byte = 0;
      byteIndex = 0;
      searchPhase = 0;
    };

    const romCommand = (command: number): void => {
      if (command === 0x33) startStep(Step.ReadRom);
      else if (command === 0x55) startStep(Step.MatchRom);
      else if (command === 0xcc) startStep(Step.FunctionCommand);
      else if (command === 0xf0 || (command === 0xec && alarm)) startStep(Step.SearchSend);
      else startStep(Step.Wait);
    };
    const functionCommand = (command: number): void => {
      if (command === 0x44) {
        if (pendingRaw < 0) {
          const bits = resolution();
          pendingRaw = temperatureRaw(temperature, bits);
          busyUntil = ctx.now() + CONVERT_NS[bits - 9];
          if (convertTimer >= 0) ctx.cancel(convertTimer);
          convertTimer = ctx.schedule(CONVERT_NS[bits - 9], onConverted);
          visual.converting = true;
          ctx.invalidate();
        }
        startStep(Step.Busy);
      } else if (command === 0x4e) startStep(Step.WriteScratchpad);
      else if (command === 0xbe) {
        if (pendingRaw >= 0 && ctx.now() >= busyUntil) finishConversion();
        startStep(Step.ReadScratchpad);
      } else if (command === 0x48) {
        eeprom[0] = scratch[2];
        eeprom[1] = scratch[3];
        eeprom[2] = scratch[4];
        busyUntil = Math.max(busyUntil, ctx.now() + COPY_NS);
        startStep(Step.Busy);
      } else if (command === 0xb8) {
        scratch[2] = eeprom[0];
        scratch[3] = eeprom[1];
        scratch[4] = eeprom[2];
        scratch[8] = crc8(scratch, 8);
        startStep(Step.Busy);
      } else if (command === 0xb4) startStep(Step.Power);
      else startStep(Step.Wait);
    };

    /** The master wrote `bit` (a write slot). */
    const received = (bit: number): void => {
      if (step === Step.MatchRom) {
        if (((rom[bitIndex >> 3] >> (bitIndex & 7)) & 1) !== bit) startStep(Step.Wait);
        else if (++bitIndex === 64) startStep(Step.FunctionCommand);
        return;
      }
      if (step === Step.SearchChoose) {
        if (((rom[bitIndex >> 3] >> (bitIndex & 7)) & 1) !== bit) startStep(Step.Wait);
        else if (++bitIndex === 64) startStep(Step.FunctionCommand);
        else {
          step = Step.SearchSend;
          sending = true;
          searchPhase = 0;
        }
        return;
      }
      if (step !== Step.RomCommand && step !== Step.FunctionCommand && step !== Step.WriteScratchpad) return;
      byte |= bit << bitIndex;
      if (++bitIndex < 8) return;
      const value = byte;
      bitIndex = 0;
      byte = 0;
      if (step === Step.RomCommand) romCommand(value);
      else if (step === Step.FunctionCommand) functionCommand(value);
      else {
        scratch[2 + byteIndex] = byteIndex === 2 ? (value & 0x60) | 0x1f : value;
        scratch[8] = crc8(scratch, 8);
        if (++byteIndex === 3) startStep(Step.Wait);
      }
    };

    /** A read slot began: the bit the sensor sends. */
    const nextBit = (): number => {
      switch (step) {
        case Step.ReadRom: {
          if (bitIndex >= 64) return 1;
          const bit = (rom[bitIndex >> 3] >> (bitIndex & 7)) & 1;
          if (++bitIndex === 64) startStep(Step.FunctionCommand);
          return bit;
        }
        case Step.SearchSend: {
          const bit = (rom[bitIndex >> 3] >> (bitIndex & 7)) & 1;
          if (searchPhase === 0) {
            searchPhase = 1;
            return bit;
          }
          step = Step.SearchChoose;
          sending = false;
          return bit ^ 1;
        }
        case Step.ReadScratchpad: {
          if (bitIndex >= 72) return 1;
          const bit = (scratch[bitIndex >> 3] >> (bitIndex & 7)) & 1;
          bitIndex++;
          return bit;
        }
        case Step.Busy:
          return ctx.now() < busyUntil ? 0 : 1;
        case Step.Power:
          return parasite ? 0 : 1;
        default:
          return 1;
      }
    };

    const checkPower = (): void => {
      const v = vdd.read();
      const g = gnd.read();
      const grounded = g.level === 0;
      const external = grounded && v.level === 1 && v.volts - g.volts >= 3;
      const viaDq = grounded && v.level === 0;
      const on = external || viaDq;
      parasite = viaDq;
      if (on === powered) return;
      powered = on;
      if (on) {
        fillScratch();
        startStep(Step.Wait);
        visual.reading = 85;
        visual.converting = false;
        pendingRaw = -1;
        alarm = false;
        splitter.arm(IDLE_SPLIT_NS);
      } else {
        splitter.disarm();
        letGo();
      }
      ctx.invalidate();
    };

    dq.onChange((s: NetState) => {
      if (!powered) return;
      if (s.level === null) {
        if (!floated) {
          floated = true;
          ctx.report({ severity: 'warning', code: 'onewire-no-pullup', message: 'The DS18B20’s DQ floats when released: add a pull-up (4.7 kΩ to VDD).', parts: [] });
        }
        return;
      }
      const now = ctx.now();
      if (s.level === 0) {
        if (lowSince >= 0) return;
        lowSince = now;
        lastEdge = now;
        if (!fine) {
          fine = true;
          splitter.arm(BUSY_SPLIT_NS);
          ctx.schedule(QUIET_NS, quietCheck);
        }
        slot = inPresence ? SLOT_OWN : sending ? SLOT_READ : SLOT_WRITE;
        // A read slot: the sensor answers a 0 by holding the line from the master's fall.
        if (slot === SLOT_READ && nextBit() === 0) {
          hold();
          ctx.schedule(READ_HOLD_NS, releaseRead);
        }
        return;
      }
      if (lowSince < 0) return;
      const width = now - lowSince;
      lowSince = -1;
      lastEdge = now;
      if (width >= ONEWIRE_RESET_NS) {
        if (presenceTimer >= 0) ctx.cancel(presenceTimer);
        startStep(Step.RomCommand);
        inPresence = true;
        presenceTimer = ctx.schedule(PRESENCE_WAIT_NS, presenceStart);
        return;
      }
      if (slot === SLOT_WRITE) received(width < ONEWIRE_SAMPLE_NS ? 1 : 0);
    });
    vdd.onChange(checkPower);
    gnd.onChange(checkPower);
    checkPower();

    return {
      input(event: PartInput) {
        const channel = readChannelInput(event);
        if (channel?.channel !== 'temperature') return;
        temperature = clampT(channel.value);
        visual.temperature = temperature;
        ctx.invalidate();
      },
      visual: () => visual,
      reset() {
        splitter.reset();
        temperature = clampT(Number(p.temperature));
        visual.temperature = temperature;
        powered = false;
        presenceTimer = -1;
        inPresence = false;
        convertTimer = -1;
        lowSince = -1;
        fine = false;
        floated = false;
        checkPower();
      },
    };
  },
});
