/* core1 (BT80): 256 bytes where the second stage would be, core 0's vector table, core 1's (VTOR
   needs 256-byte alignment), then the code. */
MEMORY { FLASH (rx) : ORIGIN = 0x10000000, LENGTH = 2M  RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 256K }
SECTIONS {
  .boot2 0x10000000 : { BYTE(0); . = 0x100; } > FLASH
  .vectors 0x10000100 : { KEEP(*(.vectors)) } > FLASH
  .vectors1 0x10000200 : { KEEP(*(.vectors1)) } > FLASH
  .text : { *(.text*) *(.rodata*) } > FLASH
  .bss 0x20000000 (NOLOAD) : { *(.bss*) *(COMMON) } > RAM
  /DISCARD/ : { *(.ARM.attributes) *(.comment) *(.ARM.exidx*) *(.data*) }
}
ENTRY(start)
