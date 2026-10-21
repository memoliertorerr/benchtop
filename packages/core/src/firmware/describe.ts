import type { FirmwareImage } from '../contracts/mcu.ts';

/** A firmware format as an error message names it ("got Intel HEX", "got a UF2"). */
export function describeFirmwareFormat(format: FirmwareImage['format']): string {
  switch (format) {
    case 'hex':
      return 'Intel HEX';
    case 'elf':
      return 'an ELF';
    case 'esp32-bin':
      return 'an ESP32 app image';
    case 'uf2':
      return 'a UF2';
    case 'micropython':
      return 'a MicroPython sketch';
  }
}
