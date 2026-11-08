import { describe, expect, it } from 'vitest';
import { createEsp32s3Mcu } from '../esp32s3-mcu.ts';
import { bootS3Fixture, s3FixtureImage } from '../test-support/boot.test-helper.ts';
import { loadCachedS3Rom } from '../test-support/rom.test-helper.ts';
import { S3_SRC } from './intmatrix.ts';
import { REF_HZ } from './rtc-cntl.ts';
import { Esp32s3Soc } from './soc.ts';
import { USB_ACK, USB_NAK, USB_STALL, type UsbDevicePort, UsbHost } from './usb-host.ts';
import { EPINT, GINT } from './usb-otg.ts';

// BT134: the S3's USB-OTG controller (DWC2, device, slave mode) as TinyUSB's dcd_esp32sx drives it,
// and the bench's host on its cable (enumeration, CDC-ACM).

const text = (bytes: Uint8Array, n: number): string => String.fromCharCode(...bytes.subarray(0, n));

describe('the USB-OTG controller on its own (BT134)', () => {
  function controller() {
    const soc = new Esp32s3Soc();
    const otg = soc.usbOtg;
    const regs = otg.blocks[0];
    const window = (n: number) => otg.blocks[1 + n];
    const line = () => (soc.matrix.status(0, S3_SRC.USB >>> 5) & (1 << (S3_SRC.USB & 31))) !== 0;
    return { soc, otg, w: (o: number, v: number) => regs.write32(o, v), r: (o: number) => regs.read32(o) >>> 0, window, line };
  }

  it('a bus reset and its end raise USBRST and ENUMDNE (full speed), through GAHBCFG’s global enable', () => {
    const { otg, w, r, line } = controller();
    w(0x018, GINT.USBRST | GINT.ENUMDNE);
    otg.busReset();
    expect(r(0x014) & GINT.USBRST).toBe(GINT.USBRST);
    expect(line()).toBe(false);
    w(0x008, 1);
    expect(line()).toBe(true);
    w(0x014, GINT.USBRST);
    expect(line()).toBe(false);
    otg.enumDone();
    expect(r(0x014) & GINT.ENUMDNE).toBe(GINT.ENUMDNE);
    expect((r(0x808) >>> 1) & 3).toBe(3);
    expect(r(0x010) >>> 31).toBe(1); // AHB idle
  });

  it('a SETUP lands in the RX FIFO (status 6 with 8 bytes, then status 4 whose pop raises STUP) and clears endpoint 0’s STALL', () => {
    const { otg, w, r, window } = controller();
    w(0x900, 1 << 21);
    otg.setup(new Uint8Array([0x80, 6, 0, 1, 0, 0, 64, 0]));
    expect(r(0x900) & (1 << 21)).toBe(0);
    expect(r(0x014) & GINT.RXFLVL).toBe(GINT.RXFLVL);
    const status = r(0x020);
    expect([(status >>> 17) & 0xf, (status >>> 4) & 0x7ff, status & 0xf]).toEqual([6, 8, 0]);
    expect([window(0).read32(0) >>> 0, window(0).read32(0) >>> 0]).toEqual([0x01000680, 0x00400000]);
    w(0x814, EPINT.STUP);
    w(0x81c, 1 << 16);
    expect(r(0x020) >>> 17).toBe(4);
    expect(r(0xb08) & EPINT.STUP).toBe(EPINT.STUP);
    expect(r(0x818)).toBe(1 << 16);
    expect(r(0x014) & (GINT.OEPINT | GINT.RXFLVL)).toBe(GINT.OEPINT);
  });

  it('an IN transfer: words fill packets of the max size, XFRSIZ counts what isn’t written, the host takes them, PKTCNT 0 raises XFRC', () => {
    const { otg, w, r, window } = controller();
    const into = new Uint8Array(64);
    w(0x920, (1 << 15) | (2 << 18) | (1 << 22) | 64); // bulk, FIFO 1, 64 bytes
    w(0x104, (32 << 16) | 68);
    w(0x930, (3 << 19) | 150);
    w(0x920, r(0x920) | (1 << 31) | (1 << 26));
    expect(otg.in(1, into)).toBe(USB_NAK);
    expect(r(0x928) & (EPINT.ITTXFE | EPINT.TXFE)).toBe(EPINT.ITTXFE | EPINT.TXFE);
    for (let i = 0; i < 16; i++) window(1).write32(0, 0x03020100 + i * 0x04040404);
    expect(r(0x930) & 0x7ffff).toBe(86);
    expect(r(0x928) & EPINT.TXFE).toBe(0);
    expect(r(0x938)).toBe(32 - 16);
    expect(otg.in(1, into)).toBe(64);
    expect([into[0], into[63]]).toEqual([0, 63]);
    for (let i = 0; i < 16; i++) window(1).write32(0, 0x01010101);
    for (let i = 0; i < 6; i++) window(1).write32(0, 0x02020202); // 22 bytes: the last word's high half is padding
    expect(r(0x930) & 0x7ffff).toBe(0);
    expect(otg.in(1, into)).toBe(64);
    expect(r(0x920) >>> 31).toBe(1);
    expect(otg.in(1, into)).toBe(22);
    expect(into[21]).toBe(2);
    expect((r(0x930) >>> 19) & 0x3ff).toBe(0);
    expect(r(0x920) >>> 31).toBe(0);
    expect(r(0x928) & EPINT.XFRC).toBe(EPINT.XFRC);
    // A zero-length packet: XFRSIZ 0, one packet.
    w(0x910, 1 << 19);
    w(0x900, r(0x900) | (1 << 31) | (1 << 26));
    expect(otg.in(0, into)).toBe(0);
    expect(r(0x908) & EPINT.XFRC).toBe(EPINT.XFRC);
    // STALL answers the token.
    w(0x920, r(0x920) | (1 << 21));
    expect(otg.in(1, into)).toBe(USB_STALL);
  });

  it('an OUT packet: NAKed until the endpoint is enabled without NAK; accepted, it ends the transfer (status 2 then 3, XFRC on the pop) and NAKs again', () => {
    const { otg, w, r, window } = controller();
    const data = new TextEncoder().encode('hello, usb');
    expect(otg.out(2, data, data.length)).toBe(USB_NAK);
    w(0xb50, (1 << 19) | 64);
    w(0xb40, (1 << 31) | (1 << 26) | (1 << 15) | (2 << 18) | 64);
    expect(otg.out(2, data, data.length)).toBe(USB_ACK);
    expect(r(0xb40) >>> 31).toBe(0);
    expect(r(0xb40) & (1 << 17)).toBe(1 << 17);
    expect(otg.out(2, data, data.length)).toBe(USB_NAK);
    const status = r(0x020);
    expect([(status >>> 17) & 0xf, (status >>> 4) & 0x7ff, status & 0xf]).toEqual([2, 10, 2]);
    const words = [window(3).read32(0), window(0).read32(0), window(5).read32(0)];
    const bytes = new Uint8Array(new Uint32Array(words).buffer);
    expect(text(bytes, 10)).toBe('hello, usb');
    expect(r(0xb48) & EPINT.XFRC).toBe(0);
    expect(r(0x020) >>> 17).toBe(3);
    expect(r(0xb48) & EPINT.XFRC).toBe(EPINT.XFRC);
    expect(r(0xb50) & 0x7ffff).toBe(54);
  });

  it('the host sees the device only with the PHY on the OTG side, pads on and D+ pulled up (soft connect)', () => {
    const { soc, otg, w } = controller();
    expect(otg.attached()).toBe(false);
    soc.rtc.write32(0x120, (1 << 20) | (1 << 19));
    soc.usbWrap.regs[0] = 1 << 18;
    w(0x804, 2); // soft disconnect
    expect(otg.attached()).toBe(false);
    w(0x804, 0);
    expect(otg.attached()).toBe(true);
    soc.usbWrap.regs[0] |= 1 << 2; // external PHY
    expect(otg.attached()).toBe(false);
  });
});

describe('the bench’s USB host against a scripted device (BT134)', () => {
  /** A full-speed composite device: CDC-ACM (interfaces 0 and 1) and a HID keyboard (interface 2). */
  class ScriptedDevice implements UsbDevicePort {
    readonly requests: string[] = [];
    readonly received: number[] = [];
    pending = new Uint8Array(0);
    sent = 0;
    status = false;
    bulkIn: number[] = [];
    resets = 0;
    readonly device = new Uint8Array([18, 1, 0x00, 0x02, 0xef, 0x02, 0x01, 64, 0x3a, 0x30, 0x02, 0x10, 0, 1, 0, 2, 0, 1]);
    readonly config = new Uint8Array([
      9, 2, 91, 0, 3, 1, 0, 0x80, 50,
      8, 11, 0, 2, 2, 2, 0, 0, // IAD
      9, 4, 0, 0, 1, 2, 2, 0, 0, // CDC comm
      5, 0x24, 0, 0x10, 0x01, 5, 0x24, 6, 0, 1, // header, union (0 → 1)
      7, 5, 0x81, 3, 8, 0, 16, // notify IN 1
      9, 4, 1, 0, 2, 0x0a, 0, 0, 0, // CDC data
      7, 5, 0x02, 2, 64, 0, 0, // bulk OUT 2
      7, 5, 0x82, 2, 64, 0, 0, // bulk IN 2
      9, 4, 2, 0, 1, 3, 1, 1, 0, // HID boot keyboard
      9, 0x21, 0x11, 0x01, 0, 1, 0x22, 63, 0,
      7, 5, 0x83, 3, 8, 0, 10,
    ]);
    attached(): boolean {
      return true;
    }
    busReset(): void {
      this.resets++;
    }
    enumDone(): void {}
    sof(): void {}
    setup(packet: Uint8Array): void {
      const value = packet[2] | (packet[3] << 8);
      const length = packet[6] | (packet[7] << 8);
      this.requests.push(`${packet[0].toString(16)} ${packet[1]} ${value.toString(16)} ${packet[4]} ${length}`);
      let reply = new Uint8Array(0);
      if (packet[1] === 6 && value >>> 8 === 1) reply = this.device;
      else if (packet[1] === 6 && value >>> 8 === 2) reply = this.config;
      else if (packet[1] === 6 && value === 0x0300) reply = new Uint8Array([4, 3, 0x09, 0x04]);
      else if (packet[1] === 6 && value === 0x0302) reply = new Uint8Array([10, 3, 0x50, 0, 0x61, 0, 0x64, 0, 0x21, 0]);
      this.pending = reply.slice(0, length);
      this.sent = 0;
    }
    in(ep: number, into: Uint8Array): number {
      if (ep === 0) {
        const n = Math.min(64, this.pending.length - this.sent);
        into.set(this.pending.subarray(this.sent, this.sent + n));
        this.sent += n;
        return n;
      }
      if (ep === 2 && this.bulkIn.length > 0) {
        const bytes = this.bulkIn.splice(0, 64);
        into.set(bytes);
        return bytes.length;
      }
      return USB_NAK;
    }
    out(ep: number, data: Uint8Array, length: number): number {
      if (ep === 2) this.received.push(...data.subarray(0, length));
      return USB_ACK;
    }
  }

  it('enumerates (descriptors, address, configuration), opens the CDC port (line coding, DTR/RTS), names the HID interface, and moves data both ways', () => {
    const device = new ScriptedDevice();
    const host = new UsbHost(device);
    const notes: string[] = [];
    let got = '';
    let opened = 0;
    host.onNote = (m) => notes.push(m);
    host.onData = (b, n) => (got += text(b, n));
    host.onOpen = () => opened++;
    for (let f = 0; f < 60; f++) {
      host.frame();
      for (let i = 0; i < 4; i++) host.service();
    }
    expect(device.resets).toBe(1);
    expect(device.requests).toEqual(['80 6 100 0 64', '0 5 1 0 0', '80 6 100 0 18', '80 6 200 0 9', '80 6 200 0 91', '80 6 300 0 255', '80 6 302 9 255', '0 9 1 0 0', '21 32 0 0 7', '21 34 3 0 0']);
    expect(host.isRunning).toBe(true);
    expect(host.productName).toBe('Pad!');
    expect(host.ports).toEqual([{ comm: 0, bulkIn: 2, bulkOut: 2, outSize: 64, notify: 1 }]);
    expect(opened).toBe(1);
    expect(notes).toEqual([`USB device "Pad!": its HID interface (2) enumerates, but the bench's USB host doesn't drive it`]);
    device.bulkIn.push(...new TextEncoder().encode('from the device'));
    host.service();
    expect(got).toBe('from the device');
    host.send(new TextEncoder().encode('x'.repeat(100)));
    host.service();
    expect(device.received.length).toBe(100);
  });
});

describe('USB-OTG builds on the S3 (BT134)', () => {
  it('usb-cdc (USB Mode "USB-OTG (TinyUSB)", CDC on boot): the host enumerates it, opens its port, and Serial talks both ways', () => {
    const { soc, uart } = bootS3Fixture('usb-cdc');
    let usb = '';
    const notes: string[] = [];
    soc.usbOtg.host.onData = (b, n) => (usb += text(b, n));
    soc.usbOtg.host.onNote = (m) => notes.push(m);
    const run = (ms: number) => {
      for (let i = 0; i < ms; i++) soc.runUntil(soc.now() + REF_HZ / 1000);
    };
    run(600);
    expect(uart[0]).toBe('uart0 here\r\n');
    expect(soc.usbOtg.host.productName).toBe('ESP32S3_DEV');
    expect(soc.usbOtg.host.ports.length).toBe(1);
    expect(usb).toBe('usb cdc up baud 115200\ntick 0\n');
    soc.usbOtg.send(new TextEncoder().encode('ping 42\n'));
    run(10);
    expect(usb.endsWith('echo ping 42\n')).toBe(true);
    expect(notes).toEqual([]);
    expect(soc.problems.problems.filter((p) => p.severity !== 'info')).toEqual([]);
  });

  it('through the Mcu: uart(0) carries the OTG port with UART0, and typed bytes go to the open port', () => {
    const mcu = createEsp32s3Mcu({ rom: loadCachedS3Rom() });
    mcu.load({ format: 'esp32-bin', ...s3FixtureImage('usb-cdc') });
    let out = '';
    mcu.uart(0)!.onTransmit((b) => (out += String.fromCharCode(b)));
    const run = (ms: number) => {
      const end = mcu.cycles + (ms * REF_HZ) / 1000;
      while (mcu.cycles < end) mcu.runUntil(Math.min(end, mcu.cycles + REF_HZ / 1000));
    };
    run(100);
    expect(out).toBe('uart0 here\r\nusb cdc up baud 115200\n');
    mcu.uart(0)!.receive(new TextEncoder().encode('abc\n'));
    run(10);
    expect(out.endsWith('echo abc\n')).toBe(true);
  });

  it('a build that never touches USB-OTG starts no frames; a Hardware CDC build’s port is still USB-Serial-JTAG', () => {
    const blink = bootS3Fixture('blink');
    for (let i = 0; i < 50; i++) blink.soc.runUntil(blink.soc.now() + REF_HZ / 1000);
    expect(blink.soc.usbOtg.active).toBe(false);
    const cdc = bootS3Fixture('cdc-hello');
    let usj = '';
    cdc.soc.usb.onTx = (b) => (usj += String.fromCharCode(b));
    for (let i = 0; i < 300 && !usj.includes('\n'); i++) cdc.soc.runUntil(cdc.soc.now() + REF_HZ / 1000);
    expect(usj.length).toBeGreaterThan(0);
    expect(cdc.soc.usbOtg.attached()).toBe(false);
  });
});
