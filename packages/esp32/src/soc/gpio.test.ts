import type { NetState } from '@benchtop/core';
import { describe, expect, it } from 'vitest';
import { createEsp32Mcu, type Esp32Mcu } from '../esp32.ts';
import type { SocProblem } from './periph.ts';

// BT34: pins from GPIO + IO_MUX + RTC IO, through the Mcu's McuPins, with register writes as the
// firmware's drivers make them (no firmware: the PRO bus writes directly).

const GPIO = 0x3ff44000;
const IO_MUX = 0x3ff49000;
const RTC_IO = 0x3ff48400;

function setup(): { mcu: Esp32Mcu; w: (a: number, v: number) => void; r: (a: number) => number; problems: SocProblem[]; changes: Map<string, number> } {
  const mcu = createEsp32Mcu(); // no ROM: pins and registers still work
  const problems: SocProblem[] = [];
  mcu.onProblem = (p) => problems.push(p);
  const changes = new Map<string, number>();
  for (const pin of mcu.pins.values()) pin.onOutputChange(() => changes.set(pin.id, (changes.get(pin.id) ?? 0) + 1));
  const bus = (): typeof mcu.soc.buses[0] => mcu.soc.buses[0];
  return { mcu, w: (a, v) => bus().write32(a, v), r: (a) => bus().read32(a) >>> 0, problems, changes };
}

const net = (level: 0 | 1 | null, volts: number): NetState => ({ level, strength: level === null ? 0 : 2, conflict: false, volts });
const ioMuxGpio = (_offset: number, extra = 0): number => (2 << 12) | (2 << 10) | extra; // MCU_SEL = GPIO, drive 2

describe('ESP32 pins (BT34)', () => {
  it('has a GPIO<n> pin for every GPIO the chip has', () => {
    const { mcu } = setup();
    expect([...mcu.pins.keys()]).toHaveLength(34);
    expect(mcu.pins.has('GPIO20')).toBe(false);
    expect(mcu.pins.has('GPIO39')).toBe(true);
    expect(mcu.kind).toBe('esp32');
    expect(mcu.clockHz).toBe(240e6);
  });

  it('drives an output through the matrix (FUNC_OUT_SEL = 256 → GPIO_OUT) and tells listeners', () => {
    const { mcu, w, changes } = setup();
    const pin = mcu.pins.get('GPIO2')!;
    w(IO_MUX + 0x40, ioMuxGpio(0x40)); // GPIO2 pad on the GPIO function
    w(GPIO + 0x530 + 2 * 4, 256 | (1 << 10));
    w(GPIO + 0x24, 1 << 2); // ENABLE_W1TS
    expect(pin.mode()).toBe('output');
    expect(pin.outputLevel()).toBe(0);
    const before = changes.get('GPIO2') ?? 0;
    w(GPIO + 0x08, 1 << 2); // OUT_W1TS
    expect(pin.outputLevel()).toBe(1);
    expect(changes.get('GPIO2')).toBe(before + 1);
    w(GPIO + 0x0c, 1 << 2); // OUT_W1TC
    expect(pin.outputLevel()).toBe(0);
    w(GPIO + 0x530 + 2 * 4, 256 | (1 << 9) | (1 << 10)); // INV_SEL
    expect(pin.outputLevel()).toBe(1);
  });

  it('drives a peripheral signal: U0TXD (signal 14) on GPIO1 through the matrix, and UART0 TX directly on IO_MUX function 0', () => {
    const { mcu, w } = setup();
    const tx = mcu.pins.get('GPIO1')!;
    expect(tx.mode()).toBe('peripheral'); // reset: U0TXD pad on function 0
    expect(tx.outputLevel()).toBe(1);
    const pin = mcu.pins.get('GPIO18')!;
    w(IO_MUX + 0x70, ioMuxGpio(0x70));
    w(GPIO + 0x530 + 18 * 4, 14); // U0TXD_OUT_IDX, output enable from the peripheral
    expect(pin.mode()).toBe('peripheral');
    expect(pin.outputLevel()).toBe(1);
  });

  it('reads inputs into GPIO_IN only while FUN_IE is set', () => {
    const { mcu, w, r } = setup();
    const pin = mcu.pins.get('GPIO18')!;
    w(IO_MUX + 0x70, ioMuxGpio(0x70)); // FUN_IE clear
    pin.setInput(net(1, 3.3));
    expect((r(GPIO + 0x3c) >>> 18) & 1).toBe(0);
    w(IO_MUX + 0x70, ioMuxGpio(0x70, 1 << 9)); // FUN_IE
    expect((r(GPIO + 0x3c) >>> 18) & 1).toBe(1);
    pin.setInput(net(0, 0));
    expect((r(GPIO + 0x3c) >>> 18) & 1).toBe(0);
    // Hysteresis: between VIL and VIH the level holds.
    pin.setInput(net(1, 1.5));
    expect((r(GPIO + 0x3c) >>> 18) & 1).toBe(0);
    pin.setInput(net(1, 3.3));
    pin.setInput(net(1, 1.5));
    expect((r(GPIO + 0x3c) >>> 18) & 1).toBe(1);
    // GPIO32–39 read through IN1.
    w(IO_MUX + 0x04, 1 << 9); // GPIO36 input enable
    mcu.pins.get('GPIO36')!.setInput(net(1, 3.3));
    expect((r(GPIO + 0x40) >>> 4) & 1).toBe(1);
  });

  it('maps IO_MUX FUN_PU/FUN_PD to input-pullup/input-pulldown, and RTC IO RUE/RDE on RTC pads', () => {
    const { mcu, w } = setup();
    const p18 = mcu.pins.get('GPIO18')!;
    w(IO_MUX + 0x70, ioMuxGpio(0x70, (1 << 9) | (1 << 8)));
    expect(p18.mode()).toBe('input-pullup');
    w(IO_MUX + 0x70, ioMuxGpio(0x70, (1 << 9) | (1 << 7)));
    expect(p18.mode()).toBe('input-pulldown');
    w(IO_MUX + 0x70, ioMuxGpio(0x70, 1 << 9));
    expect(p18.mode()).toBe('input');
    // GPIO4 is RTC pad TOUCH_PAD0 (RTC IO 0x94): reset pull-down (Table 6.10-1), RUE bit 27.
    const p4 = mcu.pins.get('GPIO4')!;
    expect(p4.mode()).toBe('input-pulldown');
    w(RTC_IO + 0x94, 1 << 27);
    expect(p4.mode()).toBe('input-pullup');
    expect(mcu.pins.get('GPIO0')!.mode()).toBe('input-pullup'); // reset pull-up
  });

  it('open drain (PINn PAD_DRIVER) drives 0 strong and releases a 1', () => {
    const { mcu, w } = setup();
    const pin = mcu.pins.get('GPIO21')!;
    w(IO_MUX + 0x7c, ioMuxGpio(0x7c, (1 << 9) | (1 << 8)));
    w(GPIO + 0x88 + 21 * 4, 1 << 2); // PAD_DRIVER
    w(GPIO + 0x24, 1 << 21);
    expect(pin.mode()).toBe('output');
    expect(pin.outputLevel()).toBe(0);
    w(GPIO + 0x08, 1 << 21);
    expect(pin.mode()).toBe('input-pullup');
  });

  it('refuses output on GPIO34–39 with a Problem, and reports RTC-routed pads as analog', () => {
    const { mcu, w, problems } = setup();
    w(IO_MUX + 0x14, ioMuxGpio(0x14)); // GPIO34
    w(GPIO + 0x30, 1 << 2); // ENABLE1_W1TS: GPIO34
    expect(mcu.pins.get('GPIO34')!.mode()).toBe('input');
    expect(problems.filter((p) => p.code === 'esp32-input-only-pin').map((p) => p.message)).toEqual([
      'GPIO34 is input-only (GPIO34–39 have no output driver): the firmware enabled its output; the pin stays an input.',
    ]);
    w(RTC_IO + 0x80, 1 << 29); // ADC_PAD: ADC1 (GPIO34) MUX_SEL
    expect(mcu.pins.get('GPIO34')!.mode()).toBe('analog');
    w(RTC_IO + 0x84, 1 << 17); // PAD_DAC1 (GPIO25) MUX_SEL
    expect(mcu.pins.get('GPIO25')!.mode()).toBe('analog');
  });

  it('raises a GPIO interrupt on the CPU its INT_ENA names (sources 22/23 are per CPU)', () => {
    const { mcu, w, r } = setup();
    const pin = mcu.pins.get('GPIO4')!;
    w(IO_MUX + 0x48, ioMuxGpio(0x48, 1 << 9));
    pin.setInput(net(1, 3.3));
    w(GPIO + 0x88 + 4 * 4, (2 << 7) | (1 << 13)); // falling edge, APP_CPU interrupt
    expect(r(GPIO + 0x44) & (1 << 4)).toBe(0);
    pin.setInput(net(0, 0));
    expect(r(GPIO + 0x44) & (1 << 4)).toBe(1 << 4); // STATUS
    expect(r(GPIO + 0x60) & (1 << 4)).toBe(1 << 4); // ACPU_INT
    expect(r(GPIO + 0x68)).toBe(0); // PCPU_INT
    expect([mcu.soc.matrix.cpuLines[0][22], mcu.soc.matrix.cpuLines[1][22]]).toEqual([0, 1]);
    expect(r(0x3ff000f8) & (1 << 22)).toBe(1 << 22); // APP_INTR_STATUS_0
    expect(r(0x3ff000ec) & (1 << 22)).toBe(0); // PRO_INTR_STATUS_0
    w(GPIO + 0x4c, 1 << 4); // STATUS_W1TC
    expect(mcu.soc.matrix.cpuLines[1][22]).toBe(0);
    // A low-level type stays pending while the level holds.
    w(GPIO + 0x88 + 4 * 4, (4 << 7) | (1 << 15)); // low level, PRO_CPU interrupt
    expect(r(GPIO + 0x68) & (1 << 4)).toBe(1 << 4);
    w(GPIO + 0x4c, 1 << 4);
    expect(r(GPIO + 0x68) & (1 << 4)).toBe(1 << 4);
  });

  it('reports a missing ROM, and runs nothing without one', () => {
    const { mcu, problems } = setup();
    expect(problems.find((p) => p.code === 'esp32-rom-missing')?.message).toMatch(/^ESP32 ROM not installed — run npm run fetch:esp32-rom/);
    expect(mcu.runUntil(1000)).toEqual({ reason: 'halted', detail: mcu.romProblem });
    expect(() => mcu.load({ format: 'hex', text: '' })).toThrow(/app images/);
  });
});
