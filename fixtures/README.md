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
fixtures/xtensa/<name>.S → <name>.bin, .lst   Xtensa test programs (harness.inc: conventions)
fixtures/xtensa/corpus/                       objdump decode corpora for the decoder tests (manifest.json)
fixtures/.build/                              arduino-cli and toolchain build folders (git-ignored)
```

## Building

```bash
npm run fixtures                         # build every sketch, rewrite the manifest
npm run fixtures -- --only uno/blink     # build one sketch, update its manifest entries
npm run fixtures -- --check              # rebuild into a temp dir, compare with the manifest
npm run fixtures -- --only xtensa/smoke  # one Xtensa test program
npm run fixtures -- --only xtensa/corpus # the decode corpora (needs serial-hello built first)
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
folders matter here too: `--check` proves the .bin is byte-identical across builds.

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

## Test specs

`specs/*.bench.json` are test specs for `npm run bench -- test`: each names a project
here, its firmware and expectations, paths relative to the spec. `specs/golden/` holds the
suite's JUnit XML (times zeroed) and Markdown reports; apps/cli/src/suite.test.ts compares a run
against them. After changing a spec or what its firmware prints, regenerate them with
`UPDATE_GOLDEN=1 npx vitest run apps/cli/src/suite.test.ts` and review the diff.

`specs/examples/<id>.bench.json` runs each gallery example with what its card claims;
`npm run verify` runs the whole `specs/` tree. A new example needs its spec (examples.test.ts
says so); a spec whose example is gone fails too.

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
