/**
 * APB_CTRL (SYSCON, 0x60026000) on the ESP32-C3 (BT107): its registers read back as written
 * (RegisterFile), but for WDEV_RND_REG at +0xB0, the hardware random number generator, here a
 * deterministic xorshift32 as on the ESP32 (@benchtop/esp32's analog.ts Rng) so runs repeat.
 * esp_random reads it, and lwIP's DNS draws its source port from it until one is ≥ 1024: a
 * register that reads back the same value forever never gives one.
 */

import { RegisterFile } from './periph.ts';

export const APB_CTRL_BASE = 0x60026000;
/** WDEV_RND_REG (soc/wdev_reg.h: 0x600260B0). */
const RND = 0xb0;

export class ApbCtrl extends RegisterFile {
  private readonly seed: number;
  private state: number;

  constructor(seed = 0x2545f491) {
    super(APB_CTRL_BASE);
    this.seed = seed >>> 0 || 1;
    this.state = this.seed;
  }

  implements(offset: number): boolean {
    return offset === RND;
  }

  override read32(offset: number): number {
    if (offset !== RND) return super.read32(offset);
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
}
