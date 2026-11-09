/**
 * @benchtop/esp32s2 — the ESP32-S2 (BT148 onward): one Xtensa LX7 core on @benchtop/esp32's core,
 * its memory map, cache MMU and interrupt matrix, its own peripheral models and the ones it
 * shares with the ESP32, the C3 and the S3, the ROM manifest and direct boot. DOM-free.
 */
export * from './boot/direct-boot.ts';
export * from './boot/rom.ts';
export * from './debug.ts';
export * from './esp32s2-mcu.ts';
export * from './rom-manifest.ts';
export * from './soc/bus.ts';
export * from './soc/gpio.ts';
export * from './soc/intmatrix.ts';
export * from './soc/memory.ts';
export * from './soc/periph.ts';
export * from './soc/rtc-cntl.ts';
export * from './soc/soc.ts';
export * from './soc/system.ts';
export * from './soc/systimer.ts';
