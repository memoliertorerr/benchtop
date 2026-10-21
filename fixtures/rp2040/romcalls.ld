/* romcalls (BT60): 256 bytes where the second stage would be, then the vector table and code. */
MEMORY { FLASH (rx) : ORIGIN = 0x10000000, LENGTH = 2M  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
SECTIONS {
  .boot2 0x10000000 : { BYTE(0); . = 0x100; } > FLASH
  .vectors 0x10000100 : { KEEP(*(.vectors)) } > FLASH
  .text : { *(.text*) *(.rodata*) } > FLASH
  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.ARM.exidx*) }
}
ENTRY(start)
