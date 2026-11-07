/**
 * @benchtop/esp32s3 — the ESP32-S3 (BT124 onward): two LX7 cores on @benchtop/esp32's Xtensa core,
 * the S3's memory map, flash MMU, interrupt matrix and SYSTEM/EXTMEM/RTC/eFuse models, the C3's
 * new-generation peripheral models (@benchtop/esp32c3) at the S3's addresses, its pinned ROM, and
 * the direct boot of Arduino app images.
 */
export * from './boot/direct-boot.ts';
export * from './boot/rom.ts';
export * from './debug.ts';
export * from './rom-manifest.ts';
export * from './soc/bus.ts';
export * from './soc/gpio.ts';
export * from './soc/intmatrix.ts';
export * from './soc/memory.ts';
export * from './soc/periph.ts';
export * from './soc/rtc-cntl.ts';
export * from './soc/sens.ts';
export * from './soc/soc.ts';
export * from './soc/system.ts';
