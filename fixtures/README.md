# Fixtures

Real firmware for the emulator tests, built by the real toolchain.

```
fixtures/sketches/<board>/<name>/<name>.ino   source; a header comment says what tests assert
fixtures/firmware/<board>/<name>.hex|.elf     compiled outputs, committed
fixtures/firmware/manifest.json               SHA-256 and size of every output, the SHA-256 of
                                              the sketch folder it was built from (`source`,
                                              sketchSourceSha256 in scripts/fixture-boards.ts —
                                              the examples gallery's test checks it), plus the
                                              arduino-cli, core and library versions
fixtures/firmware/<board>/<name>.addr2line.txt  for the sketches in ADDR2LINE_ORACLES
                                              (scripts/fixture-boards.ts): every FUNC symbol
                                              start and every 64th byte of .text resolved by
                                              the local avr-addr2line, "0x<addr> <file>:<line>"
                                              (the DWARF line-table tests' oracle)
fixtures/firmware/esp32/<name>.bin|.partitions.bin  ESP32 app image and partition table
fixtures/firmware/esp32/<name>.syms.tsv       `nm -S -n --defined-only` of the full ELF
                                              ("addr\tsize\ttype\tname"); the ELF itself (6 MB,
                                              mostly DWARF), .map and bootloader are never committed
fixtures/firmware/pico*/debug-demo.syms.tsv   the same for the Pico and Pico 2 debug-demos only (the
                                              debugger's tests; `SYMBOL_SKETCHES` in fixture-boards.ts)
fixtures/firmware/pico/<name>.uf2             Raspberry Pi Pico firmware (arduino-pico 6.2.0; the
                                              ELF, 1.3 MB of mostly DWARF, isn't committed;
                                              multicore runs setup1/loop1 on core 1)
fixtures/firmware/pico2/<name>.uf2            Raspberry Pi Pico 2 firmware for the RP2350's RISC-V
                                              cores (arduino-pico 6.2.0, arch=riscv; the Pico's
                                              analog-read, pwm-fade, i2c-oled, spi-tft, button-irq
                                              and neopixel rebuilt for it)
fixtures/rp2040/<name>.c, .ld → .elf, .lst    freestanding RP2040 test programs (romcalls: every bootrom
                                              function through the lookup tables; core1: both cores)
fixtures/xtensa/<name>.S → <name>.bin, .lst   Xtensa test programs (harness.inc: conventions)
fixtures/xtensa/corpus/                       objdump decode corpora for the decoder tests (manifest.json)
fixtures/riscv/programs/<name>.S → .bin, .lst RISC-V test programs (harness.inc: conventions)
fixtures/riscv/corpus/                        objdump disassembly corpora for the RISC-V decoder
                                              tests (manifest.json); ../corpus-text.c is the
                                              real-code corpus's source
fixtures/pcb/<name>.pcb.json                  PCB layouts laid out by hand on a fixture project
                                              (blink: fixtures/projects/blink-led.json on an Uno
                                              shield); golden/ holds their exports (Gerbers,
                                              drill, BOM, KiCad netlist and footprints), which the
                                              export tests compare byte for byte
                                              (UPDATE_GOLDEN=1 rewrites them)
fixtures/.build/                              arduino-cli and toolchain build folders (git-ignored)
```

## Building

```bash
npm run fixtures                         # build every sketch, rewrite the manifest
npm run fixtures -- --only uno/blink     # build one sketch, update its manifest entries
npm run fixtures -- --check              # rebuild into a temp dir, compare with the manifest
npm run fixtures -- --only pico/blink    # one Pico sketch
npm run fixtures -- --only rp2040/romcalls # one RP2040 test program
npm run fixtures -- --only xtensa/smoke  # one Xtensa test program
npm run fixtures -- --only xtensa/corpus # the decode corpora (needs serial-hello built first)
npm run fixtures -- --only riscv/traps   # one RISC-V test program
npm run fixtures -- --only riscv/corpus  # the RISC-V disassembly corpora
```

`scripts/build-fixtures.ts` finds `arduino-cli` in `$BENCHTOP_ARDUINO_CLI`, then on `PATH`,
then inside Arduino IDE 2.x (`/Applications/Arduino IDE.app/…/arduino-cli`). It uses only
what is installed locally (`arduino:avr` 1.8.7 for the Uno) and downloads nothing. The IDE's
built-in libraries (LiquidCrystal, Servo, Stepper, … in `~/Library/Arduino15/libraries`) are
passed to the CLI through `ARDUINO_DIRECTORIES_BUILTIN_LIBRARIES`, as the IDE does, so sketches
can include them. A first
build takes ~30 s per sketch; later builds hit arduino-cli's caches.

Board folders map to FQBNs in `scripts/fixture-boards.ts` (`uno` → `arduino:avr:uno`, `nano` →
`arduino:avr:nano` (.hex + .elf like the Uno), `mega` → `arduino:avr:mega` (the
ATmega2560; `far-code`'s .hex is ~370 KB: its 130 KB of tables push code past 128 KiB), `esp32` → `esp32:esp32:esp32`, core 2.0.17). An ESP32 sketch builds in ~35 s and its build folder takes
~25 MB. The app image embeds the ELF's SHA-256 (app descriptor, 0xb0–0xcf), so the fixed build
folders matter here too: `--check` proves the .bin is byte-identical across builds. `pico` →
`rp2040:rp2040:rpipico` (the arduino-pico core 6.2.0, installed with
`--additional-urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json`;
a sketch builds in ~15 s and keeps only its UF2). A Pico sketch with its own PIO program
(`neopixel`, `pio-square`) commits the `.pio` source beside the `<name>.pio.h` that
arduino-pico's `pioasm` 2.3.0 made from it (`~/Library/Arduino15/packages/rp2040/tools/pqt-pioasm/*/pioasm
<name>.pio <name>.pio.h`): arduino-cli doesn't run pioasm, so rerun it by hand when a .pio
changes. `pico2` → `rp2040:rp2040:rpipico2:arch=riscv` (the same core, the RP2350's
RISC-V cores; ~27 s a sketch).

## RP2040 test programs

`fixtures/rp2040/<name>.c` are freestanding programs (no SDK, no libc) linked by their own
`<name>.ld`: 256 bytes where the second stage would be, the vector table at 0x10000100 (where our
bootrom's direct boot looks), code in flash. `scripts/rp2040-programs.ts` builds them with the
arduino-pico core's `arm-none-eabi-gcc -mcpu=cortex-m0plus -mthumb -O1` (no debug info) and
`objdump -d`; the .c, .ld, .elf and .lst are committed. `romcalls` calls every bootrom function
through the ROM's lookup tables, as the SDK does, and leaves the results at 0x20030000. `core1`
resets core 1 through the PSM, launches it with the bootrom's FIFO protocol and checks CPUID, the
FIFOs, each core's SysTick, a TIMER interrupt on the core that enabled it, SEV/WFE, FIFO_ST's
flags and a second launch (its results at 0x20030000 too; the layout is in its header).

## MicroPython sketches

`fixtures/micropython/<name>/main.py` are MicroPython sketches for the Pico: nothing
builds them — the board's stock MicroPython (`npm run fetch:micropython`, never committed)
runs them as they are, so the sketch is the firmware. The tests, the examples gallery and the
specs (`--firmware pico=../../micropython/<name>/main.py`) load them directly. Each starts with a
comment saying what its tests assert.

## Xtensa test programs and decode corpora

`npm run fixtures` (a full run) also builds every `fixtures/xtensa/<name>.S` with the esp32
core's toolchain (`xtensa-esp32-elf-as --text-section-literals`, `ld -Ttext=0x40080000 -e
_start`, `+ -lgcc` when line 1 is `# link: libgcc`, `objcopy -O binary`, `objdump -d`) and
commits only the .S, .bin and .lst. `harness.inc` holds the conventions (code at 0x40080000,
scratch 0x3FFB0000, stack top 0x3FFC0000, end with `break 1, 15`, an event log for interrupt
and exception programs); `vectors.inc` places our own window, exception and interrupt
vectors at VECBASE 0x40080400 for windowed and handler-using programs; `break 1, 14` is a
checkpoint where a test may act (pulse the NMI). `romcall.S` and `fpu-libgcc.S` are
trampolines the tests drive call by call (arguments and the target in memory). GNU as rewrites code — it
narrows to density forms, widens for `loop` alignment, relaxes branches — so tests assert
against the .lst, and exact encodings go inside `.begin no-transform` / `.end no-transform`.

`scripts/xtensa-corpus.ts` writes `fixtures/xtensa/corpus/`: what objdump decodes for isa-all
(every mnemonic it knows, assembled from a generated `isa-all.S`), all 65,536 16-bit words,
one 24-bit word per (op0, op1, op2, r), and serial-hello's IRAM code (its .flash.text didn't
fit the 1.5 MB budget). Each is a `<name>.tsv.gz` ("address, bytes in memory order, mnemonic,
operands") plus raw bytes; `manifest.json` says how the bytes are laid out. Words are decoded in
labelled slots, because objdump restarts decoding at every symbol.

## RISC-V test programs and disassembly corpora

A full `npm run fixtures` also builds every `fixtures/riscv/programs/<name>.S` with the
arduino-pico core's RISC-V toolchain (`scripts/arduino-cli.ts` `findRiscvTool`:
`$BENCHTOP_RISCV_BIN` with `$BENCHTOP_RISCV_PREFIX`, else `pqt-gcc-riscv` under
`~/Library/Arduino15/packages/rp2040/tools`; binutils 2.43): `as` for the Hazard3 ISA
(`RISCV_MARCH` in scripts/riscv-corpus.ts), `ld -Ttext=0x80000000 --no-relax -e _start`,
`objcopy -O binary`, `objdump -d`; only the .S, .bin and .lst are committed. `harness.inc`
holds the conventions (code at 0x80000000, inputs at 0x80010000, outputs at 0x80020000 through
`OUTPUT`, the stack below 0x80040000, an MMIO page for console, exit and interrupt lines) and
`.insn` macros, from the specs' encoding tables, for what that assembler doesn't know
(Hazard3's h3.bextm/h3.bextmi, Zcmp's cm.mvsa01/cm.mva01s).

`scripts/riscv-corpus.ts` writes `fixtures/riscv/corpus/`: what that objdump prints, in its
`-M no-aliases` and default forms, for every 16-bit word (narrow16), 17,546 chosen 32-bit words
(wide32: random per 32-bit opcode and funct3, every funct7 of the register-register opcodes,
fences, system words, alias probes), `csrrs`/`csrrwi` on all 4,096 CSR numbers (csr), and the
.text of `corpus-text.c` built with Zb*/Zcb at -Os and linked with newlib and libgcc (text).
Words are emitted with `.insn` (a `.half`/`.word` would get a data mapping symbol, which
objdump dumps as data). Rows are "bytes[/length],
mnemonic, operands[, alias mnemonic, alias operands]" (gzipped TSV; a row's address is its
corpus's base plus the sizes before it); `manifest.json` records the objdump and the bases.

## Test specs

`specs/*.bench.json` are test specs for `npm run bench -- test`: each names a project
here, its firmware and expectations, paths relative to the spec. `specs/golden/` holds the
suite's JUnit XML (times zeroed) and Markdown reports; apps/cli/src/suite.test.ts compares a run
against them. After changing a spec or what its firmware prints, regenerate them with
`UPDATE_GOLDEN=1 npx vitest run apps/cli/src/suite.test.ts` and review the diff.

`specs/examples/<id>.bench.json` runs each gallery example with what its card claims;
`npm run verify` runs the whole `specs/` tree. A new example needs its spec (examples.test.ts
says so); a spec whose example is gone fails too.

`examples.json` is the gallery's list — id, title, category, project, each board's
firmware and sketch (or MicroPython folder), an optional PCB, the card's description. The web
app's examples manifest reads it, and so does the CLI's MCP server (`list_examples`,
`open_example`, `benchtop://examples/<id>`). A new example is an entry here plus its spec.

## Adding a sketch

1. Create `fixtures/sketches/<board>/<name>/<name>.ino` with a header comment saying exactly
   what a test asserts (pins, timing, serial text). Use only core and platform libraries, or
   libraries already in the sketchbook, so the fixtures build without extra downloads.
2. Run `npm run fixtures -- --only <board>/<name>`, then `npm run fixtures -- --check`.
3. Commit the sketch, its outputs and the manifest together.

## Why the outputs are committed

Tests (and CI later) must never need the toolchain: `scripts/fixtures.test.ts` only checks the
committed files against the manifest. The compiler runs only through `npm run fixtures`.

## Determinism

Each sketch builds in a fixed folder, `fixtures/.build/<board>/<name>`, so rebuilding gives
byte-identical outputs (`--check` proves it). The ELF's debug info embeds the absolute path of
that folder on the machine that built it (the checkout's absolute path), so a
build at another checkout path changes the ELF hashes (the HEX has no debug info).
