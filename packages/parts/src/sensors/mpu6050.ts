/**
 * MPU-6050 accelerometer + gyroscope on I2C (InvenSense register map rev 4.2): 0x68, or 0x69
 * while the AD0 net reads 1 — `address` is a getter, read by the bus at every START. A 128-byte
 * register file with an auto-incrementing pointer (the first written byte sets it). WHO_AM_I
 * (0x75) is 0x68 whatever AD0 is; PWR_MGMT_1 (0x6B) resets to 0x40 (SLEEP) and writing bit 7
 * resets the device. Asleep, the data registers read 0. Awake, ACCEL 0x3B–0x40, TEMP 0x41–0x42
 * and GYRO 0x43–0x48 are big-endian int16 from the channels ax/ay/az (g), gx/gy/gz (°/s) and
 * temp (°C): accel LSB/g = 16384 >> AFS_SEL (0x1C bits 4:3), gyro LSB per °/s = 131, 65.5, 32.8,
 * 16.4 for FS_SEL (0x1B bits 4:3), TEMP = round((T − 36.53) × 340), saturating at int16. Props
 * hold the initial values (az = 1 g, temp = 24 °C, the rest 0). Pins from @wokwi/elements 1.9.2
 * mpu6050-element.
 */

import { type I2cDevice, type PartContext, type PartInput, type PinHandle } from '@benchtop/core';
import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';

const GYRO_LSB = [131, 65.5, 32.8, 16.4];
export const MPU_CHANNELS = ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'temp'] as const;
type Channel = (typeof MPU_CHANNELS)[number];

const int16 = (v: number): number => {
  const n = Math.round(v);
  return n > 32767 ? 32767 : n < -32768 ? -32768 : n;
};

export class Mpu6050 implements I2cDevice {
  readonly regs = new Uint8Array(128);
  readonly values: Record<Channel, number>;
  pointer = 0;
  private pointerNext = false;
  private readonly ad0: PinHandle | undefined;

  constructor(values: Record<Channel, number>, ad0?: PinHandle) {
    this.values = values;
    this.ad0 = ad0;
    this.reset();
  }

  get address(): number {
    return this.ad0?.read().level === 1 ? 0x69 : 0x68;
  }

  reset(): void {
    this.regs.fill(0);
    this.regs[0x6b] = 0x40;
    this.regs[0x75] = 0x68;
    this.pointer = 0;
  }

  start(read: boolean): boolean {
    this.pointerNext = !read;
    return true;
  }

  write(byte: number): boolean {
    if (this.pointerNext) {
      this.pointer = byte & 0x7f;
      this.pointerNext = false;
      return true;
    }
    if (this.pointer === 0x6b && byte & 0x80) this.reset();
    else if (this.pointer !== 0x75) this.regs[this.pointer] = byte;
    this.pointer = (this.pointer + 1) & 0x7f;
    return true;
  }

  read(): number {
    const value = this.register(this.pointer);
    this.pointer = (this.pointer + 1) & 0x7f;
    return value;
  }

  stop(): void {}

  /** A register's current value; data registers are computed from the channels. */
  register(r: number): number {
    if (r < 0x3b || r > 0x48) return this.regs[r];
    if (this.regs[0x6b] & 0x40) return 0;
    const word = this.word((r - 0x3b) >> 1);
    return r % 2 === 1 ? (word >> 8) & 0xff : word & 0xff;
  }

  /** Data word n: 0–2 accel x/y/z, 3 temperature, 4–6 gyro x/y/z. */
  private word(n: number): number {
    const v = this.values;
    if (n < 3) {
      const lsb = 16384 >> ((this.regs[0x1c] >> 3) & 3);
      return int16([v.ax, v.ay, v.az][n] * lsb);
    }
    if (n === 3) return int16((v.temp - 36.53) * 340);
    return int16([v.gx, v.gy, v.gz][n - 4] * GYRO_LSB[(this.regs[0x1b] >> 3) & 3]);
  }
}

function mpuModel(ctx: PartContext, props: Record<Channel, number>) {
  const values = { ...props };
  const mpu = new Mpu6050(values, ctx.pin('AD0'));
  ctx.attachI2c('SDA', 'SCL', mpu);
  return {
    input(event: PartInput) {
      const channel = readChannelInput(event);
      if (channel === null || !(MPU_CHANNELS as readonly string[]).includes(channel.channel)) return;
      values[channel.channel as Channel] = channel.value;
      ctx.invalidate();
    },
    visual: () => ({ ...values }),
    reset() {
      Object.assign(values, props);
      mpu.reset();
      ctx.invalidate();
    },
  };
}

export const mpu6050 = definePart({
  type: 'mpu6050',
  title: 'Accelerometer + gyro (MPU-6050)',
  category: 'sensors',
  size: { w: 21.6, h: 16.2 },
  pins: [
    { name: 'INT', x: 1.926, y: 1.529, role: 'digital' },
    { name: 'AD0', x: 4.471, y: 1.529, role: 'digital' },
    { name: 'XCL', x: 6.985, y: 1.529, role: 'nc' },
    { name: 'XDA', x: 9.525, y: 1.529, role: 'nc' },
    { name: 'SDA', x: 12.065, y: 1.529, role: 'digital' },
    { name: 'SCL', x: 14.605, y: 1.529, role: 'digital' },
    { name: 'GND', x: 17.145, y: 1.529, role: 'ground' },
    { name: 'VCC', x: 19.685, y: 1.529, role: 'power' },
  ],
  defaults: { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 24 },
  createModel: mpuModel,
});
