# Benchtop — architecture

How the pieces fit: what each piece is and why it is built that way. Sections marked
**(planned)** describe designs that are decided but not yet implemented — the code is the truth
for everything else.

## The one idea

**The simulation is a pure, DOM-free state machine that lives in a Web Worker; the UI is a
renderer for it.** Everything that has to be cycle-accurate — CPU cores, peripherals, nets,
part behavior — runs in the worker against one simulated clock. The UI thread draws parts and
wires, forwards user input (a button press, a potentiometer turn), and renders compact visual
state the worker reports about 60 times a second. That split is what keeps the CPU loop fast
(it never waits for rendering) and the UI smooth (it never waits for the CPU). Because the
simulation core has no DOM, the same code runs headless in Node for tests and CI.

```
 UI thread (apps/web)                         Simulation worker (packages/*)
 ┌──────────────────────────────┐   ToSim    ┌───────────────────────────────────┐
 │ editor: parts, wires, zoom   │ ─────────▶ │ Bench                              │
 │ part views (SVG elements)    │  edits,    │  ├─ Scheduler (one sim clock, ns)  │
 │ serial monitor, logic view   │  input,    │  ├─ MCUs: Uno (avr8js), ESP32      │
 │ inspector, palette           │  run/pause │  ├─ Netlist + signal resolution    │
 └──────────────────────────────┘ ◀───────── │  └─ Part models (LED, LCD, servo…) │
                                    FromSim  └───────────────────────────────────┘
                                    frames, serial bytes, stats
```

## Packages

| Package | Owns | Must not |
|---|---|---|
| `@benchtop/core` | time units, scheduler, netlist, signal resolution, the analog layer, the environment world, the virtual network, the `PartDefinition` / `PartModel` / `Mcu` contracts, the project document schema | import any other `@benchtop/*` package; touch DOM or Node APIs |
| `@benchtop/avr` | the Uno `Mcu`: ATmega328P peripherals via avr8js, Uno pin map, Intel HEX and ELF loading | know about parts or the UI |
| `@benchtop/esp32` | the ESP32 `Mcu` (`createEsp32Mcu`, `esp32McuFactory`): Xtensa LX6 core, SoC (memory map, peripherals, two cores, pins), direct boot, boot debugging | know about parts or the UI |
| `@benchtop/parts` | the part catalog: pin layouts, internal buses (breadboards), metadata, behavior models | touch DOM — views live in `apps/web` |
| `@benchtop/rp2040` | the RP2040 `Mcu` (`createRp2040Mcu`, `rp2040McuFactory`) over rp2040js: the clean-room bootrom, UF2/ELF loading, pins, UARTs, USB serial, I2C/SPI controllers | know about parts or the UI |
| `@benchtop/riscv` | the RISC-V RV32 core (Hazard3 profile: the RP2350's): decoder, objdump-exact disassembler, predecode cache, machine and user modes, the CSR hook a SoC plugs into | know about a SoC, parts or the UI |
| `@benchtop/rp2350` | the RP2350 SoC (RISC-V side) on `@benchtop/riscv` with the real bootrom: memory map, Xh3irq, peripherals, QMI and flash, the `Mcu` (`createRp2350Mcu`, `rp2350McuFactory`) | know about parts or the UI |
| `@benchtop/esp32c3` | the ESP32-C3 `Mcu` (`createEsp32c3Mcu`, `esp32c3McuFactory`): the SoC on `@benchtop/riscv` with its mask ROM — memory map, flash MMU, interrupt matrix, peripherals, direct boot, the debugger view | know about parts or the UI |
| `@benchtop/esp32s3` | the ESP32-S3 `Mcu` (`createEsp32s3Mcu`, `esp32s3McuFactory`): the SoC — two LX7 cores on `@benchtop/esp32`'s Xtensa core with the C3's peripheral models at the S3's addresses — memory map, flash MMU, interrupt matrix, SYSTEM/EXTMEM/RTC, direct boot, GPIO/IO_MUX over 49 pads, USB-Serial-JTAG, LEDC, the ADC through SENS, I2C ×2, SPI2, RMT, the debugger view | know about parts or the UI |
| `@benchtop/esp32s2` | the ESP32-S2 `Mcu` (`createEsp32s2Mcu`, `esp32s2McuFactory`): the SoC — one LX7 core on `@benchtop/esp32`'s Xtensa core (its S2 set), the peripheral models it shares with the ESP32, the C3 and the S3 and its own (SYSTEM, EXTMEM, RTC_CNTL, eFuse, SYSTIMER), the cache MMU's six windows, the interrupt matrix, direct boot, GPIO, LEDC, the ADC, I2C, SPI2, RMT, USB-OTG, the debugger view | know about parts or the UI |
| `@benchtop/pcb` | the PCB document, footprints, nets from the bench, ratsnest, DRC, fabrication exports | touch DOM; run simulation |
| `@benchtop/web` | the editor, part views, the worker host and the worker entry | run CPU emulation on the UI thread |
| `@benchtop/bridge` | the local compile bridge: runs arduino-cli for the browser (Node, zero dependencies) | listen beyond loopback; write outside its temp build folders |
| `@benchtop/cli` | the headless runner: a project and firmware files, scripted inputs, assertions, a JSON report (Node) | import anything from `apps/web` |

## Simulation model

The contracts every package builds on live in `packages/core/src/contracts/` and are
frozen: changing one is a deliberate, reviewed decision. Below them sit the netlist
(`netlist/`), the signal resolver (`signals/`) and the bench (`bench/`), all in
`packages/core/src/`.

### Time and the Bench

One simulated clock in nanoseconds (`Nanos`, a float64). Each MCU keeps its own cycle counter
and converts with `cyclesToNanos` / `nanosToCycles`; an MCU's `clockHz` never changes (an ESP32
counts a fixed reference clock).

`Bench` (`packages/core/src/bench/bench.ts`) owns one circuit: it builds the netlist, the
resolver (with each definition's links mapped to nets), the MCUs for board parts and the part
models, all from a `ProjectDoc` plus a `BenchEnv` the caller injects (part definitions and an
MCU factory — core never imports the catalog or an MCU package). `createMcu(board, partId,
report)` also gets a function that puts a Problem on that board part: the ESP32 adapter's
own Problems — unknown registers, reboots, a missing ROM — have no channel in the `Mcu`
contract. It also gets the board part's props over its type's defaults — `BenchEnv` is
bench.ts's, not a contract — so a board's `module` prop reaches the MCU factory; a carried
rebuild keeps a board's MCU only while its props are unchanged. `runUntil(t)` repeats:
tNext = min(next timer, end of the current quantum, t); run every MCU to `nanosToCycles(tNext)`;
fire the timers due at tNext. Quanta are aligned to multiples of the quantum: 1 ms with one MCU,
100 µs with several (`BenchOptions.quantum` overrides). While an MCU runs, `ctx.now()` is that
MCU's current cycle time and its pin changes reach part listeners synchronously, so a part on
its own board's pins (an LCD, a NeoPixel strip) decodes cycle-exact edge times. Between two MCUs
latency is at most one quantum. A timer that a part schedules from inside an MCU run fires
when that run returns, so it can be up to one quantum late (a known limitation).

Boards talking over a UART. `UartPort` has two optional methods (an additive
contract change): `pins()` — the McuPin ids of TX and RX now (the Uno: PD1
while the transmitter is enabled, PD0 while the receiver is; the ESP32: wherever IO_MUX or the
GPIO matrix routes UnTXD/UnRXD, so `Serial2.begin(…, 16, 17)` moves them) — and `baud()`. Every
byte a UART transmits goes to every UART on the bench whose RX pin shares the TX pin's net or
sits one resistor away (a series resistor; a 5 V → 3.3 V divider, which the analog layer turns
into 3.33 V at the ESP32), handed over through the scheduler at the time the sender reported
it: causal, at most one quantum late. It stays byte level, like each MCU's own UART: the
receiver frames the byte at its own baud. avr8js reports a byte as its frame starts, so an Uno's
byte reaches the other FIFO one frame later, as on a wire; the ESP32 model reports at the stop
bit, so its bytes arrive one frame late (delivering them 10 bit-times after the report would
count the frame twice, since the receivers frame bytes themselves). Rates more than 3 %
apart are a `uart-baud-mismatch` warning, the bytes still arrive. A 5 V output on a net with an
ESP32 pin is the `esp32-overvoltage` error ("5 V on an ESP32 pin"). Measured (M1): an Uno
pinging an ESP32 relay every 100 ms runs 1 s simulated in 1.47 s wall (68 % of real time,
100 µs quanta).

Timers live in `Scheduler` (`bench/scheduler.ts`): a binary min-heap over preallocated
parallel arrays, FIFO for equal times, lazy cancellation with generation-checked ids.
`RealtimePacer` (`bench/pacer.ts`) turns wall time into a simulated-time target (speed ×
elapsed wall time, forgiving more than 100 ms of debt so a suspended tab doesn't race to catch
up; speed Infinity means "run the caller's whole budget") and reports the real-time ratio over
the last second.

The bench's other duties: `attachFirmware(board, image)` (load + reset that MCU, its clock
restarts at bench time), `reset()` (time 0, timers dropped, MCUs and models reset), `input`,
`onSerial` (UART 0 bytes batched per quantum) and `sendSerial`, `collectFrame()` (visual state
of the parts that called `invalidate()` since the last frame), `pinState(part, pin)` and
`problems()`. After build and after reset every MCU pin and part listener gets its net's state
once. Bus devices that parts register with `attachI2c`/`attachSpi` are attached after build to
the MCU controller whose current pins share their nets; SPI `selected()` reads the CS net (low =
selected).

**SPI buses and chains.** The bench gives each SPI controller one device, its bus
(`SpiBus` in bench.ts), and puts the parts' devices on it: every selected device gets each byte
(the AVR adapter used to stop at the first selected one, which a 74HC595 — always listening, its
GND as its select — would starve), and the answer is the last byte from a selected device whose
MISO is on the controller's MISO, 0xFF with none, so a write-only device never answers for the
bus. A device whose MOSI net is the MISO net of a chain's last device, on the same SCK, joins that
daisy chain (`attachSpiDevices`): each member gets what the one before it shifted out, and the
chain answers MISO when a member's MISO is on it. A device's MISO counts as unwired for the
controller when only chained devices' MOSI pins share its net. Rebinds and carries rebuild the
buses. A read-only device (a 74HC165) whose MOSI is unwired or on a rail attaches by SCK and
its MISO — on the controller's, or feeding the next device of a chain (the far 165 is the head). The AVR adapter now honours DORD: an LSB-first byte reaches the devices bit-reversed, in
wire order, as the ESP32's controller already gave it.

**The bus log (`packages/core/src/bus-log/`).** Every I2C and SPI device is attached to its
controller through a logging proxy the bench makes once per attachment (`LoggedI2c`,
`LoggedSpi`): each call — I2C start/write/read/stop with its ACK, SPI transfer with MOSI and
MISO — is recorded with `now()` (the MCU's own cycle time) and forwarded; an SPI device's
chip-select edges come from a listener on its CS net; every byte a board's UART sends, or is
handed (`sendSerial`, the other board's UART), is recorded per port and direction. `BusLog` is
one preallocated ring of 65,536 records (time, kind, source, two values — no allocation per
record; the oldest are overwritten and counted), plus a table of sources ("lcd1 (I2C 0x27)",
"uno Serial TX", each with its board and, for a UART, its baud). `bench.busLog()` exposes it; a
rebuilt bench starts a new one. `BusDecoder` turns records into transactions incrementally —
I2C from START to STOP (a repeated START splits; address, R/W, bytes, ACKs), SPI from CS fall
to rise (transfers outside a frame group by 100 µs gaps), UART bursts split at two byte-times
of silence — keeping 4,096 bytes of each and counting the rest; `describeTransaction` prints one
line. Only traffic that reaches an attached device is seen: an address nobody answers (an I2C
scan's NACKs) and SPI with nothing selected aren't, since the controllers have no observer hook
(contracts/bus.ts). Tested on FakeMcu buses and on real firmware: the Uno's I2C LCD (one-byte
PCF8574 writes at 0x27), an SSD1306 frame in AVR Wire's 32-byte chunks, the ILI9341's commands
over SPI, the ESP32's OLED and the Pico's TFT.

**Rebuilds that carry over.** `bench.carry()` ends a bench and hands the next one
(`new Bench(doc, env, { carry })`, `assembleBench(…, { carry })`) its time, its `Scheduler` and
its MCUs and part models — the next bench decides what it keeps. A board whose part id, MCU kind
and firmware ref (`firmwareKey`: an inline sketch by its FQBN) are unchanged keeps its MCU
running: not loaded, not reset, its time base unchanged; a new board starts from reset at the
carried time, as a firmware swap does (`BenchOptions.restart` forces that for boards getting new
firmware under an unchanged ref). A part whose id, type, document props (`propsKey`), logic
supply and analog role are unchanged keeps its model. Neither contract has a way to re-bind, so
the bench does it underneath them: `McuPin.onOutputChange` and `UartPort.onTransmit` have no
unsubscribe, so each MCU's listeners are registered once on a port that routes to whichever
bench and slot run it now (`report` too); a part's context, `PinHandle`s (`BenchPin`) and
`LinkHandle`s (`BenchLink`) go through a binding with re-pointable fields, so a kept model's
handles — taken once in `createModel` — follow it: listeners are filed on the new nets, the last
drive and link setting are re-applied, its I2C/SPI devices re-attach (the old bench detaches
every device from the controllers when it carries). Scheduler entries carry an owner tag (0:
the bench's own ticks and UART bytes in flight; else a part binding): the new bench cancels the
old bench's and the dropped parts' timers, so a kept model's timer ids stay valid and fire on
time. The netlist, resolver, analog layer, checks and environment are built fresh (the
environment's world restarts at the carried time). While a carried bench builds, net changes
reach nobody (`quiet`); when it has settled, every MCU pin and listener sees its net's state
once — a kept MCU sees the edit, not the transient states of the build. No contract changed:
`PartModel.dispose` (now also for a dropped model on a rebuild) and "get handles once, in
`createModel`" already described it. Tests: `bench/carry.test.ts` (FakeMcu: time, a model
following its pin to another net, timers kept, dropped and new, drives and links re-applied, no
glitch on a kept MCU's input, I2C re-attachment, new and re-flashed boards) and
`packages/parts/src/integration/hot-swap.test.ts` (an Uno's I2C LCD keeps its text and
`millis()` keeps counting with no second boot; an LED added to a running blink follows the
sketch's schedule; a Pico and an ESP32 keep blinking on their own schedules across an edit).

Problem codes the bench emits today: `unknown-part-type`, `unresolved-wire`,
`bad-part-definition`, `mcu-unavailable`, `part-model-error`, `i2c-unattached`,
`spi-unattached` (info), `environment-duplicate` — fixed at build; `short` and `oscillation` — live, from the resolver;
`mcu-fault` / `mcu-halted` / `mcu-breakpoint` — while an MCU is stopped; `timer-storm`; plus
whatever parts `report()` (kept until reset, newest message per code and part set).

Test helpers for other packages are in `@benchtop/core/testing` (`packages/core/src/testing.ts`):
`FakeMcu` (scripted pin changes, UART bytes and stops on a cycle schedule), `fakeBoard`,
`makeBenchEnv` and `testDoc`. Production code never imports it.

Run modes: **real time** (throttled to wall clock), **max speed** (as fast as the host allows,
for tests), and **step** (one instruction or one quantum) — the worker session drives
them through the pacer.

### Nets and signals: switch-level resolution

The value types are `Strength` (`hiz < weak < strong < supply`, numeric so they fit typed
arrays), `Level` and `NetState { level, strength, conflict, volts }` in
`packages/core/src/contracts/signal.ts`. `SignalResolver` (`packages/core/src/signals/resolver.ts`)
computes them.

A **net** is a set of pins that are electrically one node. `buildNetlist(doc, source)`
(`packages/core/src/netlist/netlist.ts`) builds it with union-find from wires plus each part's
internal **buses** (a breadboard's 5-hole strips and power rails, a board's duplicated GND
pins). The caller supplies pin names and buses per part type through `PartPinsSource`, so core
never imports the catalog. Every (part, pin) gets a dense index; nets are numbered
0..netCount-1 in order of their lowest pin index (the same document always gives the same ids);
net → pins is stored in CSR form. When the source gives part geometry, **contacts** join too:
any two pins of different parts within 0.4 mm of each other (`netlist/contacts.ts`, a spatial
hash on the 2.54 mm grid) — a leg pressed into a breadboard hole needs no wire. Pin positions
use the rotation rule in `packages/core/src/geometry.ts`, shared with the editor, so the legs
the editor shows in holes are the ones the bench connects. Links (resistors, switches) are
**not** unions — they join nets only through the resolver. Wire ends naming an unknown part or pin are listed in
`unresolved` and unknown part types in `unknownParts`, never thrown; the bench turns them into
Problems. The netlist is rebuilt from scratch on every topology edit: 2,000 parts with 4 pins
each plus 4,000 wires build in about 4–10 ms in Node.

Each pin that touches a net contributes a **driver** with a strength:

| Strength | Examples |
|---|---|
| `supply` | 5V, 3V3, GND pins |
| `strong` | an MCU output pin, a pressed button bridging to a supply |
| `weak` | a pull-up/pull-down (internal or resistor) |
| `hiz` | an input pin, an unconnected output |

Resolution picks the highest strength present. Opposite levels both at `strong` or above are
a **conflict** (a short) — reported in the Problems panel, never silently resolved; the level
is the strictly stronger side's, or null when they tie. Opposite levels tied at `weak` (a
divider) are not a conflict: the level is null and the volts are the average.
**Resistors are links that lower strength**: whatever drives one end reaches the other end as
`weak`. That one rule makes pull-up buttons, LEDs behind current-limiting resistors and
voltage-free logic all behave correctly without an analog solver. Switches and buttons are
links that pass strength unchanged while closed. Digital drivers carry 0 V or their supply
voltage, `driveVolts` drivers their own value; links pass volts along with the level.

On the bench, drivers come from three places: every pin whose `PinDef.volts` is defined drives
its net at `supply` (level 1 when volts > 0); every board header pin in `BoardSpec.pinMap` has
one driver that follows its `McuPin` (output/peripheral → strong `outputLevel()`,
input-pullup → weak 1, input-pulldown → weak 0, input/analog → released) at the MCU's logic
supply (ATmega328P 5 V, ESP32 3.3 V); and a part's pin gets a driver on its first `drive`, at
the voltage on the part's first consumer power pin (5 V if that isn't powered). Each net change
calls `setInput` on the MCU pins on that net and every part listener on it.

How the resolver computes it: drivers live in typed arrays, with per-net counts by strength and
level. A net with no conducting link resolves in O(1) from those counts. Otherwise its whole
link-connected component is re-resolved from the drivers, strongest first (supply, strong,
weak): a net first reached at a strength is settled there and passes on only what it resolved
to, so a weaker signal never overrides it and a cycle of links never feeds a level back to
itself (no ghost levels after a source goes away). `onChange(net)` fires once per actual
change, after the whole component holds its new state. A listener may drive pins
re-entrantly; the change is queued and applied right after. A zero-delay feedback loop through
listeners is cut off after 4 × (nets + links + 1) recomputations and reported through
`oscillations()`. Measured: 1,000,000 driver toggles through a resistor with 3 listeners take
about 0.3 s in Node (~3.5 M events/s).

**Analog layer** (`packages/core/src/analog/`; `BenchOptions.analog`, default on). An
*island* is a connected component over resistive links, switch links and diodes, rebuilt with
the bench (on topology change). Supply-driven nets are fixed voltages and end an island rather
than join two; a switch stays in its island open or closed (open = absent, closed = 1 mΩ), so
toggling it never changes the structure. Only components with at least one resistor or diode
are islands; every other net is digital-only and resolves exactly as before. Sources: supply
nets fixed; strong drivers Norton with 25 Ω; weak drivers carry their own resistance (MCU
pull-ups: 35 kΩ ATmega328P, 45 kΩ ESP32; other weak drivers 10 kΩ). Diodes (from
`analogSpecFor`, the LED types in `@benchtop/parts`) are piecewise linear: off below Vf (a 1 GΩ
leak, `GOFF`, so a node reached only through off diodes — an LED's cathode on an input pin, the
node between two LEDs in series — follows its neighbors instead of sitting at 0 V),
then (Vd − Vf)/10 Ω, iterated from the last solution for at most 20 rounds
(`analog-no-convergence`); an on diode that carries no current turns off (so a released MCU
pin behind an LED floats instead of sticking at Vf), and a bench reset clears diode states. The resolver resolves an island net at switch level first, then the
layer solves the island (Gaussian elimination with partial pivoting over a dense matrix,
preallocated for 256 unknowns, updating only each pivot row's nonzero columns; an island's nets
get solver indices fewest-neighbors first, so stars and ladders eliminate without fill-in — a pin
driving 100 LED branches is a 101-node star solved in ~0.1 ms; more than 256 →
`analog-island-too-large`, switch level kept) and publishes: the solved volts;
the level from the reading MCU's thresholds (≥ 0.6·Vcc → 1, ≤ 0.3·Vcc → 0, between → the
previous level, with `analog-undefined-level` once per run when a pin in a digital input mode
reads it during a run); the switch-level strength; conflict false. Nets with no conducting path
to a source keep their switch-level level and strength, with the volts the solve gives them (0 V
through gmin, or a neighbor's through `GOFF`; only they get gmin, so other solved voltages are exact),
and islands with a short are left at switch level. Solving is synchronous and only when an
island's input changes (a driver on one of its nets, a link opening or closing, `setOhms`).
Purely resistive outputs (pots, joystick axes, LDR/NTC modules) are resistive links set by
`setOhms`; amplifier outputs (sound sensor) stay sources. LED-type models read their currents
from the solved volts (brightness √(Iavg / 15 mA), `led-overcurrent` above 30 mA) when the
bench marks them analog (the runtime `$analog` prop). In an island left at switch level (too
large) their pins read switch-level volts — 5 V straight across an LED — so the bench drops
their `led-overcurrent` reports. Measured: 3-node islands ~450k solves/s, 16-node ~190k,
64-node ~39k, 256-node ladder ~2.5k, the 101-node star ~10k; Blink's simulated MHz is unchanged
(−0.3 %).

**Capacitors.** `AnalogSpec.capacitors` (`{ a, b, farads }`) join their nets into an
island as resistors do (one across two fixed nets is nothing). An island with capacitors keeps
transient state — each capacitor's voltage and current and the time they hold for — and steps in
time: the trapezoidal rule (companion G = 2C/h, I = G·v + i), with backward Euler (G = C/h) for the
first step after an input change (the trapezoidal rule rings on a jump; that step is h/10, since
backward Euler's error grows with h²) and for any step longer than the island's shortest time
constant τ (L-stable). τ is estimated per capacitor as C over the conductance the rest of the
island puts at its ends (the assembled matrix's diagonal, before the capacitors). An input change
at time t first advances the island to t on the inputs it was last solved with (the layer keeps
them: drivers per net, link states and ohms), then solves the instant after it on the new ones (a
1 ns backward-Euler step: capacitor voltages are continuous) and plans the next step: h = τ/5,
doubling after a step that moves no capacitor by more than 2 mV (up to 10 ms); a step that moves
none by more than 50 µV settles the island — no steps until its inputs change. The layer reads the
time from the bench (`clock`) and plans through it (`plan`): one owner-0 timer per island, a
preallocated callback, replaced on re-plan; the resolver runs a step (`stepAnalog`) so the nets
that change reach their listeners as a resolution's do. While the circuit has an island whose
shortest time constant is under 5 ms (`fast`) the bench runs
100 µs quanta, so a step planned inside an MCU run (after a pin edge) is at most 100 µs late; a
slower island's steps come after the quantum's end anyway, so it keeps the 1 ms quanta; between steps a
reader sees the last published volts. A capacitor conducts for the "reached" rule: a net a charged
capacitor holds after its driver lets go publishes the capacitor's volts and a level from the
reader's thresholds. Capacitors start empty: at build, and at reset, which re-solves their islands
(`touchIslands`); a rebuild (an edit) empties them too. Islands without capacitors take the old
path unchanged. Measured (`analog/transient.test.ts`): an RC within 0.5 % of V·(1 − e^(−t/RC)) at
every step (≈ 0.1 % at τ), a 500 Hz square wave into 10 kΩ/1 µF averaging V/2 with the ripple
V·tanh(T/4τ) in about three solves an edge, and settling after about 30τ.

**Threshold crossings.** The bench gives the layer each read net's input thresholds — the
MCU's own, as its adapter applies them (`MCU_INPUT_THRESHOLDS`: the ATmega's 3.0/1.5 V, the ESP32
family's 2.475/0.825 V, the RP2040/RP2350's 2.0/0.8 V) — and after each step the layer shortens the
next one to land just past the next crossing (VIH rising, VIL falling) at the last step's slope
(×1.02: a charging curve is concave, so it crosses later; never shorter than h/64). So an input on
an RC changes level within a few percent of RC·ln(V/(V − Vth)): `uno/rc-delay` reads 0.92 ms rising
and 1.21 ms falling for 10 kΩ/100 nF, within 5 %.

**Transistors.** `AnalogSpec.transistors`: BJTs (`npn`/`pnp`: c, b, e, β, the junction's
knee and resistance, Vce(sat) and its resistance) and MOSFETs (`nmos`/`pmos`: d, g, s, Vth, Rds(on)
and the Vgs it is rated at). All three terminals join one island (so a change at a gate re-solves
the drain's side). A BJT's base–emitter junction is a piecewise-linear diode (b → e, or e → b for a
PNP); off while that is off (C–E a 1 GΩ leak); active, Ice = gm·(Vb − Ve) − s·gm·Vbe with gm = β/rb
(s = +1 NPN, −1 PNP): a voltage-controlled current, the solver's first nonsymmetric entries
(`DenseSolver.entry`; elimination pivots on rows, so that is fine); saturated when the active
solution would put Vce below Vce(sat): C–E is then Vce(sat) behind rsat, active again when that
would carry more than β·Ib. A MOSFET's gate takes no current (a 1 GΩ leak to its source); off below
Vth; on, its drain–source is a conductance rising linearly from 0 at Vth to 1/Rds(on) at the
datasheet's Vgs, flat above — a switch with a gate-dependent resistance (current saturation isn't
modeled). P-channel: voltages negated. States are picked from the last solution and iterated with
the diodes (20 rounds, `analog-no-convergence`); a conducting transistor's collector/drain (and a
BJT's base) count as reached through it. Tested on hand-built islands
(`analog/transistor.test.ts`): an NPN cut off, saturated at 0.2 V + rsat·Ic and active at
Ic = β·Ib; a PNP high-side switch; MOSFET on-resistance against Vgs, the gate's net untouched; an
NPN with an LED on its collector and a capacitor on its base settling as the base charges.
Each transistor may carry a rating (`iMax`, the datasheet's continuous collector/drain
current); after each solve the layer computes the current from the transistor's state (active
β·Ib, saturated (Vce − Vce(sat))/rsat, a MOSFET g·Vds) and calls `onTransistorCurrent` when one
crosses its rating either way, and the bench reports `transistor-overcurrent` (error, on the part)
while it is over — "About 923 mA through it; it is rated for 600 mA continuous" for a 2N2222A on a
4.7 Ω load — withdrawn when it drops.

**Capacitor and diode parts.** `capacitor` (ceramic, `farads` 100 nF, legs 1 and 2),
`capacitor-electrolytic` (10 µF, `+` and `-`; its model reports `capacitor-reversed` while more than
1 V sits across it backwards, and its visual `reversed` glows red) and `diode` (A to C, `model`
1N4148 or 1N4007 — `DIODE_MODELS`: knee 0.62 V with 3 Ω, 0.65 V with 0.3 Ω) reach the layer through
`analogSpecFor`; without the analog layer they connect nothing. Our own drawings
(`apps/web/src/views/passives.ts`: an orange disc with its EIA code, a blue can with its minus
stripe, an axial body with its band); standard PCB footprints (C_Disc, CP_Radial, DO-41) with
reference C and D and BOM values ("100n", the model). The Inspector shows `ohms` and `farads` with
SI prefixes and takes 4.7k, 4k7, 100n, 10 µF (`ui/si.ts`), and a `model` prop as a list
(`PART_MODELS`). On an Uno (`packages/parts/src/integration/rc-circuits.test.ts`): `uno/rc-filter`
— PWM on pin 9 through 10 kΩ into 10 µF — reads the duty on A0 within 2 % with a few counts of
ripple; the capacitor costs about 9 % of the run's CPU time (the island never settles: it steps
on every PWM edge).

**Transistor parts.** `npn-transistor` (2N2222A, BC547) and `pnp-transistor` (2N3906,
BC557) as TO-92 parts with legs E-B-C, `n-mosfet` (IRLZ44N, IRF540N) and `p-mosfet` (IRF9540N) as
TO-220 parts with legs G-D-S — `BJT_MODELS` and `MOSFET_MODELS` in `basic/transistors.ts` hold the
datasheet typicals (β, Vce(sat); Vth, Rds(on) and the Vgs it's rated at), every BJT's junction
knees at 0.65 V with 25 Ω above. The drawings put the legs in that order and label them (a BC547's
own legs run C-B-E: wire it by the labels; the model list says so). Our own TO-92 and TO-220
drawings in `views/passives.ts`; PCB footprints TO-92_Inline and TO-220-3_Vertical, reference Q.
The relay's coil is now a 125 Ω resistive link between COIL1 and COIL2 (a typical 5 V signal
relay's 40 mA coil): a transistor that's off leaves no coil voltage, and an Uno pin driving the
coil directly still energizes it (4.2 V, 33 mA — under the pin's 40 mA). Bench tests
(`integration/transistor-circuits.test.ts`): blink's D13 through 1 kΩ into a 2N2222A switching the
relay with a 1N4007 across its coil (Vce 0.22 V, 38 mA in the coil; its contact lights an LED), a
2N3906 high-side switch, and an ESP32's GPIO2 on an IRLZ44N's gate switching a 9 V LED load
(≈ 0.05 Ω at 3.3 V) where an IRF540N, its threshold 3 V, conducts at about 1 Ω.

**Transients end to end:** the gallery's RC filter (`uno-rc-filter`: PWM through 10 kΩ into
10 µF on A0, the target and the reading on the Serial Plotter), transistor relay
(`uno-transistor-relay`: blink's D13 through a 2N2222A switching the relay, a 1N4007 across its
coil) and ESP32 MOSFET dimmer (`esp32-mosfet-dimmer`: a pot sets GPIO25's PWM on an IRLZ44N's gate,
LEDs on a 9 V battery) — specs with the runner's new `pin … volts is …` and checks in
`examples-run-uno.test.ts` and `examples-run-esp32.test.ts`. Speed: `integration/rc-speed.test.ts`
(QUIET) holds the RC filter with its capacitor to 1.3× the CPU time of the same circuit without it,
the best of three alternating runs; the 100 µs quanta every moving island got before cost about
half of a 30 % overhead there, so only islands with a time constant under 5 ms get them now.

**A DC motor.** A capacitor may sit behind a series resistance and beside a leak
(`CapacitorSpec.seriesOhms`, `parallelOhms`): in companion form the capacitor and its leak are a
conductance Gc = k + gp (k = C/h, 2C/h trapezoidal) with a history current, and in series with gs
the branch is gs·Gc/(gs + Gc) carrying gs/(gs + Gc) of that current — still two terminals, no
internal node; after the solve the capacitor's own voltage comes back from the terminals',
(gs·Vab + history)/(gs + Gc), and τ counts the series resistance and the leak. A permanent-magnet
DC motor (without its inductance) is exactly that: its winding Rw in series with C = J/(ke·kt),
whose voltage is the back-EMF E = ke·ω, shunted by Rm = ke·kt/b for friction. So stall current,
spin-up, braking (terminals driven together: E drains through Rw) and coasting (terminals floating:
through Rm, the terminals showing the generated voltage) all come out of the circuit.
`dc-motor` (`actuators/dc-motor.ts`; pins `+` and `-`; props `volts`, `rpm` no-load at rated
volts, `ohms`, `msTau`, `noLoadPct` — defaults the geared "TT" hobby motor of starter kits at its
output shaft: 6 V, 200 rpm, 4 Ω, 60 ms, 10 %): `motorParams` with f = noLoadPct/100 sets ke = kt =
V·(1 − f)/ω0, C = msTau/Rw, Rm = Rw·(1 − f)/f. The winding's inductance isn't modeled, which
shows under PWM: coasting between pulses (an L298N's ENA) E settles where D·(V − E)/Rw = E/Rm —
91 % of full speed at half duty with the defaults (a real motor's inductance keeps its current
from building in short pulses, so it slows more) — while braking between pulses (an IN pin PWM'd
with ENA on) gives E = D·V·Rm/(Rw + Rm), proportional to the duty, as on a real bridge. The part model can't read the layer, so it integrates the same
equation from its terminal volts, exactly while they hold: E tends to V·Rm/(Rw + Rm) with
τ = C·(Rw ∥ Rm) — with its terminals floating the layer publishes V = E, so the pull vanishes and
it coasts through Rm as the layer does, with no need to tell driven from floating (a net reached
only through a transistor has no switch-level driver). Visual `rpm`, `angle` (the shaft's,
unbounded), `milliamps`; a 20 ms timer keeps frames coming while it turns. Our own view
(`views/motors.ts`): an end bell with its tabs, a silver can printing the speed and the way it turns,
a hub that turns with `angle` and blurs above 300 rpm. Tested (`integration/dc-motor.test.ts`): on
a 6 V pack 1.5 A at the start, 63 % of 200 rpm at τ, 200 ±2 % and 150 mA at speed, backwards
when turned round; through an IRLZ44N from blink's D13 with a 1N4007 across it, 200 rpm while on
and the coast's e^(−t/C·Rm) while off (±5 %).

**Inductance.** `CapacitorSpec.henries` puts an inductor in the same series chain:
Rs + L + (C ∥ Rp). In companion form each piece is a resistance and a Thevenin voltage — the
inductor L/h (2L/h trapezoidal) with −(L/h)·i (−(2L/h)·i − vL), the capacitor stage 1/Gc with
hist/Gc — so the chain is one conductance 1/ΣR carrying ΣE/ΣR, still two terminals; after the
solve the branch current comes back from the terminals' volts and gives the inductor's current and
voltage and the capacitor's voltage. `farads` 0 with no leak leaves the capacitor stage out: a
plain R–L (a coil). Elements without inductance keep their own path exactly. A jump keeps
the inductor's current (the 1 ns instant makes it a stiff current source), so a coil switched off
pushes its current wherever it can: through a flyback diode it freewheels at the diode's drop; with
nothing but leaks it would reach any voltage — the clamps below are what stop it. τ counts L over
the loop's resistance (Rs and what the rest of the island puts at its ends), and is now estimated
in every diode round, so the converged round's states set it (a flyback diode that turns on in the
second round made τ picoseconds before); never under 1 µs (`MIN_TAU_S`). Settling counts the
current's change times Rs and the inductor's voltage change. Tested (`analog/transient.test.ts`):
an R–L's current within 0.5 % of (V/R)(1 − e^(−tR/L)), freewheeling through a diode at −0.665 V
when the source lets go and dying away; an RLC ringing as V[1 − e^(−αt)(cos ωt + (α/ω) sin ωt)]
within 1 % of the step (62 % overshoot).

**Clamps and kicks.** A coil switched off with nowhere for its current to go would reach any
voltage, so the switches carry the breakdowns real ones have, as their parts' AnalogSpec diodes: a
BJT's Vceo collector to emitter (a PNP's emitter to collector: 2N2222A and 2N3906 40 V, BC547 and
BC557 45 V), a MOSFET's body diode source to drain (0.8 V, 0.05 Ω) and its avalanche drain to source
at Vdss (IRLZ44N 55 V, IRF540N and IRF9540N 100 V; mirrored on the P-channel), each conducting
through 0.5 Ω. The transistor parts' model (`avalancheModel` in `basic/transistors.ts`) reports
`transistor-avalanche` (warning) while the switch side is within 90 % of that rating — "An inductive
load kicked its collector to about 40 V, into breakdown (40 V): put a flyback diode across the load"
— held 2 s past the last kick so it can be read. The L298N's eight flyback diodes (each OUT to +12V,
GND to each OUT; 1N4007's) are its AnalogSpec too, so a disabled bridge returns a coil's current
to the supply (fast decay: the outputs at −0.67 and VS + 0.67 V until it's gone). Two layer fixes
came with them. A catch-up now replays an island's own nets as fixed or not as they were when it
was last solved (`inFixed`, `inFixedV` with the other kept inputs): a bridge that just released its
outputs was still driving them during the interval being caught up, and reading that live let the
coil's current die before the release happened. And τ is re-estimated on every solve, steps
included: a diode that stops conducting mid-way leaves a coil on its leaks alone, τ far below h, and
the trapezoidal rule then rang (±2 nA, the outputs swapping by 1.8 V each step) where backward Euler
settles. Tested (`integration/clamps.test.ts`, a test coil of 100 Ω and 100 mH on blink's D13): a
2N2222A switching it off peaks at 40–42 V and warns, with a 1N4007 across the coil it stays under
5.75 V and doesn't; an IRLZ44N avalanches at 55–56 V; the body diode conducts; the L298N's diodes
carry the coil's current back and then let the outputs float.

**Inductive parts.** `dc-motor` gains `mH` (1 by default: the TT motor's τ = L/Rw ≈ 0.25 ms)
as its element's `henries`, and its model now integrates the winding's current with the back-EMF —
L·di/dt = V − Rw·i − E, C·dE/dt = i − E/Rm — exactly between terminal-voltage changes with the 2 × 2
matrix exponential (Sylvester's formula; the complex pair if it rings), since the element's state
still depends on its terminal voltage alone; its `milliamps` is that current, and it agrees with
the layer's within 1 %. The relay's coil is an R–L branch (125 Ω, 150 mH, ≈ 1.2 ms) in place of its
resistive link (`analogSpecFor`). Measured (`integration/inductive.test.ts`): esp32/mosfet-dimmer's
1 kHz PWM through an IRLZ44N with a 1N4007 across the motor turns it at 200 rpm full, 81 % of that at
half duty and 60 % at a quarter — the winding's current freewheels through the diode between
pulses; unloaded, it runs out before the next one (discontinuous conduction), so half the duty
isn't half the speed, but without inductance it was 90 % — and without the diode the IRLZ44N
avalanches on every pulse (warned, and only 130 rpm). Blink's D13 switching the relay through a
2N2222A: without a diode the kick avalanches it and the contacts open ≈ 4.5 ms after D13 falls (4 ms
`operateMs` plus the step that sees the kick end); a 1N4007 across the coil holds them ≈ 2.5 ms
longer, while its current decays through the diode. Cost: an inductive motor island under PWM is a
fast island (τ = L/R < 5 ms) and steps through every pulse — ≈ 2.4 × the CPU of the same circuit
without inductance in that run, budgeted below.

**Inductance end to end:** the gallery's ESP32 motor speed (`esp32-motor-speed`:
esp32/mosfet-dimmer's pot-set PWM through an IRLZ44N, a 1N4007 across the geared motor) and relay
flyback diode (`uno-relay-flyback`: blink's D13 driving two relays through 2N2222As, one with a
1N4007 across its coil and one without — only the second's transistor reports
`transistor-avalanche`) — specs and checks in `examples-run-esp32.test.ts` and
`examples-run-uno.test.ts`. Speed: `integration/inductive-speed.test.ts` (QUIET) holds uno/rc-filter's
490 Hz PWM driving the motor through an IRLZ44N with its 1 mH to 1.5× the CPU time of the same
circuit without it, best of three alternating runs; measured ≈ 1.03× on the Uno (an earlier 2.4× on the
ESP32 came from a first, cold run).

**An L298N H-bridge.** `l298n` (`actuators/l298n.ts`), the common red module: OUT1–OUT4,
+12V, GND, +5V, ENA, IN1–IN4, ENB; props `enaJumper`, `enbJumper`, `regulator` (all on, as shipped).
A channel is enabled by its jumper or its EN pin reading high (TTL, 2.3 V over GND); enabled and
powered (VS ≥ 4.5 V), each output is driven at supply strength — VS − 1.4 V for a high IN, 0.8 V
for a low one (the L298's typical drops at 1 A) — so IN1 ≠ IN2 turns a motor and IN1 = IN2 brakes
it; disabled, the outputs are released and it coasts. The regulator drives +5V at VS ≥ 7 V. A
motor between two supply-driven outputs is an element between two fixed nets: it stamps nothing,
and its capacitor's voltage still follows from theirs. Outputs are only re-driven when what they
should do changes. Not modeled: the module's flyback diodes, current sensing, the 2 A limit. Its
visual (`outs` 0 off/1 high/2 low, `enabled`, `powered`, `regulator`) drives our own view in
`views/motors.ts`: the red board, the heatsink, blue terminals, jumper caps per the props, a power
LED and a status line per channel (▶, ◀, brake, off). Tests (`integration/l298n.test.ts`):
`uno/l298n-motor` — the pot's duty PWM'd on IN1/IN2 (ENA on 8), so the bridge brakes between pulses
and the speed follows the duty (full 227 rpm from 9 V less the drops, half duty half the speed
±5 %), the button brakes (20 % left after 150 ms) and reverses, a duty under 10 coasts — and
`uno/l298n-stepper`: the Stepper library turns a bipolar stepper on both channels a turn and back
(199 steps the first time: its first coil state is the reference).

**Motors end to end:** the gallery's DC motor on an L298N (`uno-l298n-motor`: the pot's duty
PWM'd on IN1/IN2, a button that brakes and reverses, a pot near zero to coast) and ESP32 motor
switch (`esp32-motor-switch`: `esp32/gpio-input`'s button → GPIO2 on an IRLZ44N's gate, a geared
motor on a 6 V pack, a 1N4007 across it) — specs with the runner's new `motor <part> rpm is …` and
checks in `examples-run-uno.test.ts` and `examples-run-esp32.test.ts`.

### Parts

The contract is `packages/core/src/contracts/part.ts`; the catalog that fills it lives in
`@benchtop/parts` (`CATALOG`, `benchEnvParts` for the bench's `BenchEnv`). A part type is a
`PartDefinition`: `type`, title,
category, `size` in mm, `pins` (name, offset in mm from the unrotated top-left, electrical
`role`), internal `buses` (pin groups shorted inside the part, merged by the netlist), `links`
(resistive or switch elements between two pins, which the resolver passes signals through
without merging nets), default props, an optional `board` spec, and an optional
`createModel(ctx, props)`.

**Streams in visual state** (audio, TFT): a visual state is normally the part's
latest look, and the frame ring keeps only the newest per part. Two parts instead emit a
stream whose every piece matters: a speaker's `audio` blocks and an ILI9341's framebuffer
updates (`tftX/tftY/tftW/tftH/tftFull/tftPixels`: one dirty rectangle per frame, RGB565 packed
two to a number since `VisualState` holds plain numbers; a full frame after a reset). The
session sends both in frame messages, never through the ring, and the UI's `FrameDispatcher`
folds TFT updates into a framebuffer per part (`applyTftUpdate`) that it hands views as
`tftFrame`, so a view that registers late still paints the whole screen. The ILI9341 model
(`displays/ili9341.ts`) parses the command set over SPI (CASET/PASET/RAMWR/RAMWRC windows, MADCTL
rotations and BGR, 16- and 18-bit color, SWRESET/RST, sleep and display on/off, inversion); reads
aren't modeled (MISO stays 0xFF), so the bench attaches an SPI device whose MISO is unwired by
SCK and MOSI alone. The view draws into the element's own 240×320 canvas.

**Touch pads and capacitive touch**. The `touch-pad` part (a copper electrode, one pin
`PAD`) drives nothing: its model carries `touchLoad` (`bench/touch.ts`, not a contract, as
`storage` is): the picofarads it adds to its pin's net — the electrode's `padPf` (2 by default)
plus `fingerPf` (10) times the contact (press 1, release 0, a value 0–1). An MCU with touch
channels opts in with `TouchSensing` (`touchPins()`, `setTouchSource()`, found by `usesTouch`):
after every build (kept MCUs too) the bench gives it a source that sums the touch loads on each
touch pin's net — breadboard strips and wires included, as nets are — and the MCU asks once per
measurement and adds its own pad. The ESP32 (version 1, readings fall when touched), the
ESP32-S2 and the ESP32-S3 (version 2, readings rise) have touch channels (their sections).

**IR remote and receiver, HX711**. The `ir-receiver` turns input `{ kind: 'key', key:
'ir:<command>', down }` into a demodulated NEC frame on DAT (active low, address 0x00, 9 ms +
4.5 ms leader, 562.5 µs marks, 562.5/1,687.5 µs spaces, LSB first; a repeat code every 108 ms
while held; keys during a frame are ignored), scheduled edge by edge. The `ir-remote` part has no
pins and no model: the canvas sends its keys to every receiver in the document
(`apps/web/src/views/ir-remote.ts`), so specs and recordings target the receiver; a part with
no pins is never "unwired". The `hx711` converts 10 times a second (DOUT low = ready), shifts
24 bits MSB first on PD_SCK rising edges, takes 25/26/27 pulses as A×128 / B×32 / A×64 for the
next conversion, saturates at the 24-bit limits, and powers down when PD_SCK stays high over
60 µs (measured from that rising edge). Its load cell reads `offset + weight · countsPerGram`
(props; weight also as `value` input, an Inspector slider); channel B reads 0.

A pin with `volts` defined is a **supply source** at that voltage (ground pins: 0) and gets a
supply-strength driver; a pin without `volts` only consumes. A `PartModel` talks to the circuit
only through its `PartContext`: pin handles (read, drive, driveVolts, release, onChange), link
handles (open/close, set ohms), timers on the simulated clock, `invalidate()` for visuals,
`report()` for problems, and `attachI2c`/`attachSpi` to put a device on a bus. While an MCU
executes, `ctx.now()` is that MCU's current cycle time, so pin listeners see exact edge times.
The model exposes a small serializable **visual state** (LED brightness, LCD characters, servo
angle). Views in `apps/web` render that state; they never compute behavior. PWM brightness is
integrated in the worker from edge timestamps, so a 490 Hz `analogWrite` renders as a dimmed
LED, not a flicker.

Basic parts: `arduino-uno`, three generated breadboards (`breadboard` 63 columns,
`breadboard-half` 30, `breadboard-mini` 17 without rails; Wokwi's hole names `5t.a`, `12b.j`,
`tp.1`/`tn.1`/`bp.1`/`bn.1`; each 5-hole half column and each rail is a bus), `resistor`,
`led`, `rgb-led`, `pushbutton`, `slide-switch`, `potentiometer` and `buzzer`. Pin positions are
copied from `@wokwi/elements` (px → mm), never imported. LED brightness
(`packages/parts/src/shared/duty.ts`): a change after ≥ 50 ms of steadiness shows at once (a
blink flips at its exact edge); faster toggling is measured as the lit fraction of ≥ 10 ms
windows that start and end on rising edges (so PWM reads its exact duty); waveforms slower than
20 Hz blink visibly. The Uno's model shows `ledL` (D13), `ledPower`, and `ledTx`/`ledRx`, which
flash for 30 ms when the bench's owner sends the board input `{ kind: 'key', key:
'serial-tx' | 'serial-rx', down: true }` — nothing on the board's pins shows USB serial traffic.
A part sitting on a breadboard is connected by contact: its legs within 0.4 mm of holes.

Displays (`packages/parts/src/displays/`): `hd44780.ts` is the character-LCD controller
every LCD shares (DDRAM/CGRAM, entry mode, display/cursor shift, 4/8-bit with LiquidCrystal's
nibble init; RW=1 reads and busy timing are not modelled). `lcd1602`/`lcd2004` latch RS and
D0–D7 on E's falling edge; `lcd1602-i2c`/`lcd2004-i2c` put a PCF8574 backpack (prop `address`,
0x20–0x27 or 0x38–0x3F, else the part fails to start) on the I2C bus. Their visual state is
the shown characters after display shift, cursor/blink/position, `displayOn`, `backlight` and
the 64 CGRAM bytes; the view patches those into a per-element copy of the element's font, so
custom characters render. 7-segment displays are three part types (`seven-segment`,
`seven-segment-2`, `seven-segment-4`), because a part type's pins are fixed and the pinouts
differ; each segment of each digit is a duty channel, so a multiplexed display reads ~1/digits
brightness (the element shows a segment lit above 0.05). `led-bar-graph` is ten LED channels.

`ssd1306` is a 128×64 OLED as an I2C target (0x3C/0x3D; reads NACKed): control bytes
(Co, D/C), a command parser driven by an argument-count table whose state survives STOP/START
(Adafruit sends arguments in their own transmissions), horizontal/vertical/page addressing
with 0x21/0x22 windows, and the decided display mapping (A1 + C8 is the identity; A0 mirrors X;
lit only when on and the charge pump is enabled).

**Rows and scrolling** (from the SSD1306 datasheet rev 1.1). Each glass row is wired to a
COM pad; the COM pins configuration (DAh: sequential or alternative, left/right remap), the scan
direction (C0h/C8h), the display offset and the MUX ratio decide which scan slot that pad shows
(Tables 10-1–10-3: `scanIndex`, `scanSlot`), and the slot shows RAM row (slot + start line) mod 64.
The 0.96″ 128×64 glass is wired for the alternative configuration, the 0.91″ 128×32 for the
sequential one, so Adafruit's inits are the identity on their own glass and the other module's
init draws every other row, as on a board; a smaller MUX darkens the rows whose pads aren't
scanned (with C8h on the 128×64, the top half). The model keeps `rowMap` (glass row → RAM row,
−1 dark), rebuilt when any of that changes. The hardware scroll runs: 26h/27h move pages B–D one
column right or left a step by rotating the RAM itself (so a stopped scroll stays where it
stopped; RAM column order, so Adafruit's A1 module scrolls right on 26h), 29h/2Ah also move a
vertical offset E rows a step inside the A3h area (2Eh clears it); a step comes every 2–256
frames, a frame being D·K·N oscillator clocks from D5h, D9h and the MUX (Fosc 370 kHz at the
default setting, assumed linear across the settings) — Adafruit's 128×64 init steps every 57 ms.
Steps are timers on the bench clock, so nothing runs while nothing scrolls.
`integration/oled-circuits.test.ts` runs `uno/oled-scroll` (Adafruit's startscrollright/left/
diagright). Its visual
`fb` packs the displayed image into 256 numbers (4 page-major bytes each) and is repacked only
when a written byte actually changed, so an identical `display()` costs no frame; `on`,
`invert`, `allOn` and `contrast` travel separately and the view (`views/ssd1306.ts`) applies
them while unpacking into one preallocated ImageData (contrast as canvas opacity
0.35 + 0.65 × contrast/255).

**More modules** (`displays/oled-modules.ts`). `ssd1306-128x32` is the 0.91″ module (GND, VCC,
SCL, SDA down its left end) on its 32-row glass, so its `fb` is 128 numbers. `ssd1306-spi` is the
0.96″ 7-pin module (GND, VCC, D0 = SCLK, D1 = SDIN, RES, DC, CS) driving the same controller through
`commandByte`/`dataByte` by its D/C pin: hardware SPI through `attachSpi` (it has no MISO and names
D1 for it, which the bench takes as write-only — `attachSpiDevice`), and bit-banged SPI from its own
pins (`shared/soft-spi.ts`: D1 shifted on every D0 rising edge while CS is low, a byte on the
eighth, the datasheet's §8.1.3; no allocation per edge). A hardware controller toggles no pin, so
no byte arrives twice; wired to non-SPI pins it reports `spi-unattached` (info) and still works.
RES low resets the controller and holds it. Our own views (`apps/web` `views/oled.ts`: SVG modules,
the pixels on a canvas in a foreignObject over the active area; `paintOled` is shared with the
element's view). `integration/oled-modules.test.ts` runs uno/oled-128x32, uno/oled-spi (software
SPI on Adafruit's example pins 9–13) and esp32/oled-spi (VSPI): each panel shows exactly the
buffer the library printed.

**The SH1106** (`displays/sh1106.ts`, Sino Wealth's datasheet V2.2). The 1.3″ module's
controller behind the same I2C framing: a 132×64 RAM whose columns 2–129 reach the 128-wide glass
(Adafruit_SH110X's offset of 2), page addressing only (the column counts up to 131 and stays), the
DC-DC converter (ADh 8Ah/8Bh, on at reset) as the panel's supply, read-modify-write (E0h … EEh),
no scroll; the same COM pads, scan, offset and MUX as the SSD1306 (`scanIndex`, `scanSlot`). A byte
the command table doesn't list is ignored on its own, so an SSD1306 command's argument runs as a
command — an SSD1306 sketch on it shows garbage, as on a board. `sh1106` (VCC, GND, SCL, SDA)
shares the module views and `oledModel` (any `OledController`). `integration/sh1106-circuits.test.ts`
runs uno/sh1106 (Adafruit_SH110X): the panel shows its buffer.

**OLEDs end to end.** `displays/oled-text.ts` reads an OLED's visual state as shown
(`oledPixel`: dark while off, `allOn`, `invert`) and as text (`oledScreenText`: braille, 2 × 4 pixels
a character — 16 lines of 64 for 128×64, 8 for 128×32). The runner's `oled <part> pixel <x>,<y> is
<on|off> at <t>` checks a pixel; MCP's sim_state adds `screen` (those lines) to any OLED's state, so
an agent reads the panel instead of a packed framebuffer. Gallery: a 128×32 scroller on an Uno
(`uno-oled-128x32`), the 1.3″ SH1106 (`uno-sh1106`), an ESP32 with the 7-pin module on VSPI
(`esp32-oled-spi`), each with a spec in fixtures/specs/examples and a run check.

**MAX7219 modules** (`displays/max7219.ts`, Maxim's datasheet). The chip shifts DIN into
16 bits on every CLK rising edge whatever LOAD is (the MAX7219's rule), latches them on LOAD's
rising edge (D11–D8 the register, D7–D0 the data) and shows what it shifted in on DOUT, sixteen
clocks behind, on the falling edge. Registers: digits 0–7, decode mode (Code B per digit: 0–9, -,
E, H, L, P, blank; D7 the point), intensity ((2k + 1)/32 duty), scan limit, shutdown, display test
(everything lit, nothing changed); power-up is shutdown, one digit, no decode, minimum intensity.
Three modules: `max7219-matrix` (one 8×8), `max7219-matrix-4` (the FC-16: four chips chained on the
board) and `max7219-7seg-8`; the input header (VCC GND DIN CS CLK) on the right, the output on the
left, VCC/GND/CS/CLK bused between them. Bit-banged bytes arrive as edges, hardware SPI through
`attachSpi` with GND as the select; a byte moves each chip's register on by eight bits and the one
that fell out goes to the next chip, then out of DOUT to a chained module (the bench's chains).
Wiring follows MD_MAX72XX's FC16_HW: digit d is row d, D7 the leftmost column, chip 0 the rightmost
matrix; on the 7-segment module digit 0 is the rightmost. Visual: `rows` (8 bytes a chip), `level`
(the duty times 8 / scanned digits, at most 1 — fewer digits are brighter, as the datasheet warns)
and, for the 7-segment module, `values` and `segments` in the 7-segment parts' order, so a dim digit
still reads as lit (`sevenSegmentText` gained E, H, L, P). Our own views (apps/web
views/max7219.ts: round dots, italic segments, opacity 0.4 + 0.6·√level). Fixtures uno/max7219 (the
FC-16 on hardware SPI) and esp32/max7219-7seg (the 8-digit module bit-banged, LedControl's way).

**The TM1637 module** (`displays/tm1637.ts`, Titan Micro's datasheet V2.1). `tm1637-4digit`
is the common 0.36″ clock display: four digits, the colon, pins CLK DIO VCC GND and the board's
pull-ups on CLK and DIO (the libraries release a line to send a 1). The two-wire bus is decoded
from the pins: START is DIO falling while CLK is high, STOP DIO rising while it is high, bytes go
LSB first and are read on CLK's rising edge, and the chip ACKs each by pulling DIO low from the
eighth clock's falling edge to the ninth's; a STOP inside a byte drops it. Commands: data (write
or read keys, auto-increment or a fixed address), address (C0h–C5h; past C5h data is ignored),
display control (on, and the eight pulse widths 1/16 … 14/16). GRID1–4 are the digits left to
right, SEG8 of GRID2 the colon (TM1637Display's dots bit); a key read answers 0xFF. Powered at
VCC ≥ 3 V (decided: the datasheet's 5 V ± 10 %, the modules commonly on 3.3 V boards). Visual:
`values` as the 7-segment parts, `colon`, `segments` and `level`. Our own view (apps/web
views/tm1637.ts). Fixtures uno/tm1637 (TM1637Display's open-drain bus, a counter) and pico/tm1637
(a clock on 3V3).

**More kit parts end to end.** Gallery: a BME280 weather readout under Adafruit's library
(`uno-bme280`), a BMP280 on an ESP32's SPI (`esp32-bmp280`), a DS3231 clock and alarm under RTClib
(`uno-ds3231`), 16 inputs through two 74HC165s with four buttons (`uno-shift-in`) and a relay
module's lamps (`uno-relay-module`), each with a spec and a run check. MCP's sim_state reads them as
they are (the DS3231's `time` and `temperature`, a BME280's weather).

**Kit chips end to end.** The runner's `digits` reads the MAX7219's 8-digit and the TM1637's
modules (`displayText`: by their reported lit segments), and `matrix <part> row <r> shows "<#.…>"`
checks a matrix module's row (`matrixText`: left to right across the FC-16's four, chip 0 the
rightmost). MCP's sim_state adds `screen` to a matrix (its rows as '#'/'.' lines) and `shows` to any
7-segment display (its digits). Gallery: a 595 counting on eight LEDs (`uno-shift-register`), the
FC-16's pictures (`uno-max7219`), LedControl's digits and matrix (`uno-ledcontrol`), an ESP32 8-digit
module (`esp32-max7219-7seg`), two DS18B20s under DallasTemperature (`uno-ds18b20`), a Pico TM1637
clock (`pico-tm1637-clock`), an Uno TM1637 under TM1637Display (`uno-tm1637`) and a DS18B20
thermometer on a TM1637 (`uno-tm1637-thermometer`), each with a spec in fixtures/specs/examples and a
run check.

**Chips** (`packages/parts/src/ics/`). `74hc595` is a DIP-16 (`dipPins`: pin 1 bottom left,
rows 7.62 mm apart, so it straddles a breadboard's gap) with NXP's pin names (DS, SHCP, STCP, MR,
OE, Q0–Q7, Q7S, VCC, GND). Its function table: SHCP ↑ shifts DS in while MR is high, MR low clears
the shift register, STCP ↑ latches it onto Q0–Q7, OE high releases them; powered at VCC ≥ 2 V over
GND, a high output drives VCC's volts. Q7S changes with the shift, as the chip's: the resolver
applies a drive made inside a listener after every listener of that edge, so a chain of 595s is
right whatever their placement order. Hardware SPI arrives through `attachSpi` with GND as the
select (the latch isn't one): the byte becomes the shift register and the old one is what it
shifts out — the next member's byte in a chain. Our own view (apps/web views/ics.ts: the body,
notch, pin 1's dot and every pin's name). Fixtures uno/shift-register (a shiftOut counter on eight
LEDs) and uno/shift-chain (two chained: shiftOut, SPI read back on MISO, LSB-first SPI).
`74hc165` (NXP's names PL, CP, CE, DS, D0–D7, Q7, Q7N): PL low loads D0–D7 asynchronously; with PL
high a rising edge of CP OR CE (the gated-OR clock) shifts DS in; Q7/Q7N drive VCC's volts. On SPI it
is read-only (CE the select): a byte reads the stages D7 first and shifts in DS's rail level, or the
byte the bench hands it in a chain. Fixture uno/shift-in (two chained, bit-banged and on SPI).

**The relay module** (`actuators/relay-module.ts`). `relay-module` is the blue 1-channel
SRD-05VDC-SL-C board: VCC GND IN, terminals NO COM NC as switch links (NC closed at rest). Active low
by default (IN pulled up on the board; `trigger: 'high'` for the jumper's other side), powered at
VCC ≥ 4 V; the contacts change over 10 ms after IN goes active and 5 ms after it goes idle (the
SRD-05VDC's maxima; up to a quantum later when IN changes inside an MCU's run), so a pulse shorter
than the operate time moves nothing. Its coil current isn't drawn from VCC. Our own view (apps/web
views/relay-module.ts: the power and input LEDs, the contact arm). Fixture uno/relay-module.

Inputs (`packages/parts/src/inputs/`, `sensors/`): slide pot, analog joystick, KY-040,
4×4 membrane keypad, 8-way DIP switch, tilt switch, PIR, and the LDR, NTC and sound modules.
Contacts are switch links (keypad, DIP, buttons), so a keypad's ghost key comes out of the
resolver, not the part. Analog outputs are ideal ratiometric sources for now —
`driveVolts(f(V(GND), V(VCC)), strong)` from the part's own supply pins (`shared/supply.ts`) —
and every transfer function is a pure export of `shared/transfer.ts` (pot, joystick, LDR
`rl10·(lux/10)^−γ` against 10 kΩ, NTC β model against 10 kΩ, sound envelope) for the analog
solver to reuse. Parts with more than one input value use the **channel-input convention**
(`shared/channel-input.ts`): `{ kind: 'key', key: 'set:<channel>=<number>', down: true }`,
because `PartInput` has no channel field and the contracts are frozen; single-value parts use
`{ kind: 'value', value }`. Values an element can't set itself (light, temperature, sound
level, motion, tilt) get Inspector controls from a UI-only table (`apps/web/src/views/
controls.ts`): stopped, a slider edits the part's prop (its initial value); running, it sends
input only and leaves the document alone.

Timed protocols (`dht22`, `hc-sr04`; registers: `ds1307`, `mpu6050`). Decoders measure
pulses with `ctx.now()` at each pin change (exact, even mid-run) and answer through one
preallocated timer callback that steps a state machine. The bench can't stop an MCU early, so
a timer scheduled from a pin listener during an MCU run fires when that run ends; a part that
must answer an edge after a short delay keeps a `RunSplitter` (`shared/run-splitter.ts`)
armed — one pending timer at most that far away — so runs end before the answer is due and it
fires exactly on time (DHT22: 200 µs idle, 20 µs during a start pulse; HC-SR04: 150 µs). The
MPU-6050's `address` is a getter on its AD0 net, read by the bus at every START.

**The DS18B20** (`sensors/ds18b20.ts`, Dallas/Maxim's datasheet). A TO-92 (GND, DQ, VDD) on
1-Wire, open drain: it pulls DQ low or lets go, and the line needs a pull-up (without one it floats
when released and reports `onewire-no-pullup`, warning). From DQ's edges: a low of 240 µs or more
is a reset (decided between a 120 µs slot and the master's 480 µs), answered 30 µs after the
release by a 120 µs presence pulse; a write slot released within 30 µs is a 1; in a read slot a 0
holds the line low for 25 µs from the master's fall. Each slot's kind is decided at its falling
edge, so the sensor's own presence pulse and a read slot's release are never read as written bits.
A RunSplitter keeps MCU runs at 200 µs while idle and 10 µs from any falling edge until the bus has
been quiet for 2 ms. ROM commands: read, match, search (bit, complement, the master's choice; a
mismatch drops out until the next reset), alarm search (while the last conversion was above TH or
below TL in whole degrees), skip. The ROM code is family 28h, the 48-bit `serial` prop and the
CRC-8; the editor gives each placed sensor its own serial from its id (`initialProps`,
`ds18b20Serial`). Function commands: convert (93.75–750 ms by resolution; read slots answer the busy
flag), write/read scratchpad (9 bytes, the CRC last, then 1s), copy to the EEPROM (10 ms busy),
recall, read power supply (0 when parasite-powered: VDD on GND). Power-up: 85 °C in the scratchpad,
TH 75, TL 70, 12 bits. A conversion samples the temperature (the prop, the `temperature` channel or
the environment's field) at its start and rounds it to the resolution's step. Its view is the
transistors' TO-92. Fixtures uno/ds18b20 (two sensors searched, converted together, read by Match
ROM) and esp32/ds18b20 (read ROM, 9 and 12 bits), each with OneWire's timings in the sketch.

**The BME280 and BMP280** (`sensors/bme280.ts`, Bosch's BME280 datasheet rev 1.23). One
register model for both (the BMP280: no humidity, chip id 0x58 instead of 0x60, its own two longest
standby times) on the purple 6-pin breakout (VCC GND SCL SDA CSB SDO; the board pulls CSB up and SDO
down). The chip carries fixed trimming words — temperature and pressure from the BMP280 datasheet's
worked example (its adc_T 519888 reads 25.08 °C, t_fine 128422), humidity typical — and the model
finds the raw ADC words the datasheet's integer compensation (int32 temperature and humidity, int64
pressure in BigInt) turns into the values the part should show, by binary search, only when they
change. Modes: sleep, forced (one measurement, then sleep), normal (measurement, t_standby, again on
one preallocated timer); a measurement sets `measuring` for Appendix B's maximum time; oversampling
×1…×16 gives 16…20-bit words; the IIR filter (2–16) filters pressure and temperature and makes them
20-bit; a skipped channel reads 0x80000 (0x8000). I2C at 0x76 or 0x77 by SDO, writes as
register/data pairs, reads auto-incremented; 4-wire SPI with the read/write bit, and once CSB has
gone low I2C is off until power-off. Temperature and humidity from props, sliders or the environment;
pressure from a prop or slider. Our own view (apps/web views/sensor-modules.ts). Fixtures uno/bme280
(I2C, forced, ×1) and esp32/bmp280-spi (VSPI, normal, filter ×16), the datasheet's compensation in
each sketch.

**The DS3231** (`sensors/ds3231.ts`, Maxim's datasheet). On the ZS-042 module (32K SQW SCL SDA
VCC GND, SCL/SDA/VCC/GND passed through; the board pulls SQW and 32K up) with its AT24C32. Registers
00h–12h, the pointer wrapping at 12h: BCD time with 12/24 h and the century bit (the DS1307's
`advanceSecond`, the century toggled at 99 → 00), alarms 1 and 2 by their mask bits and DY/DT tested
at each second's update (alarm 2 at 00 seconds), control (power-up 1Ch), status (power-up 88h; OSF,
A2F, A1F only clear), aging (kept), temperature in 0.25 °C steps — 0 °C at power-up, converted then,
every 64 s and on CONV, BSY and CONV set for the datasheet's 200 ms. Writing the seconds restarts the
second. INT/SQW is open drain: low while an enabled alarm's flag is set (INTCN), else the 1 Hz wave
(high for the half second after each update); 1.024–8.192 kHz and 32K's 32.768 kHz aren't drawn as
edges. The AT24C32 (`At24c32`, reusable) at 0x57: 4 KB, two address bytes, 32-byte page writes that
wrap inside the page, committed at STOP, then a 10 ms cycle during which it NACKs (ACK polling
works); sequential reads; its bytes survive a bench reset. Our own view (views/sensor-modules.ts,
with the time in small print). Fixture uno/ds3231 (time, alarm 1 into an interrupt, a forced
conversion, the EEPROM with ACK polling, the 1 Hz wave measured by pulseIn).

**Under their libraries.** The same chips under the libraries tutorials use, installed at
exact versions from the Arduino library index and recorded in the manifest: OneWire 2.3.8 with
DallasTemperature 4.0.6 (uno/dallas-temperature: two sensors counted, addressed, set to 11 bits,
alarm-searched — a sensor left at its power-up TL of 70 °C alarms at room temperature, as a real
one does; esp32/dallas-temperature: 9 and 12 bits, polled to the conversion's end) and LedControl
1.0.6 (uno/ledcontrol: bit-banged, its own no-decode font, a 7-segment module chained into an 8×8
through DOUT); TM1637 1.2.0's TM1637Display (uno/tm1637-display: the colon, raw
segments, the display off, leading zeros; uno/tm1637-thermometer: a DS18B20 under DallasTemperature
shown as "21°C"); Adafruit BME280 2.3.0 (uno/bme280-adafruit: forced mode, the altitude),
Adafruit BMP280 3.0.0 (esp32/bmp280-adafruit: hardware SPI, normal mode, the filter) and RTClib
2.1.4 (uno/rtclib-ds3231: lostPower, adjust, alarm 1, the temperature — 0 °C when read before the
power-up conversion ends, as on the chip). The sketch-local fixtures stay: they cover hardware SPI,
the 595 and the Pico.

Actuators (`packages/parts/src/actuators/`) decode their drive from exact edge timestamps
or coil levels and never allocate per edge. The servo measures pulse widths (Servo.h's 544–2400
µs ↔ 0–180°) and moves its horn lazily at 600 °/s. Steppers read their coils once they have been
steady for 100 µs (a library writing four pins one by one makes one step; a RunSplitter keeps
runs that short) and count half-steps; a jump between opposite states is ambiguous and reported
as `stepper-sequence`. The bipolar motor reads its coils as volts — A = V(A+) − V(A−), B likewise —
and its electrical position is atan2(B, A): the same half-steps for digital drive, and
every microstep of a driver's sine/cosine currents. The A4988 (`actuators/a4988.ts`, our own SVG)
walks a 64-entry translator table per electrical turn — full steps at 45° + k·90° from the 45°
home, MS1–3 for 1/2…1/16 — and drives 1A/1B and 2A/2B as VMOT·cos θ and VMOT·sin θ; ENABLE high,
SLEEP low or RESET low release them. The flame and MQ-2 gas modules (`sensors/flame-gas.ts`)
drive AOUT through `flameVolts`/`mq2Volts` (shared/transfer.ts; MQ-2: the datasheet's log-log
line into a 10 kΩ load) and an active-low DOUT from the comparator threshold. The WS2812 decoder (`ws2812-decoder.ts`) classifies each high (< 625 ns =
0), assembles GRB pixels, latches after a 50 µs low, and once a part has its own pixels mirrors
DIN onto DOUT synchronously, so a chained strip and ring see the same timestamps. The buzzer
measures frequency and duty from edges (passive) or sounds at a fixed tone while driven
(active); its sound is played on the UI thread with Web Audio (`apps/web/src/ui/audio.ts`,
muted until the toolbar's speaker is clicked), never in the worker. The relay energizes at
≥ 3.75 V across its coil and moves its contacts 4 ms later. When a model reports a problem, the
bench adds the part's own id (a model can't know it). The speaker and the microphone
carry real waveforms: see "Sound both ways" below.

I2C attach rules (bench): a device registered with `attachI2c` is on a controller's bus when
its SDA and SCL pins share nets with the controller's current `pins()`; the bench is rebuilt on
every topology change, so this is re-evaluated then. The controller reads each device's
`address` at every START and NACKs when none matches. Two devices on one bus with the same
address at attach time give an `i2c-address-conflict` error naming both; the first attached
answers. A device on no controller's pins is an `i2c-unattached` info problem.

**Power parts (`packages/parts/src/power/`).** Batteries (`battery-9v`, `-2aa`, `-4aa`,
`-lipo`, `-cr2032`: 9, 3, 6, 3.7, 3 V), a `bench-supply` (prop `volts`, 0–30 V; the Inspector's
slider sends a `value` or `set:volts` input while running) and a `ground` symbol (one pin, a
static 0 V supply). `PinDef.volts` is static, so a source whose volts depend on its type or a
prop drives its own pins from its model — + at its volts, − at 0 V, both at supply strength, as
the ESP32 DevKit drives VIN. The resolver counts a supply-strength driver as fixing its net
whenever it drives (`isFixed` is live); the analog layer's islands are built before the models
drive, so a net fixed at run time gets an identity row in its island's solve and is published
at its fixed volts (before, such a net published the solver's 0 V, though currents through it
were right). Two supplies on one net average their volts; the switch-level resolver sees two
highs and no conflict, so a source watches its own terminals (`power/fight.ts`) and reports
`supply-fight` while its net sits more than 0.1 V off its volts (a 9 V battery's + on a board's
5 V reads 7 V). Volts are nominal and ideal (no internal resistance or discharge) and absolute
against the bench's one ground — batteries in series are a fight, not a sum. Drawings are our
own (`apps/web/src/views/power.ts`, every terminal at its pin); on a PCB the batteries are
connectors (`BT` designators) and the supply and ground symbol stay off the board.

Regulators (`power/regulators.ts`): `lm7805` (TO-220, 5 V, 2 V dropout, 35 V max in),
`ams1117-3v3` (a breakout, 3.3 V, 1.1 V, 15 V) and `mcp1700-3v3` (TO-92, 3.3 V, 0.178 V, 6 V —
the one a LiPo can feed). OUT follows IN: `min(Vout, VIN − dropout)` above GND at supply
strength, released while IN or GND float; `regulator-dropout` (warning) while IN is below
Vout + dropout, `regulator-overvoltage` (error) above the rating, both withdrawn when they no
longer hold. OUT is the first power pin listed: a part's logic supply — what its drives call a
1 — comes from its first power pin's net, and OUT's is what it makes (an AMS1117 fed 9 V would
otherwise call its 3.3 V a 0). Their PCB footprints are standard ones (TO-220-3, TO-92 inline,
a 1×3 header) with the datasheet's pad numbers. Loads aren't modeled: no current limit, no heat.

**microSD card (`packages/parts/src/storage/`).** The `microsd-card` module (CS, SCK, DI,
DO, VCC, GND, CD; the Wokwi element's drawing) holds an SD card in SPI mode (`sd-card.ts`, an
`SpiDevice`): an 8 GB SDHC card — block addressed, CMD8 answered, OCR's CCS set, CSD 2.0 — over
`SparseBlocks` (`blocks.ts` — in @benchtop/core's `storage/` with `fat.ts`, so the ESP32-S3's
USB host reads a drive with them too —: 512-byte blocks in a map, unwritten ones read as zeros, so the card
costs what its files do). Silent until a CMD0 with its CRC; responses follow one fill byte;
CRC7 checked on CMD0 (SD mode) and CMD8, on everything once CMD59 turns it on, CRC16 on written
blocks then too and always sent on reads; ACMD41 with HCS leaves idle on the second poll;
CMD9/10/17/18/24/25/12/13/16/32/33/38/58/59/6 and ACMD13/22/23/41/42/51; a block write answers
0x05 on the next byte and holds MISO low for 250 µs of simulated time; CS rising drops a
half-sent command, nothing else. The transfer path doesn't allocate (one response queue). Each
model build is a power-up: `formatFat32` (an MBR partition at 4 MiB, 32 KiB clusters, FSInfo,
label BENCHTOP), then the `files` prop's files (JSON path → text or `{ "b64" }`, 256 KB; what
can't go on reports `sd-card-files`). A bench reset resets the card's SPI state only — files
stay, as on a real card. `inserted` (prop; a `value` input while running) empties the socket:
MISO reads 0xFF and the card needs CMD0 again; CD is grounded while a card is in (the common
breakout), open otherwise. `fat.ts` is a small FAT library (mount an MBR's first partition or a
bare volume, list, read, write with 8.3 names, NT lower-case flags or long-name entries, make
directories, remove recursively, FSInfo kept; formats FAT32). It mounts and writes FAT12 too — a
volume under 4,085 clusters, its 12-bit entries packed 1.5 bytes each (the low 12 bits at byte
n·1.5 for an even cluster, the high 12 for an odd one), an entry straddling two FAT sectors when
it starts at byte 511, end of chain ≥ 0xFF8 — what small disks use (Arduino's USBMSC RAM disk). **Part storage** (core
`bench/storage.ts`, not a contract): a model may carry `storage` — `PartStorage`: `version`,
`list`, `read`, `write`, `remove` — and `bench.storage(partId)` returns it; the card's mounts the
FAT afresh each call, since firmware changes the blocks under it. For a board, it is the USB
drive its host mounted (an ESP32-S3's USB-OTG port), when its MCU has one. DO rests high through the
module's pull-up (a weak drive: the SD spec asks for one on DAT0), so MISO isn't a floating input.
Real firmware (`sd-log` for each board): the Uno's SD library, the ESP32 core's SD library
(FatFs over its own SPI driver, CRC on) and arduino-pico's (SdFat) list, read, append, make
directories and write long names on it, unchanged — the boards' SPI models needed nothing.
The gallery's Storage category has an SD datalogger (an Uno logging a potentiometer).

### Problems

Sources, all gathered by `Bench.problems()` (one problem per code and sorted part set; the newest
message wins; codes, titles and hints in `packages/core/src/check/codes.ts`):
- **Build** (recomputed with every bench, i.e. on any topology or prop change): unknown types,
  unresolved wires, missing MCUs, bad definitions, part-model errors, unattached bus devices,
  `i2c-address-conflict`, `analog-island-too-large`, and the static checks
  (`check/static.ts`): `esp32-overvoltage` (a header pin's net holds a supply above the MCU's
  maximum input), `unpowered-part` (all power pins, or all ground pins, unconnected — a module
  with 3V3 and VIN needs one), `unconnected-pins` (info, per wired part, its unused digital and
  analog pins) and `unwired-part` (info, a part with no connection, nothing else reported).
- **Live** (recomputed, gone when fixed): resolver conflicts — `drive-fight` when the net holds a
  supply (an output wired to 5V/GND), `short` between outputs —, oscillations, stopped MCUs, and
  the dynamic checks (`check/dynamic.ts`), run every 10 ms of simulated time on a bench timer:
  `floating-input` (an INPUT pin, no pull, wired to another part — a breadboard alone doesn't
  count: a Nano's unused pins sit in strips —, floating for two checks with no mode change
  between them), `esp32-overvoltage` (an ESP32 pin's net above 3.6 V),
  `pin-overcurrent` (a pin driving its net — output, peripheral or DAC — with more than its
  absolute maximum, 40 mA on all three MCUs, computed as (drive − net volts)/25 Ω on nets the
  analog layer solves; held for 1 s after the last check that saw it, so blinking and PWM pins
  stay reported), `port-overcurrent` (warning: the same per-pin currents summed per board by
  the AVR pin groups that share supply pins, sourcing and sinking apart, each MCU pin once per
  net, against the datasheet's group limit — `check/port-groups.ts`: ATmega328P 150 mA out /
  100 mA in, ATmega2560 200 or 100 mA; past it the datasheet only says V_OH/V_OL may leave
  spec, hence a warning; it names the pins carrying ≥ 1 mA and the group, held 1 s like a pin's;
  no ESP32 groups), `unpowered-part` (a wired power or ground net with no driver) and
  `pin-reserved` (warning: a board pin whose MCU pin the board's module holds, wired to another
  part — a breadboard alone doesn't count). An MCU says which pins its module holds through
  `pinClaims()` (`bench/claims.ts`: `PinClaims`, found by `usesPinClaims` as `usesSleep` finds
  `sleepState`; not a contract): the ESP32's GPIO16/17 for a WROVER-E (also the DevKit V1's
  RX2/TX2, Serial2's default pins), the S3's GPIO33–37 for an N8R8 (the DevKitC-1's IO35–37), and
  on `auto` the same pins once a build's PSRAM is running. The pins keep working: the warning says
  what a board would do.
- **Reported by parts** (`ctx.report`): sticky until reset or a rebuild, except that a
  report with an empty message withdraws it (how `led-overcurrent` clears while the current is
  low; the contract has no clear call). Analog reports (`analog-undefined-level`,
  `analog-no-convergence`) follow the same rule.

The worker sends `{ type: 'problems', list, counts }` only when the set changes (also after a
reload); the Problems tab sorts by severity and shows each code's title and hint, and clicking a
row selects its parts and frames them (`frameWorldRect` on the canvas); the status bar shows the
error and warning counts.

### Sound both ways

**Out — the speaker** (`packages/parts/src/actuators/speaker.ts`, pins 1 + / 2 −, no load).
Its model turns V(1) − V(2) — net volts, so a digital pin's 0/5 V and a DAC's volts alike —
into a 22,050 Hz stream of simulated time: a one-pole 8 kHz low-pass (the cone's own
filtering) solved exactly for the piecewise-constant drive between edges, and each sample the
filter's output averaged over its sample period (the integral, exact), so a 62.5 kHz PWM
carrier is gone while PWM-DAC audio survives. Samples fill a preallocated ring in 1,024-sample
blocks; a timer at each block's end completes it and invalidates the part, and `visual()`
hands out every whole block since the last frame (`audio`, plus `audioT`: each block's start
in ns). A block with no edge and a settled filter stops the timer (a DC level is silence); the
next edge starts a new run, so an idle speaker costs nothing and the start times jump the
gap. Per edge: O(1) plus a step per sample boundary, no allocation. The audio blocks are a
stream: the session never puts a visual with `audio` in the frame ring (which keeps only the
latest state) — they always travel in frame messages.

The UI (`apps/web/src/ui/audio/`): `speakers.ts` sends each speaker's blocks (unmuted only) to
its own `benchtop-speaker` AudioWorklet node (`speaker-worklet.ts` → `stream-player.ts`): a
DC blocker (20 Hz) and fixed gain, a ~100 ms jitter buffer, linear resampling to the context's
rate. A run ends (`end`) when start times don't follow on or the speaker reports `playing:
false` — it plays out, silently, without counting underruns; a buffer that runs dry mid-run is
an underrun (the bench below real time), counted by the worklet and shown as "audio behind" in
the status bar for 1.5 s; more than 400 ms waiting (the bench ahead of real time) drops the
oldest input. Pausing, muting or reloading removes the nodes. Checked live: the worklet's output
peaks at 439, 521, 662 Hz through speaker-melody, then silence.

**In — the microphone** (`packages/parts/src/sensors/microphone.ts`, a MAX4466-style module:
OUT, GND, VCC). OUT = the supply's midpoint + `gain` (volts per full-scale sample, default 1)
· sample, clamped to the rails, a strong source following its own supply. Samples (−1…1) come
as `{ kind: 'value' }` inputs, one per sample (no contract change: a sensor reading in its own
unit), into a queue played at 16 kHz of simulated time; the queue keeps at most 200 ms (older
input `dropped`; an empty queue holds silence, `starved`), and the output timer runs only
while samples flow (it stops after 100 ms of none). The UI side (`ui/audio/mic.ts`) captures
only after the user clicks the part's **Use microphone** (Inspector), with getUserMedia (echo
cancellation, noise suppression and auto gain off); the `benchtop-mic` worklet
(`mic-worklet.ts` → `downsampler.ts`) averages down to 16 kHz and posts 512-sample blocks,
which go to the worker as `audioIn` (protocol 9) — the session feeds them to the part as
`value` inputs. **Privacy:** nothing is recorded, stored or uploaded; each block is transferred
and forgotten; pausing, stopping the run, reloading or leaving the page stops the tracks (the
browser's indicator goes off); a denied, missing or busy device is a "Microphone" row in the
Problems tab, never an exception.

**Tests** (`packages/parts/src/integration/audio-circuits.test.ts`, a small Hann-windowed DFT in
`spectrum.test-helper.ts`): speaker-melody's three 200 ms windows peak within ±2 Hz of what
tone() makes — 440.14, 523.01 and 661.38 Hz, Timer2's integer divider (Tone.cpp), not the
nominal 659; pcm-playback (8 kHz samples into Timer2's 62.5 kHz fast PWM) comes out at 1,000 Hz
with THD over harmonics 2–5 ≈ 2 % (< 10 %) — the 8 kHz sampling's own images at 7 and 9 kHz
(≈ 9 % and 5 %, as on the chip) are left out of that THD; the ESP32's DAC; the microphone into
an Uno's A0 and an ESP32's GPIO34 reading 440 ±10 Hz; the microphone's queue rules. The
player and downsampler have Node tests (`stream-player.test.ts`).

### Environment

A small, deterministic world in the worker feeds the sensors what the room holds at their bench
position (`packages/core/src/env/`). It exists only when the document has a part whose
`envSpecFor` role is `ambient` (the bench takes `BenchOptions.envSpecFor`, like
`analogSpecFor`; `@benchtop/parts` provides it), so nothing changes for other circuits and no
contract changed: the ambient conditions are that part's props, sources and bodies are ordinary
parts, and sensors get values through the inputs they already take.

- **Roles** (`env/spec.ts`): `ambient` (temperature °C, humidity %RH, light lux, sound dB, gas
  ppm baseline, ventilation ACH, mixing m²/s, the room's floor `roomWidth` × `roomDepth` m, the
  mixing `layer` m, `heatLoss` 1/s, `scale` = room mm per bench mm, `overlay`), `source` (gas
  leak L/min, heater W, flame strength, lamp lm, sound dB at 1 m, fan m³/min; optionally an
  IN/GND control pair), `body` (a warm circle — a person — or a box, with a patrol) and `sensor`
  (samples: a field, how to deliver it — `value`, a `set:<channel>=` channel, or `press-while` —
  a unit map and an epsilon; an optional cone). A sensor with prop `followEnvironment: false`
  is left to its own props and inputs.
- **Space:** room metres = bench mm × `scale` / 1000, y down like the bench. A part's position
  is its centre; a sensor faces its local −y turned with the part's rotation (rotation 0: up on
  the screen). The room's floor is centred on the parts and grown to hold them all 25 cm from
  its walls; the grids cover it with 64 cells along the longer side (cells ≥ 5 cm).
- **Grids** (`grid.ts`): gas (ppm above the baseline) and heat (°C above the ambient) on a 2D
  grid: explicit 5-point diffusion with closed walls (no flux leaves the room, so a field's
  total is conserved without decay), substeps keeping D·h/dx² ≤ 0.2, sources added per second,
  decay as exp(−k·h) per substep (ventilation ACH/3600; heat adds `heatLoss`), a fan's sink over
  the cells within 0.5 m of it (the grids have no air currents, so a fan draws from a
  disc — `flow` m³/min shared over those cells' volume). A leak of r L/min adds r/60 000/V × 10⁶ ppm/s to its cell column V = cell² ×
  layer; a heater P/(1200·V) °C/s (ρ·cp of air); a flame 80 W and 12 lm per unit of strength (a
  candle). The 2D grid stands for the occupied air layer: the `layer` (0.3 m by default) is how
  far a source's gas or warm air spreads vertically near it. A grid with nothing in it and
  nothing feeding it isn't stepped.
- **Closed forms** (`world.ts`): light = ambient + Σ lm/(4πr²) (r ≥ 5 cm, no occlusion); sound =
  10·log₁₀ of the ambient's and every source's energy, each L₁ − 20·log₁₀ r (r ≥ 10 cm);
  humidity = the ambient's absolute humidity at the local temperature (Magnus); flame infrared
  = Σ strength·(0.2 m / r)² over flames inside the sensor's cone, at most 1.
- **Bodies** (`bodies.ts`, `cone.ts`): a body's position is a pure function of the time it has
  walked (paused at each end of its patrol), which advances only while it walks, so a replay
  lands on the same positions. Distance sensors get the exact nearest point of any body inside
  their cone (convexity: the shape's own nearest point if it's inside the wedge, else a hit on
  one of the wedge's edge rays); a PIR gets a press every period while a warm body walks inside
  its cone.
- **On the bench** (`runtime.ts`): every 50 ms of simulated time (`ENV_PERIOD_NS`, a bench
  timer) sources read their wired control inputs (on above 1.5 V across IN–GND), the world
  steps and each sensor's samples are delivered — only when they moved by more than the
  sample's epsilon, so an analog island isn't re-solved for nothing. Inputs to the ambient part,
  a source or a body go to the world (`set:<param>=<v>`, `set:on=0|1`, press/release), not to a
  model. A reset rebuilds the world and delivers every sensor's starting values at t = 0.
  `collectFrame` adds the world's visuals: a body's offset from its document position in bench
  mm, a source's `on`, and — at most every 250 ms while the overlay is on — the ambient part's
  heatmap (`hm`: one byte per cell on fixed scales, packed four to a number like the SSD1306's
  framebuffer, with its origin and cell size in bench mm). `bench.envSample(part, field)` reads a
  point field at a part (the CLI's `env` expectations). A second ambient part is an
  `environment-duplicate` warning. Cost: a 4 × 3 m room with a leak and a heater (two 64 × 48
  grids, 4 substeps a period) and 20 sensors take ≈ 3–4 ms per simulated second in Node.
- **The parts** (`packages/parts/src/environment/`): `environment` (the room: the
  ambient props above, `overlay` off/gas/temperature/light/sound), and pinless sources and
  bodies — `gas-leak` (rate L/min), `flame` (strength), `sound-source` (dB at 1 m), `person`
  (a 0.4 m warm circle) and `object` (width × depth cm), the last two with a patrol (`toX`/`toY`
  bench mm, `speed` m/s, `pause` s) — plus `heater` (W), `lamp` (lm) and `fan` (m³/min), which
  carry an IN/GND control pair: wired, IN decides (on above 1.5 V); unwired, their `on` prop and
  inputs do (and they aren't reported as unwired parts). `envSpecFor` (`environment/specs.ts`)
  also gives every sensor's samples: MQ-2 ppm (value), flame IR (value; ±30°, 1.5 m, looking
  left from the module's IR end), DHT22 temperature/humidity (channels), NTC °C and LDR lux
  (values), the sound modules' level (dB − 40)/60 (value), PIR motion (press-while; ±55°, 7 m),
  HC-SR04 distance in cm (channel; ±15°, 4 m; 0 = nothing in range) and the MPU-6050's
  temperature (channel `temp`). Cones look up the screen unless noted, turned with the part.
- **UI**: views of our own (`apps/web/src/views/environment.ts`: the room badge, a gas
  valve, a heater grille, a candle, a bulb, a speaker, a fan whose rotor spins while on, a
  person from above, a box) that glow while on; bodies move by their visual offset and are
  drawn at their room size. The room badge's view passes the heatmap to
  `editor/heatmap.ts`, and `editor/EnvironmentLayer.tsx` paints it under the parts — one canvas
  pixel per cell, scaled up smoothly to the grid's bench-mm rectangle, at 35 % opacity, on a
  fixed blue → red scale that is transparent at the field's floor — and, for the selected parts,
  a sensor's cone and a body's patrol line. Inspector (`views/controls.ts`): the room's ambient
  sliders and its Heatmap select, each source's level and an on/off toggle, a body's speed and
  walking toggle — stopped they edit props, running they send channel inputs (`set:<prop>=<v>`).
  A sensor that follows the room shows "Set by the environment" and a checkbox that sets
  `followEnvironment: false`.

### Virtual network

Boards with WiFi talk over a network the bench simulates (`packages/core/src/net/`), at the level
of Ethernet II frames — what lwIP hands the WiFi driver and gets from it. It is built like the
environment: `BenchOptions.netSpecFor(type, props)` (`@benchtop/parts`' `netSpecFor`) names the
parts with a network role, and the bench builds a `NetRuntime` from them. Not a contract: an MCU
with WiFi says so with `joinWifi(radio)` (`WifiStation`, duck-typed like `useSymbols`), and the
bench calls it for every MCU whenever it builds (null without `netSpecFor`).

- **Access points** (`wifi-ap`, the Network category): a part with no pins. Props: `ssid`,
  `password`, `security` (open, wep, wpa, wpa2, wpa-wpa2, wpa3, wpa2-wpa3 — a WPA key of 8–63
  characters, else the AP runs open, as a router refuses the key), `channel` 1–13, `rssi` (dBm),
  `hidden`, `on`. Running, `set:on=0|1` (or press/release) switches it and `set:rssi=<dBm>`
  changes the signal the next scan reports; the Inspector has a Power toggle and a signal slider.
  Each AP has a LAN of its own and a gateway on it: an `IpHost` at 192.168.4.1/24 whose MAC is the
  AP's BSSID (a locally administered MAC hashed from the part id, so it survives rebuilds), with
  the DHCP server (`dhcp.ts`: pool .2–.254 in order of first DISCOVER, kept per client MAC for
  the bench's life, 2-hour leases; router and DNS = the gateway; replies broadcast unless the
  client has its address). Its view (`views/network.ts`) is our own drawing of a home router:
  SSID, security, power and WiFi LEDs, the station count and the first client's lease.
- **The LAN** (`lan.ts`) switches frames by destination MAC (group addresses to every other
  port) through the bench's scheduler. A frame's airtime is 100 µs plus its bits at 54 Mb/s; a
  station transmits one frame at a time and the AP relays to stations one at a time, so a
  station's frame reaches the gateway after one airtime and another station after two, and
  frames between two ports never reorder. No loss. A port that left gets nothing still in the
  air.
- **Hosts** (`host.ts`): ARP (answering for their address, learning every sender), ICMP echo,
  UDP by port, TCP; sending asks ARP first when the neighbour is unknown (8 packets wait,
  more drop). Packets are parsed defensively (`packet.ts`: lengths, header checksums, UDP and TCP
  checksums over the pseudo-header; fragments are dropped).
- **TCP** (`tcp.ts`): the part of RFC 9293 a lossless, in-order link needs — active and
  passive open, data both ways in segments of the peer's MSS (its SYN's option, 536 without, at
  most 1460) within the window it advertises (lwIP on an ESP32: 5744 bytes), ACKs at once with a
  65535-byte window (data is delivered as it comes), FIN from either side and the states between,
  RST for a segment no connection or listener wants. A station can still drop a frame (its
  driver's queue, lwIP out of buffers), so unacknowledged data, an unanswered SYN or FIN go
  again after 1 s (go-back-N from the oldest byte), five times before a reset. No other options,
  no urgent data, no TIME_WAIT (nothing stray arrives late on this LAN). Ephemeral ports from 49152.
- **DNS** (`dns.ts`): the gateway answers UDP 53 — an A question for a name on its LAN (a
  server part's `hostname`, a station's DHCP hostname, "gateway") with its address (TTL 60 s), a
  known name of another type with no answer, anything else NXDOMAIN (no recursion: the bench has
  no internet). Names compare without case and without a trailing dot.
- **HTTP servers** (`http.ts`, the `http-server` part): a host on the LAN of the AP whose
  SSID is `network` (the first AP when empty) at `address` (or the next free one from
  192.168.4.10 — explicit ones are placed first, and the DHCP pool skips them), `hostname` in the
  DNS, `port`. Its `routes` prop is text, a route a line: `METHOD /path STATUS [type [body]]`
  (METHOD may be `*`, a path ending in `*` matches a prefix; `\n` in a body is a newline;
  {{method}} {{path}} {{query}} {{body}} {{client}} {{count}} {{time}} are filled per request).
  The first matching route answers; a path known with another method is 405, an unknown one 404;
  HEAD gets no body. Requests are HTTP/1.0–1.1 with Content-Length bodies (chunked: 411; headers
  over 8 KB: 431; bodies over 64 KB: 413); every response closes the connection. The server logs
  the last 200 requests (`http.log`). Its view (`views/network.ts`) is a small server box: the
  hostname, `address:port`, the request count and the last three requests. A server whose AP
  isn't there is `net-no-access-point`, an address off the subnet or taken `net-bad-address`
  (it takes the next free one), route lines that don't parse `http-routes` — all warnings. The
  Inspector edits multi-line text props (the routes) in a text area. `httpRequest(host, ip, port,
  …)` is the matching client the bench's own tools use.
- **HTTP clients** (the `http-client` part): a host on the LAN like a server (`network`,
  the next free address from 192.168.4.10 — servers and clients share the range) that sends one
  request — `method`, `url` (`http://host[:port]/path?query`: a name the AP resolves, i.e. a
  server part's hostname or a station's DHCP hostname, or an address; `parseHttpUrl`), `body` —
  each time it is pressed (the Inspector's Send) and every `interval` ms while that is above 0
  (at least 50 ms; the timer starts with time at a reset, or at a carried build, and a
  generation counter retires an old one). One request at a time: a press while one is in
  flight is ignored. Its view (`views/network.ts`) is a small laptop: the request, the last
  status (green 2xx, amber others, red an error — an unknown host, refused, timed out, https)
  and the body's start; the base line names its `network` when one is set ("press Send ·
  esp32-ap"), since on a board's soft AP that is what it waits for. A URL it can't send to is
  `http-url` (warning).
- **Stations** see `radio.accessPoints()` (the APs that are on) and `radio.join(bssid, mac,
  receive, lost)` puts them on an AP's LAN; `lost` runs when the AP goes off (or away in a
  rebuild). Each MCU gets `radioFor(board)`, so its station is filed under the board's
  part id. A rebuild hands kept MCUs the new radio: an association moves to the same
  AP's new LAN silently, and the new network keeps the APs' leases and on/off states; a bench
  reset forgets both. `bench.network` exposes the runtime (its APs, LANs, gateways, leases).
- **What happened**: `net.listen(fn)` reports `connected` (a board's station got its
  address: the DHCP server acknowledged a REQUEST — `DhcpServer.onack`; a renewal of the same
  address says nothing), `disconnected` (it left, or the AP went off), `served` (a server part's
  answer: method, path, query, status, client) and `got` (a client part's response: status or
  error, body) with bench times — what the runner's `wifi` and `http` assertions read.
  `net.stations()` lists who is on which LAN (board, MAC, lease, hostname, since);
  `net.request(network, method, url, body, headers, done)` sends from an AP's gateway — the MCP
  server's `sim_http`.
- **The real network** (`uplink.ts`). Off unless both sides opt in: the project — the
  AP's `internet` prop and its `allow` list (`host:port` entries a line or a comma apart; a DNS
  name or an IPv4 address, the port required, no wildcards, at most 32: `parseAllowList`) — and
  the user who started the host: `BenchOptions.uplink` comes only from the bridge (`npm run
  bridge -- --network …`, the browser) or the CLI (`--network …` on run, test, mcp), each with a
  list of its own; the bench reaches what both name. With `internet` on, the gateway's DNS
  answers each allowed name with an address from 198.18.0.0/15 (RFC 2544's benchmarking block:
  never routed, so it can't shadow a real one), and the gateway (`IpHost.outside`) takes TCP to
  those addresses and to allowed IPv4 addresses as a transparent proxy: a station's SYN asks
  the uplink to `connect(host, port)` and the SYN-ACK goes only once it `opened` (a repeated SYN
  meanwhile is ignored); a refusal — the bridge's or the far end's — is an RST, as from the real
  server, and a `net-internet` problem on the AP (`liveProblems`, newest per AP, until a reset).
  Bytes go both ways as they come; the station's FIN half-closes the real socket (`end`), the
  far end's close FINs the station. Server and client parts route off-subnet traffic through
  the gateway (`IpHost.router`), so an `http-client` part reaches an allowed host too; its `Host`
  header names the URL's host. UDP and ICMP never leave. A synchronous uplink (the CLI's) has a
  `pump(now)` the runtime calls every simulated millisecond while a socket is open. Build
  problems: `net-allow` (lines that aren't host:port, or none), `net-no-uplink` (the CLI ran
  without `--network`). The AP's visual `internet` is off, on, busy (a connection out) or error;
  its view's NET light follows it.
- **Time** (`sntp.ts`). The AP's `clock` prop — 'wall' (the default), an ISO date-time,
  or 'off' — makes its gateway an SNTP server (RFC 4330 client/server mode on UDP 123: a mode-3
  request of 48 bytes or more gets mode 4, stratum 2, its transmit timestamp back as originate —
  what lwIP's SNTP client checks — and receive/transmit = the clock now) and the DNS answer for
  pool.ntp.org (and its subdomains), time.google.com, time.cloudflare.com, time.nist.gov,
  time.windows.com and time.apple.com. The clock is bench time plus a base: 'wall' takes the
  host's clock when the bench resets (a rebuild keeps the base), a date pins the bench's start
  to it (deterministic tests), and a value that is neither is `net-clock` (warning; the host's
  clock). So `configTime(0, 0, "pool.ntp.org")` works with nothing leaving the machine: the
  ntp-clock fixture prints its first time ≈ 3 s into a run (WiFi at 1.6 s, then lwIP's SNTP), one
  second apart after.
- **Soft access points.** A board's radio can host an access point while its firmware runs
  one: `WifiRadio.hostAp(config, bssid, { receive, joined, left })` (radio.ts; optional, so test
  radios needn't) makes a `SoftAp` (runtime.ts) — a LAN whose other end is the board's AP
  interface (a wired port with the board's AP MAC) and no gateway of ours: the board's own network
  stack routes and serves DHCP. Other boards' scans list it (the host's own don't; RSSI −45 dBm),
  their stations join it (`join` finds soft APs by BSSID; `maxStations` turns more away), and the
  board hears each `joined`/`left` (its driver's AP_STACONNECTED/STADISCONNECTED). The runtime reads
  DHCP on that LAN — stations' requests (hostnames), the board's ACKs (addresses) — for
  `stations()`, the connected events (a board station's lease) and names; a station leaving or the
  AP closing (the firmware's stop, a reset, a rebuild — the firmware hosts it again) gives the
  disconnected events, a station dropped hears its `lost`. A client part whose `network` names an
  SSID no AP part has waits for a board to host it ("waiting for …" in its view; no build problem),
  joins as a station when one does, takes an address with `DhcpClient` (dhcp.ts: DISCOVER, OFFER,
  REQUEST, ACK, broadcast with the broadcast flag, retried every second, no renewal) — `IpHost` can
  start without an address and takes every UDP datagram until it has one — and reaches the board by
  address, its stations by DHCP hostname, the board as "gateway"; when the AP goes it waits again.
  The board's side also has `drop(mac)` (a deauthentication: `left` follows, the station
  hears `lost`), and its events a `closed()` for an AP the bench closed (a reset; a rebuild
  without the board) rather than the board. A rebuild keeps soft APs: `carry()` disposes the old
  runtime without closing them, the next `build(previous)` takes them over with their stations
  and DHCP view, and the bench then closes those whose board didn't come over running
  (`keepSoftAps(keptBoards)`). A client part on one takes over its previous self's host, station
  and lease (`ClientHost.adopt`); one new to it joins, one gone leaves. A station already on a soft
  AP that joins again with the same MAC (a kept board moving to the new radio: the ESP32 driver
  joins there before leaving the old link) takes its new port silently, keeping its address — so
  nobody on the LAN hears anything of the edit.

Measured: an ESP32 running `fixtures/sketches/esp32/wifi-ping` (WiFi.begin, DHCP, four pings of
the gateway with IDF's esp_ping) prints its four replies 0–1 ms each; 6 s simulated take 1.1 s.
`wifi-http-get`: Arduino's HTTPClient resolves `api.bench` at the gateway and GETs and POSTs
to the http-server part through lwIP's TCP and ours. Also running: `wifi-webserver` (Arduino's
WebServer as "esp32-web": the board connects at 1.61 s and answers an http-client part within
8 ms, switching its LED), and `wifi-tcp-server` + `wifi-tcp-client` on two ESP32s (the client
finds "echo-server" through the gateway's DNS and gets its line back in capitals 22 ms after
both connected). The gallery's WiFi category runs all three (and an ESP32-C3 web server,
`wifi-rgb-server`, whose `/led?color=…` sets the board's RGB LED; and an ESP32 access point web
server, `esp32/softap-webserver`: the board hosts "esp32-ap" with no AP part on the bench, the two
client parts take 192.168.4.2 and .3 from its DHCP server within 1.5 s and switch its LED at
192.168.4.1); the web gives an example its
`.syms.tsv` (`debugSyms`, see Worker protocol), since a precompiled `.bin` has no ELF.

### MCUs

The contract is `packages/core/src/contracts/mcu.ts`. An `Mcu` exposes its `clockHz` (the
constant rate its `cycles` counter advances at), firmware loading (`FirmwareImage`: HEX text,
ELF bytes, an ESP32 app image, a UF2 or a MicroPython sketch
`{ format: 'micropython', files, main }` the board's stock interpreter runs), `reset()`, `runUntil(targetCycles)`, its pins as `McuPin`s
(mode, output level, optionally `outputVolts()` — an analog output such as a DAC, which the bench
drives at strong strength — `setInput(NetState)`
from the bench, `onOutputChange` fired synchronously from inside the run) and its UART, I2C and
SPI peripherals. A board part's `BoardSpec` names the
MCU kind and maps header pins (`13`, `A0`, `GPIO2`) to MCU pin ids (`PB5`, `PC0`, `GPIO2`).

**Non-volatile memory.** A board's EEPROM or flash behaves as the chip's: every reset
keeps it — the board's (`Bench.resetBoard(id)`: one MCU reset, its clock restarted at bench time,
the rest of the bench running on), the bench's and the firmware's own restart — and a firmware
load writes only what an upload writes: on the ESP32 and C3 the partition table and the app
(their sectors erased first) and, on a new image, the OTA data partition (esptool's
boot_app0.bin), leaving NVS, SPIFFS/LittleFS and the EEPROM library's partition — `directBoot`
writes into the board's flash (`FlashTarget`) instead of building a fresh one each reset; on the Picos the image's 4 KB
sectors (erased, then programmed, as a UF2 copy does), leaving EEPROM emulation and LittleFS; on
the AVRs program flash only (an Arduino upload through the bootloader leaves EEPROM). A
MicroPython sketch's interpreter still starts on erased flash every run. MCUs opt in with
`nonVolatile()` (`bench/nonvolatile.ts`, found by `usesNonVolatile`; not a contract):
`NvMemory` — kind (`eeprom` or `flash`), size, sector size (4 KB; 256 bytes for EEPROM), a
`snapshot()` of the data sectors that aren't erased (0xFF), `restore(sectors)` (every data sector
erased, then the sectors put back — untrusted: off the memory, misaligned, mis-sized or over the
program, skipped), `erase()` and `read()`. `SectorMemory` implements it over the MCU's array;
program sectors — those any load wrote since the memory was made — aren't data: snapshots leave
them out, restore and erase leave them alone. A boot counter on each board
(`fixtures/sketches/{uno,pico}/eeprom-counter`, `{esp32,esp32c3}/prefs-counter`, the Pico 2's
`eeprom`) counts on across a board reset, a bench reset, a reload and `ESP.restart()`, through a
snapshot restored on a fresh bench, and from 1 after an erase
(`packages/parts/src/integration/nonvolatile.test.ts`).

I2C and SPI are **transaction-level** (`packages/core/src/contracts/bus.ts`): an MCU's
`I2cController` / `SpiController` calls attached `I2cDevice` / `SpiDevice` part models byte by
byte; there are no bit-level SDA/SCL edges. The bench attaches a device to the controller whose
current pins share nets with the device's pins.

Firmware files are untrusted input, parsed in `packages/core/src/firmware/`:
`parseIntelHex(text, { maxBytes })` (record types 00–05, checksums, errors with the 1-based
line; a dense image from address 0 with 0xFF in the gaps, plus the used ranges) and
`parseElf32(bytes)` (little-endian ELF32: PT_LOAD segments, sections and `.symtab` symbols as
views into the input, every offset bounds-checked; `EM_AVR` 83, `EM_XTENSA` 94). On AVR, flash
bytes are the PT_LOAD segments with paddr < 0x8000 placed at paddr — `.data`'s initial values
sit in flash after `.text` while its vaddr is 0x800100+.

- **AVR adapter** — `AvrMcu` (`packages/avr/src/avr-mcu.ts`) is the one AVR `Mcu`; a
  chip is a table (`AvrChip`: flash/SRAM/EEPROM sizes, ports, and each timer's, USART's, SPI's,
  TWI's, ADC's, EEPROM's and watchdog's avr8js register/vector config, plus its ADC and USART
  pins). `atmega328p.ts` and `atmega2560.ts` are those tables; everything below about pins,
  inputs, UARTs, I2C/SPI, reset and breakpoints holds for both.
- **Uno** — `createAtmega328p()` (`packages/avr/src/atmega328p.ts`) wraps avr8js 0.21.1: CPU
  (32 KiB flash, 2 KiB SRAM), ports B/C/D, timers 0/1/2, USART0, SPI, TWI, ADC, EEPROM (1 KiB,
  kept across resets and loads), watchdog and clock. Pins are `PB0`–`PB7`, `PC0`–`PC6`,
  `PD0`–`PD7`, plus `ADC6`/`ADC7` (the TQFP package's analog-only inputs, the Nano's
  A6/A7 — no port bit and no digital buffer, so they feed the ADC and never drive; the Uno's
  pin map names neither); a port pin's mode comes from DDR/PORT via avr8js's `pinState()` (so timer PWM shows),
  and PD1 reports `peripheral` (idle high) while the USART transmitter is enabled, because avr8js
  never drives it. `setInput` applies VIH 3.0 V / VIL 1.5 V with hysteresis, floating nets read
  as the last level, and PC0–PC5 feed the ADC their volts. UART bytes the bench sends arrive one
  per character time at the configured baud (lost while RX is disabled); I2C transactions go to
  the attached `I2cDevice` whose address matches at each START (NACK when none); SPI bytes go to
  the device whose `selected()` is true (the bench's bus), bit-reversed while DORD is set. `reset()` rebuilds the CPU and peripherals but keeps
  every pin, UART, I2C and SPI object, so the bench's listeners survive. Without firmware,
  `runUntil` returns `halted`. `avrMcuFactory(board)` is the bench's factory for
  `mcu: 'atmega328p'`. Firmware: Intel HEX (`sketch.ino.hex` from Arduino IDE *Export Compiled
  Binary*) or ELF (adds symbols for the debugger). Speed: ~16–30 simulated MHz in Node on the dev
  machine (avr8js's own ceiling; the adapter adds no measurable cost). **Timer fix**
  (`timer-fix.ts`): avr8js counts its timers lazily, several counts per step; when a step wraps
  past TOP and also reaches OCRnx again, it applies that compare match before the BOTTOM set, so
  in fast PWM a small OCR (OCR2B = 1 at prescaler 1: a 2-cycle pulse on the chip) leaves the
  output high for the whole period — PCM through PWM came out as noise. Each timer's step is
  wrapped so that, in fast PWM, a BOTTOM set after the same step's new-period match (against
  the OCR latched at BOTTOM) is skipped: the output ends where the chip's would; the pulse itself
  has no width. Cost: ~1.5 % on blink.
- **Nano** — the same `createAtmega328p()` behind `arduino-nano`, a board part with the
  Nano pinout (two 15-pin headers 0.6" apart, so it straddles a breadboard's channel; the
  element's upward-facing ICSP pins are left out, since every pin touches what lies under it).
  The FQBN is per board, not per MCU (`apps/web/src/editor/fqbn.ts`: the Nano compiles with
  `arduino:avr:nano`, whose `eightanaloginputs` variant defines A6/A7). The Uno and Nano share
  their onboard-LED model (`packages/parts/src/boards/arduino-leds.ts`).
- **ATmega2560** — `createAtmega2560()`
  (`packages/avr/src/atmega2560.ts`), `mcu: 'atmega2560'` (an additive contract change:
  the kind unions in `contracts/part.ts` and `contracts/mcu.ts`). avr8js runs the core
  as is: 256 KiB flash turns on its 22-bit PC (3-byte return addresses, EIND for EICALL/EIJMP,
  RAMPZ for ELPM), and its interrupt queue already has room for 57 vectors. The table supplies the
  rest from the datasheet, cross-checked against avr-libc's `iomxx0_1.h`: ports A–L (86 pins; G
  has 6), timers 0/2 (8-bit) and 1/3/4/5 (16-bit, channels A/B/C) with the 2560's vectors and
  OCnx pins, USART0–3 (TX/RX PE1/PE0, PD3/PD2, PH1/PH0, PJ1/PJ0), INT0–3 on PD0–3 (EICRA) and
  INT4–7 on PE4–7 (EICRB), PCINT0 on port B, PCINT1 on PE0 + PJ0–6, PCINT2 on port K, a
  16-channel ADC (ADC0–7 on PF0–7, ADC8–15 on PK0–7 through ADCSRB.MUX5), 8 KiB SRAM to RAMEND
  0x21FF (avr8js's data array is sized so SP starts there) and 4 KiB EEPROM. ELF flash is every
  PT_LOAD segment below 0x800000. The bench links up to four UARTs per MCU over wires (the ESP32
  has three). Fixtures (`fixtures/sketches/mega/`) cover blink, all four serial ports,
  PWM from timers 1/3/4 and a Timer5 interrupt, INT5/INT2/PCINT16, the 16 analog inputs, the
  EEPROM, and code past 128 KiB (`far-code`: 130 KB of tables in `.fini8` push a function in
  `.fini7` to 0x20504; it is called directly and through a linker trampoline, and the tables are
  read with ELPM).
- **Mega 2560** — the `arduino-mega` board part (`packages/parts/src/boards/arduino-mega.ts`):
  the element's 85 pins in px, converted; D0–D53 mapped to ports as the core's `mega` variant
  does, A0–A15 to PF0–7/PK0–7, SCL/SDA joined to D21/D20 by buses; the shared onboard-LED model;
  FQBN `arduino:avr:mega` (also on the compile bridge's allowlist). Gallery: a Mega category
  (chaser, serial ports, analog scanner).
**Debugging**. `packages/core/src/contracts/debug.ts` is an additive contract file:
an MCU that implements `Debuggable` returns an `McuDebug` with its registers
in a fixed order (AVR: R0–R31, SREG, SP, PC; `pcIndex`/`spIndex`), `readRegisters` into a
`Uint32Array`, `readMemory`/`writeMemory` over `flash`/`data`/`eeprom` with no side effects,
breakpoints, `step()` (exactly one instruction) and `instructionAt` (size, is-a-call). Addresses
are byte addresses everywhere; the AVR adapter (`packages/avr/src/debug.ts`) converts avr8js's
word PC at that boundary and reads `cpu.data`/`progBytes` directly (avr8js's `readData()` runs
peripheral hooks — reading UDR0 would consume a byte). avr8js ignores BREAK, so breakpoints are
a per-word `Uint8Array` the adapter checks before every instruction in a separate loop entered
only while one is set (0 breakpoints: 17.40 simulated MHz vs 17.41 for the plain loop; 1: 17.21).
A run stopping at one returns `breakpoint` with PC on it, and the next run executes that
instruction unchecked. The bench ends `runUntil` early on such a stop (`BenchRunResult`
`{ reason: 'breakpoint', board }`): bench time moves to that MCU's time, other MCUs keep where
their quantum took them. `bench.debugStep(board)` steps with the MCU as the running one (exact
edge times), then catches the bench up. `packages/core/src/debug/`: `stepOver` (a call runs to
a temporary breakpoint after it, hit with SP back at or above its value before the call, so
recursion is safe; its pieces drive the worker's non-blocking version), `SymbolTable` (FUNC and
OBJECT symbols; AVR data objects at 0x800000+ map to the data space; "main+0x14"; lookup that
ignores LTO clone suffixes `.constprop.N`, `.isra.N`, `.part.N`, `.lto_priv.N`, `.cold` and
finds a plain mangled C++ function by its identifier) and `resolveBreakpoint` (0x… address,
function, or file:line). `packages/core/src/firmware/dwarf-line.ts` parses `.debug_line` for
DWARF 2–5 (32-bit DWARF only) into packed typed arrays: v2–v4 headers, v5 entry formats
(string, line_strp, strp, udata, data1–16, block), standard opcodes 1–12 (fixed_advance_pc,
which the Arduino AVR ELFs use, is not scaled by min_inst_length), extended opcodes 1–4,
unknown opcodes skipped by length, every read bounds-checked, at most 1,000,000 rows.
`addressToLine` follows addr2line (the greatest row address ≤ the address in the sequence that
covers it, the last of equal rows) and matches `avr-addr2line` on every address of the
committed oracles; `lineToAddresses(fileSuffix, line)` gives the lowest is_stmt address per
sequence, files matched by basename or trailing path.

- **ESP32** — our own Xtensa LX6 dual-core emulator in TypeScript (`@benchtop/esp32`), running
  the real `.bin` firmware Arduino IDE builds. The real mask ROM (Espressif's
  `esp-rom-elfs`, Apache-2.0) is fetched once, on request, into a git-ignored cache. Boot
  skips the second-stage bootloader: Benchtop parses the app image, programs the flash cache
  MMU itself, and jumps to the entry point with both cores. Idle cores (`WAITI`) let the
  scheduler skip ahead, which is where most real-time speed comes from. WiFi/BT are out of v1.

  **Inputs.** Fixtures are built for `esp32:esp32:esp32` (core 2.0.17, ESP-IDF v4.4.7):
  serial-hello, blink and crc-bench commit the app `.bin`, the `.partitions.bin` and a
  `.syms.tsv` (nm of the full ELF, which isn't committed). DOM-free parsers in
  `packages/esp32/src/`: `parseEspImage` (header, extended header with chip id 0, segments
  each inside one region — DROM 0x3F400000–0x3F7FFFFF, DRAM 0x3FFAE000–0x3FFFFFFF, IRAM
  0x40070000–0x400BFFFF, IROM 0x400C2000–0x40BFFFFF, RTC fast/slow —, the 0xEF-XOR checksum
  at the end of the 16-byte padding, the appended SHA-256; errors come back as
  `{ ok: false, error: { code } }`), `parsePartitionTable` (0x50AA entries, the 0xEBEB MD5
  entry checked; `DEFAULT_PARTITIONS` is the Arduino default table) and `parseRomElf` (the
  ROM's SHF_ALLOC PROGBITS sections and symbols, through core's `parseElf32`), plus a pure-TS
  SHA-256 and MD5 (no `crypto` global without DOM) and a ustar reader. The ROM is
  `esp32_rev0_rom.elf` from esp-rom-elfs 20241011, pinned in `boot/rom-manifest.ts` (tarball
  and ELF SHA-256; the tarball must also match the release's published checksum asset),
  fetched by `npm run fetch:esp32-rom -- --yes` into `.cache/esp32-rom` (a ≈3.4 MB download
  that needs the explicit `--yes`); tests load it through `test-support/rom.test-helper.ts` and fail with
  instructions, never skip, when it's missing. For the CPU: Xtensa test programs
  (`fixtures/xtensa/*.S` → .bin + .lst, linked at 0x40080000) and objdump decode corpora
  (`fixtures/xtensa/corpus/`; the fetch script adds a ROM corpus to the cache).

  **CPU core (`packages/esp32/src/xtensa/`).** `isa-table.ts` lists every instruction
  this core's objdump knows (513: base ISA, density, MAC16, FPU, booleans, TLB/region ops and
  Espressif's TIE extensions) as `[mnemonic, length, mask, match, immediate kind, operands]`.
  `decode(b0, b1, b2, out)` writes a descriptor into a caller-owned `Int32Array` — op id
  (`OP.*`, or `OP_INVALID`), length (2 for op0 8–0xD, else 3), r/s/t, two immediates already
  sign-extended/scaled/mapped through B4CONST, and the raw PC-relative offset that
  `target(desc, pc)` turns into an address — with candidates bucketed by op0/op1/op2 and tried
  most specific first. `disasm` prints what objdump prints (immediates in decimal within
  ±255, else 0x-hex; targets as bare hex; special registers in the mnemonic; `b4:b5:b6:b7`
  groups); a differential test checks it against every corpus line, the ROM's included, where
  objdump's `lsi` for words that aren't LSI is the one tolerated (counted) difference.
  `XtensaCore` holds the 64 physical registers (aN = ar[(WINDOWBASE·4 + n) & 63]), PC and SAR,
  and runs one switch on the op id per instruction; ops it doesn't implement fault
  `unimplemented: <mnemonic>`. It reaches memory only through `XtensaBus` (read/write 8/16/32,
  `fetch` → three bytes packed in a number); unaligned accesses are performed as is
  (core-isa.h: no alignment exception, hardware handles them). Tests run fixture programs on a
  bare machine (128 KB IRAM at 0x40080000, 192 KB DRAM at 0x3FFB0000). Hot code copies imported
  names into module constants (vitest makes imported-name access a getter).

  **Windows, exceptions, interrupts.** The core follows the ISA RM's pseudocode for the
  Windowed Register Option: CALLn/CALLXn put n in a(4n)[31:30] and PS.CALLINC; ENTRY checks
  CALLINC quarters against WINDOWSTART, rotates and adjusts the stack; RETW/RETW.N return or,
  when the caller's WINDOWSTART bit is clear, raise the underflow of the caller's size; MOVSP
  raises Alloca (EXCCAUSE 5) when no caller frame is live. Before an instruction executes,
  WindowCheck compares the highest window quarter it names (r/s/t operands, plus the implicit
  a4/a8/a12 of CALL4/8/12) with the first quarter ahead that a live frame owns; touching it
  saves PS.OWB and EPC1, sets EXCM, rotates to that frame and jumps to OF4/OF8/OF12. The core
  never spills registers itself: the firmware's handlers (IDF's, the ROM's, or
  `fixtures/xtensa/vectors.inc` in tests) do, and return with RFWO/RFWU. Exceptions are XEA2:
  EXCCAUSE (+ EXCVADDR for bus errors), then EPC1 and the user (PS.UM = 1) or kernel vector
  with EXCM set — or, with EXCM already set, DEPC and the double vector (an exception at the
  double vector itself is a fault). RFE clears EXCM and returns to EPC1; RFDE returns to DEPC
  leaving PS alone; RFI n restores EPSn/EPCn. No MMU, so no rings and no Privileged cause.
  BREAK raises the debug exception (level 6, DEBUGCAUSE) unless `breakHook` claims it.
  Interrupts (`interrupts.ts`, levels and types from core-isa.h): INTERRUPT = latched bits
  (edge, software via INTSET/INTCLEAR, timers, the NMI) | level lines (`setInterruptLine`, for
  the interrupt matrix; `pulseInterrupt` for edges). At an instruction boundary the core takes the
  highest level among pending & INTENABLE above max(PS.INTLEVEL, EXCM ? 3 : 0), plus the NMI
  (level 7) regardless of either: level 1 through the user/kernel vector with EXCCAUSE 4,
  levels 2–7 saving EPCn/EPSn and setting INTLEVEL = n and EXCM. **The irqCheck rule:** the run
  loop tests one boolean per instruction, `irqCheck`, which is recomputed only where its inputs
  change — INTERRUPT (INTSET/INTCLEAR, lines, pulses, a timer match), INTENABLE and PS (WSR,
  RSIL, WAITI, exceptions, RFE/RFI) — never by masking on every instruction. Likewise the
  window check costs one boolean (`overflowArmed`: WOE = 1, EXCM = 0 and a live frame ahead) and
  the loop check one compare against LEND, so call0 code runs as fast as before (bench-loop
  20.7 → 20.8 simulated MIPS in Node).

  **Timing model (flat).** Every instruction takes one cycle; CCOUNT = cycles + an offset set by
  WSR.CCOUNT; exceptions and interrupt entry are free. The core keeps the cycle of the next
  CCOUNT = CCOMPAREn match and runs its inner loop only up to it (no per-instruction compare);
  at the match it latches interrupt 6/15/16, and writing CCOMPAREn clears it. WAITI sets
  PS.INTLEVEL and sleeps: the core jumps the cycle count to the next match or the end of the
  run (`slept` counts those cycles, `instructions` excludes them). Zero-overhead loops: LOOP,
  LOOPNEZ and LOOPGTZ set LBEG/LEND/LCOUNT (LOOP with 0 runs 2^32 times); after an
  instruction whose fall-through PC is LEND — not a taken branch or jump — with LCOUNT ≠ 0 and
  EXCM = 0, LCOUNT decrements and execution continues at LBEG. Special registers without side
  effects are plain storage masked to their writable bits (`SR_WRITABLE`, `UR_WRITABLE`);
  WINDOWBASE/START, PS, INTSET/INTCLEAR, INTENABLE, CCOUNT, CCOMPAREn, VECBASE and the loop
  registers have their effects; PRID is per core (0xCDCD PRO, 0xABAB APP). RER/WER reach a
  sparse map where unknown addresses read 0 ("no debugger attached").

  **ISA options.** MUL16/MUL32/MULUH/MULSH/DIV32, booleans (BR = SR 4), S32C1I/L32AI/
  S32RI/S32NB and the region-protection TLB ops run in cpu.ts's switch; MULUH/MULSH build the
  high word from 16-bit limbs (`ops/muldiv.ts`), QUOS/QUOU/REMS/REMU raise
  IntegerDivideByZero (6). S32C1I compares with SCOMPARE1 and swaps in one step — both cores
  run on one thread, so it is atomic as written; ATOMCTL is storage. Region protection is
  eight 512 MB entries per TLB with 4-bit attributes (reset 2, core-matmap.h), written by
  WITLB/WDTLB and read by RITLB0/1, RDTLB0/1; the SoC bus enforces them. MAC16 (`ops/mac16.ts`)
  keeps the 40-bit accumulator in ACCLO + ACCHI (bits 39–32, read back sign-extended) and adds
  in a double (exact: |ACC| < 2^40); an op table built from the mnemonics gives each
  MUL/MULA/MULS/UMUL form its operand sources and halves; LDINC/LDDEC loads happen before
  the accumulator changes, so a bus error leaves it untouched. The FPU (`ops/fpu.ts`, helpers
  in `fp32.ts`) holds f0–f15 as bits (Uint32Array plus a Float32Array view), so moves, loads,
  stores and RFR/WFR keep NaN payloads; every FPU instruction — and RUR/WUR of FCR/FSR, which
  are coprocessor-0 state per tie.h — raises Coprocessor0Disabled (32) when CPENABLE bit 0 is
  clear, with EPC1 at the instruction. **FP rounding:** results are computed in float64 and
  rounded once to float32 in the FCR mode: a product of two float32 values is exact in
  float64; sums go through TwoSum and are rounded to odd at 53 bits, which then rounds to
  float32 correctly in all four modes (round-to-odd keeps the sticky information); directed
  modes step Math.fround's result by one ulp when it lies on the wrong side. MADD.S, MSUB.S,
  MADDN.S and DIVN.S are fused. FSR flags are IEEE's (tininess before rounding); FCR's enables
  never trap. Divide and square root are libgcc Newton sequences of step instructions
  (DIV0.S, NEXP01.S, MKDADJ.S, ADDEXP(M).S, DIVN.S, …) whose intermediate bits the ISA RM
  leaves open; Benchtop's definition (in fpu.ts's header) carries the exponent adjustment
  exactly (an extra-exponent side array, `core.fx`, when it leaves float32's range) so DIVN.S
  rounds the exact quotient once, and MKDADJ.S/MKSADJ.S produce IEEE's special results and
  DivZero/Invalid flags directly. The oracle is IEEE: libgcc's __divsf3 and __ieee754_sqrtf
  are bit-identical to Math.fround(a / b) and Math.fround(√a) on thousands of operands, in
  all four modes, for denormal and overflowing quotients too (fpu-libgcc tests). The ROM's
  libgcc (double math, 64-bit integers) is integer-only soft-float, so there is **no ROM
  intercept**: those routines run as code and match float64/BigInt (rom-libgcc tests, through
  the ROM's own window vectors). Faulting "unimplemented": the DFP accelerator's f64* ops and
  RF64R/WF64R (no libgcc routine uses them; F64R_LO/HI and F64S are storage), Espressif's
  EXPSTATE/IMPWIRE TIE ops, the OCD-only LDDR32.P/SDDR32.P, PITLB/PDTLB and CONST.S 2, 4–7
  (values unknown).

  **ESP32 memory map (`packages/esp32/src/soc/`).** `Esp32Soc` owns the memories
  (`memory.ts`: one buffer for ROM0/ROM1/SRAM0–2/RTC FAST/RTC SLOW so the fast path indexes
  one Uint8Array/Uint32Array pair — a little-endian host is assumed and checked — plus the
  flash), the flash MMU and DPORT cache registers (`mmu.ts`), the peripheral map
  (`periph.ts`), and two `XtensaCore`s on their own `SocBus` (`bus.ts`): PRO_CPU (PRID
  0xCDCD) and APP_CPU (0xABAB, held in reset until the app starts it). From TRM v5.8 §3.3:

  | Address (data bus) | Instruction bus | Memory | Notes |
  |---|---|---|---|
  | — | 0x40000000–0x4005FFFF | ROM0 384 KB | read-only; first 32 KB shows SRAM1 0x400B0000–0x400B7FFF while DPORT_x_BOOT_REMAP_CTRL bit 0 is set (per CPU) |
  | 0x3FF90000–0x3FF9FFFF | — | ROM1 64 KB | read-only |
  | — | 0x40070000–0x4009FFFF | SRAM0 192 KB | 0x40070000/0x40078000 are the cache pools (Table 3.3-5): read 0 + Problem while a cache using them is on |
  | 0x3FFE0000–0x3FFFFFFF | 0x400A0000–0x400BFFFF | SRAM1 128 KB | word-inverted: iram = 0x400A0000 + (0x40000000 − dram) − 4, bytes in a word keep their order |
  | 0x3FFAE000–0x3FFDFFFF | — | SRAM2 200 KB | |
  | 0x3FF80000–0x3FF81FFF | 0x400C0000–0x400C1FFF | RTC FAST 8 KB | PRO_CPU only, same order on both buses; the APP_CPU reads 0 + Problem |
  | 0x50000000–0x50001FFF (both) | | RTC SLOW 8 KB | shared by both buses |
  | 0x3F400000–0x3F7FFFFF | 0x400C2000–0x40BFFFFF | flash via cache | MMU entries 0–63 / 64–255 (77 = 0x400D0000) |
  | 0x3F800000–0x3FBFFFFF | | PSRAM | MMU entries 1152–1279, 32 KB pages of the chip on SPI1's CS1; masked by DRAM1 until the PSRAM driver starts it — an access then is a Problem and the core faults |
  | 0x3FF00000–0x3FF7FFFF, alias 0x60000000–0x6003FFFF → 0x3FF40000 | | peripherals | 4 KB blocks |

  Below 0x40000000 is the data bus (any width, unaligned done by the hardware); 0x40000000–
  0x4FFFFFFF the instruction bus, where data accesses must be aligned words (TRM §3.3.1) — a
  byte, halfword or unaligned access raises LoadStoreError (3); instruction fetches from the
  data bus raise InstructionFetchError (2); unmapped addresses raise LoadStoreError or
  InstructionFetchError. Writes to ROM or through the flash cache are ignored and reported.
  **Per-core differences:** each bus has its own page table, MMU table (PRO 0x3FF10000, APP
  0x3FF12000), cache enable (DPORT_x_CACHE_CTRL bit 3) and region masks
  (DPORT_x_CACHE_CTRL1: DROM0 bit 4 for 0x3F400000, IRAM0/IRAM1/IROM0 bits 0/1/2 for the three
  4 MB instruction windows), boot remap and region protection; RTC FAST is PRO-only. The
  per-CPU PID controller isn't modeled (PID 0/1 mappings only). **The page table:** 65,536
  64 KB pages with a kind (SLOW, DRAM, DROM, IRAM, IROM, FLASH_D, FLASH_I) and a base offset;
  aligned accesses to plain-memory pages take a fast path with no calls (bench-loop runs at 94 %
  of the bare machine's speed); everything else goes to a slow path that decides by address.
  **MMU:** an entry's low 8 bits are the 64 KB flash page, bit 8 marks it invalid. Flash pages
  start slow; the first access translates and arms the page; any MMU-table write disarms that
  CPU's flash pages and any DPORT cache/remap write rebuilds the page table. An invalid entry,
  a disabled cache or a masked region faults the core with a message naming the cause.
  **Region protection** (the TLB attributes) is checked on the slow path; pages in a
  region whose attribute restricts anything stay slow. **Unknown-register policy:** every 4 KB
  peripheral block is a `Peripheral` (`read32/write32` by offset); until a model replaces it, a
  `RegisterFile` answers with the IDF headers' reset values (`reg-defaults.generated.ts`, from
  `scripts/gen-esp32-reg-defaults.ts`) and reads back what was written. Accesses to blocks (or
  offsets, for the partly modeled DPORT) without a model are logged: the first 32 distinct
  addresses become `esp32-unimplemented-register` notes (info, as the other chips' are: a
  firmware that runs fine still touches a few) ("read 0x3FF5A0B0 (EFUSE+0x0B0) =
  0x00000000 at PC 0x400D1234"), and `problems.totals` counts every access. Sub-word register
  accesses read, or merge into, the containing word. Nothing in the address space throws
  except a real CPU exception or a named emulator fault.

  **ESP32 direct boot (`packages/esp32/src/boot/`, `soc/`, `debug/`).** Benchtop skips
  the ROM's flash loader and IDF's 2nd-stage bootloader: `directBoot(soc, {app, partitions,
  rom})` builds the flash (`flash-image.ts`: 0xFF-filled, sized from the header, partition
  table at 0x8000, the app at its first app partition, rejected if larger), loads the ROM,
  sets up what those two stages would have left, and starts the PRO_CPU at the image's entry
  (`call_start_cpu0`). Everything after that — the app's own startup, FreeRTOS, the APP_CPU's
  start through the real ROM reset path, `esp_clk_init`'s PLL switch, `nvs_flash_init`'s
  flash writes, Arduino's `initArduino` and `setup()` — runs as compiled. Sources: IDF v4.4.7
  (the version core 2.0.17 is built from) read on GitHub; headers and linker scripts in the
  local SDK (`SDK` = `~/Library/Arduino15/packages/esp32/hardware/esp32/2.0.17/tools/sdk/esp32`);
  ROM addresses from the ROM ELF disassembled with our own disassembler.

  *What the bootloader leaves* (`boot/direct-boot.ts`, `boot/rom.ts`):

  | Item | Benchtop sets | Source |
  |---|---|---|
  | ROM code | the ROM ELF's sections into ROM0 (0x40000000…) and ROM1 (data view 0x3FF90000, instruction view 0x40060000 — a section straddles the two) | ROM ELF section headers; `SOC_IROM_MASK_HIGH` 0x40070000 in `SDK/include/soc/esp32/include/soc/soc.h` |
  | ROM RAM data | `_rom_store_table` (0x4000d4f8–0x4000d5c8) unpacked: 16-byte entries {start, end, source, always}; PRO_CPU copies all, APP_CPU only `always = 1`. The source bytes (0x4000D670…, past the ELF's `.text`) come from the ELF's non-ALLOC `.data_*` sections covering each destination (`placeRomData`) | ROM reset handler's `unpackloop` at 0x40000501 (table literal at 0x40000424); `_data_start_rom`/`_data_end_rom`/`_rom_store_table` in `SDK/ld/esp32.rom.ld` |
  | Flash MMU | both CPUs' tables (PRO 0x3FF10000, APP 0x3FF12000): each DROM/IROM segment's 64 KB pages → the flash pages it occupies (vaddr − flash offset must agree mod 64 KB, else the image is rejected); every other entry 0x100 (invalid) | `bootloader_utility.c` `set_cache_and_start_app` (`mmu_init(0)`/`mmu_init(1)`, then `cache_flash_mmu_set` for CPU 0 and 1 with `drom_addr_aligned`/`irom_addr_aligned`); ROM `mmu_init` 0x400095a4 |
  | Cache masks | IRAM0 and DROM0 cleared in DPORT_PRO_CACHE_CTRL1 (0x3FF00044) and DPORT_APP_CACHE_CTRL1 (0x3FF0005C). IDF also clears DRAM1 (PSRAM) when it starts the PSRAM — not at boot | `set_cache_and_start_app`, the two `DPORT_REG_CLR_BIT(DPORT_x_CACHE_CTRL1_REG, …)` |
  | Cache enable | PRO cache on (DPORT_PRO_CACHE_CTRL bit 3), APP cache off | `set_cache_and_start_app`: `Cache_Read_Enable(0)` only, with the comment that the app does `Cache_Flush(1)`/`Cache_Read_Enable(1)` — which `call_start_cpu0` (`cpu_start.c`) does |
  | RAM segments | DRAM/IRAM/RTC segments copied (a region may be split over non-adjacent segments) | `bootloader_utility.c` `unpack_load_app` → `load_image` (`esp_image_format.c`, segments with a RAM load address) |
  | `g_rom_flashchip` (0x3ffae270) | device_id 0xEF4016 (manufacturer high), chip_size from the header (4 MB), block 0x10000, sector 0x1000, page 0x100, status_mask 0xFFFF | `bootloader_esp32.c` `bootloader_init_spi_flash` (`g_rom_flashchip.device_id = bootloader_read_flash_id()`) and `update_flash_config` (`esp_rom_spiflash_config_param(…, 0x10000, 0x1000, 0x100, 0xffff)`); struct in `SDK/include/esp_rom/include/esp32/rom/spi_flash.h`; address in `esp32.rom.ld` |
  | `g_ticks_per_us` (0x3ffe01e0) | 40 | ROM `ets_update_cpu_frequency` 0x40008550 writes it; the ROM startup leaves the XTAL MHz (`esp_rom_delay_us` scales by it). The real bootloader leaves 80 (see CPU clock) |
  | RTC_CNTL_STORE4 (0x3FF480B0) | 0x00280028 (40 MHz) | `RTC_XTAL_FREQ_REG` = `RTC_CNTL_STORE4_REG` (`SDK/include/esp_rom/include/esp32/rom/rtc.h:70`); `rtc_clk.c` `rtc_clk_xtal_freq_update` → `clk_val_to_reg_val(40)` = `(40 & 0xffff) \| (40 << 16)`, called from the bootloader's `rtc_clk_init` |
  | RTC_CNTL_RESET_STATE (0x3FF48034) | 0x41: POWERON_RESET (1) for PROCPU (bits 5:0) and APPCPU (11:6) — read-only to software | `rom/rtc.h:86` `POWERON_RESET = 1`; `rtc_cntl_reg.h` `RTC_CNTL_RESET_CAUSE_PROCPU`/`_APPCPU` |
  | Watchdogs | RTC WDT (WDTCONFIG0 0x3FF4808C: EN bit 31, FLASHBOOT_MOD_EN bit 10) and TIMG0/1 MWDT (WDTCONFIG0 +0x48) off | `bootloader_esp32.c` `bootloader_config_wdt` (flashboot protection off on RWDT and MWDT0). The sdkconfig has `CONFIG_BOOTLOADER_WDT_ENABLE=y` (RWDT 9 s), which the app disables in `call_start_cpu0` (`cpu_start.c`, no `…_DISABLE_IN_USER_CODE`) — so leaving it off changes nothing the app sees |
  | CPU clock | the power-on configuration: XTAL 40 MHz, APB 40 MHz | *Deliberate difference:* the bootloader's `bootloader_clock_configure` (`bootloader_clock_init.c`) runs `rtc_clk_init` with 80 MHz on the PLL. `esp_clk_init` (`clk.c`) then switches to `CONFIG_ESP32_DEFAULT_CPU_FREQ_MHZ` (160) through `rtc_clk_cpu_freq_set_config`, which handles an XTAL start too — so we don't pre-program the PLL |
  | PRO_CPU registers | PC = entry; PS 0x00060020 (WOE, CALLINC 2, UM); WINDOWBASE 0, WINDOWSTART 1; a1 = 0x3ffe3f20, with [a1 − 12] = a1 so a spill of the root frame stays in the ROM stack area; a8 = 0x80000000 (returning to PC 0 faults "app returned"); a9 = a1 − 64; VECBASE 0x40000000; PRID 0xCDCD | `set_cache_and_start_app` ends in `(*entry)()` — a windowed-ABI `callx8`; PS bits per the Xtensa ISA RM (CALLX8 sets CALLINC; WOE/UM as the ROM's C runtime runs); `__stack` 0x3ffe3f20 in `esp32.rom.ld`; `XCHAL_VECBASE_RESET_VADDR` 0x40000000 in `SDK/include/xtensa/esp32/include/xtensa/config/core-isa.h` (the app moves it to `_vector_table`) |
  | APP_CPU | in reset: DPORT_APPCPU_CTRL_A RESETTING keeps its reset value 1; PRID 0xABAB | `dport_reg.h`; TRM v5.8 ch. 5 (APP_CPU control) |

  **The APP_CPU start runs the real ROM path.** `start_other_core` (`cpu_start.c`) sets
  APPCPU_CTRL_B CLKGATE_EN, clears CTRL_C RUNSTALL, pulses CTRL_A RESETTING and calls
  `ets_set_appcpu_boot_addr` (0x4000689c: `l32r a8` of the literal 0x3FF00038 at 0x40006898,
  `s32i.n a2, a8, 0` — it stores the address in DPORT_APPCPU_CTRL_D). Benchtop resets core 1 when
  it becomes "out of reset, clocked, not stalled"; it runs the ROM reset vector and its own
  `.data` unpack (the `always` entries) and jumps to the boot address (`call_start_cpu1`). **APP_CPU ROM data window (inferred, not in the TRM):** the ROM runs one
  copy of its code on both CPUs but keeps per-CPU copies of its variables and boot stack —
  `esp32.rom.ld` has `g_ticks_per_us_pro` 0x3ffe01e0 / `g_ticks_per_us_app` 0x3ffe40f0 ("updates
  g_ticks_per_us on the current CPU only"), `__stack` 0x3ffe3f20 / `__stack_app` 0x3ffe7e30, and
  the ROM ELF's `_pro`/`_app` `.data`/`.bss` sections differ by exactly 0x3F10 — while the code
  addresses only the `_pro` copies. So an APP_CPU data access to [0x3FFE0000, 0x3FFE3F20) lands
  0x3F10 higher (`soc/bus.ts` APP_ROM_WINDOW_*). Without it the APP_CPU's ROM startup overwrites
  the PRO_CPU's ROM data and runs on its stack. A hardware run would confirm it.

  **Time base and interleave (`soc/soc.ts`, `soc/context.ts`, `soc/events.ts`).** Time is
  counted in 240 MHz reference cycles (`REF_HZ`). An instruction costs 240 / cpuMHz reference
  cycles (1, 1.5, 3 or 6 — exact in a double); CCOUNT still counts one per instruction. cpuMHz
  follows RTC_CNTL_CLK_CONF SOC_CLK_SEL (bits 28:27: 0 XTAL, 1 PLL, 2 8 MHz RC, 3 APLL), DPORT
  CPU_PER_CONF CPUPERIOD_SEL (80/160/240 under the PLL) and SYSCON PRE_DIV_CNT; APB is 80 MHz
  under the PLL and the CPU clock otherwise. Any write to those three recomputes the clocks,
  first settling the running core's time and re-anchoring the timer counters at the old rate.
  The cores interleave deterministically: within each slice (≤ `SLICE_CYCLES` = 256 reference
  cycles, ≈ 1.07 µs) the core behind in time runs — the PRO_CPU first on a tie — until the slice
  end or until it yields on a peripheral access (see below).
  While a core runs, `now()` is that core's local time, so a peripheral sees the time of the
  store. Timed events (UART frame ends, RTC calibration, timer alarms) live in a fixed
  slot table; a slice ends at the next pending event, so events fire at their exact time — one
  scheduled in the middle of a slice fires at that slice's end (≤ 1.07 µs late), but inside its
  callback `now()` is the event's own time, so what it does — an RMT edge, the next edge
  it schedules — carries the exact timestamp.

  **Boot peripherals (one file each in `soc/`; a `RegisterFile` underneath, so unmodeled
  registers keep their logged reset-value behavior).** `dport.ts` (APP_CPU control,
  CPU_PER_CONF, PERIP_CLK/RST_EN storage, CPU_INTR_FROM_CPU_0..3 → matrix sources 24–27, the map
  and status registers, DCACHE_DBUG0 always idle for `spi_flash_disable_cache`), `intmatrix.ts`
  (69 sources × 2 CPUs; level lines into the cores' external interrupts; a source mapped to an
  internal interrupt number — 6, 7, 11, 15, 16, 29: IDF's "disabled" value — does nothing),
  `rtc-cntl.ts` (STORE0–7, CLK_CONF, RESET_STATE, TIME_UPDATE/TIME0/1 from simulated time at
  150 kHz, APPCPU reset),
  `efuse.ts` (ESP32-D0WD rev 1, MAC 24:0A:C4:00:00:01 + CRC8; not ECO3 on purpose so the
  cache-lock workaround stays off), `analog.ts` (the analog-I2C byte store behind
  `rom_i2c_writeReg` — interface from disassembling `rom_chip_i2c_readReg` 0x40004110 /
  `rom_chip_i2c_writeReg` 0x40004168; SYSCON; a deterministic xorshift RNG), `timg.ts` (T0/T1/LACT
  counters computed from time on read, RTC slow-clock calibration completing after the measured
  slow cycles), `uart.ts` (TX FIFO drained at the CLKDIV + FRAG/16 baud rate, back-to-back frames
  without drift, TXFIFO_EMPTY/TX_DONE → sources 34–36), `flash.ts` + `spi-flash.ts` (SPI1 native
  and USR commands against a JEDEC EF4016 chip). **Flash timing:** every command completes at
  once (WIP never reads 1); real erase/program times would only stretch NVS formatting at first
  boot. The cache's flash reads are instant too.

  **Debug tooling (`debug/`, `scripts/esp32-trace.ts`).** `SocTracer` attaches to both cores
  through `instructionHook`/`exceptionHook` (the core switches to an instrumented copy of its
  run loop only while a hook is set): a 4,096-entry ring per core of {PC, instruction word,
  a1}, a PC histogram sampled every 1,024 instructions, milestones (symbols first reached, per
  core, with simulated time) and an exception log (EXCCAUSE, or −level for interrupts above
  level 1, with EPC and EXCVADDR; window over/underflow and level-1 interrupts aren't logged).
  `EspSymbols` reads `<fixture>.syms.tsv` and the ROM ELF's symbols and symbolizes `name+0xoff`.
  `node scripts/esp32-trace.ts <fixture> [--until <symbol>] [--max-ms N] [--trace N]` boots a
  fixture and prints UART0, both cores' state, milestones, the top-20 histogram per core, the
  Problems, the exception log and the last N instructions disassembled and symbolized. The
  method that got serial-hello to print: run to the first unreached milestone, read the spin
  loop off the histogram, the register it polls off the unknown-register list, and the IDF
  function behind it; model the bit it waits for.

  **Debugger (`debug/debug.ts`).** `Esp32Mcu.debug()` is an `McuDebug` over one core at a
  time: the APP_CPU — Arduino-ESP32 runs `setup()`/`loop()` there (CONFIG_ARDUINO_RUNNING_CORE
  1) —, or the core that stopped at a breakpoint last (`Esp32Soc.debugCpu`; the last register,
  `cpu`, tells which). Registers pc, a0–a15 of the current window (a function's first argument
  is in a2 once its ENTRY has run), sar, ps, windowbase, windowstart, lbeg, lend, lcount. Memory
  `data` goes through that core's `SocBus.peek8`: the page table's memory and flash pages, the
  MMU for unarmed flash pages, the instruction-bus views (ROM, SRAM0, SRAM1's inverted alias,
  RTC FAST) — no cache tags touched, no flash page armed, no Problem; mapped PSRAM through the
  MMU; peripherals, unmapped PSRAM and unmapped addresses read 0. Writes (`poke8`) reach SRAM,
  RTC memory and mapped PSRAM and drop predecoded code there. Breakpoints are the adapter's set,
  handed to both cores of every SoC it builds (they survive resets); while it is non-empty a core
  runs `innerChecked` — chosen per `run`, so the predecoded loop never tests anything per
  instruction —, which takes a pending interrupt
  first, then stops before a PC on a breakpoint (`atBreakpoint`, `resumePc` as on the other
  cores). The SoC reports `breakpoint` with its time at the stopped core's. `stepCore` runs one
  instruction on the debugger's core and lets the rest catch up to its time rounded down
  (`runUntil` rounds up, which would run the stepped core again); a peripheral access that must
  wait for the other core (BUS_YIELD) retries after it caught up. `instructionAt`: 2 or 3 bytes,
  calls are CALL0/4/8/12 and CALLX0/4/8/12. Symbols come from the fixtures' `.syms.tsv`
  (`SymbolTable.fromNm`).

  **Measured before the timer and flash cache models (Apple M1, Node 24):** serial-hello prints `hello from esp32\r\n`
  after a full dual-core boot; 2.0 s simulated take ≈ 1.1 s wall for 7.4 M instructions
  (≈ 6.8 MIPS — the cores spend most of the 2 s in WAITI after `setup()`). `app_main` is
  reached at 9.1 ms simulated.

  **Timers, watchdogs, reboots and idle skip-ahead.** *Event model:* every timed thing
  is a slot in the SoC's `EventTable` (`soc/events.ts`) — UART frame ends, RTC calibration,
  TIMG T0/T1/LACT alarms, each watchdog's current stage end, the reboot after a reset. Times are
  whole reference cycles (rounded up), and a slice ends at the next pending event, so an event
  scheduled before its slice began fires at exactly its time; one scheduled during the slice
  fires at the slice end. *Counters* (`soc/timg.ts`) aren't ticked: a counter's value is its
  value at an anchor time plus the APB cycles since, over its divider, computed when read;
  config, load and APB-clock changes re-anchor it and re-time its alarm. An alarm fires when the
  counter reaches the alarm value (at once if it already has), clears ALARM_EN, and with
  AUTORELOAD restarts the counter from the load value *at the alarm time*, so periodic alarms
  don't drift. esp_timer runs on TIMG0's LACT (`CONFIG_ESP_TIMER_IMPL_TG0_LAC`). *CCOMPARE
  ticks* need no re-timing: CCOUNT counts CPU cycles and an instruction costs 240 / cpuMHz
  reference cycles, so a match programmed at any clock lands at the right reference time; Arduino's
  `setCpuFrequencyMhz` rewrites `_xt_tick_divisor`, so the tick stays 1 ms. (A clock change
  made by one core mid-slice re-costs the other core's instructions from that slice's start:
  ≤ 1.07 µs once per change.) *Watchdogs* (`soc/wdt.ts`): the TIMG MWDTs (APB / prescaler
  ticks) and the RTC WDT (150 kHz slow-clock ticks) share a four-stage machine — a stage's
  timeout runs its action (interrupt, reset CPU, reset system, reset RTC) and starts the next
  stage, wrapping after stage 3; a feed or enable restarts stage 0; WDTWPROTECT gates config and
  feed writes. IDF's interrupt WDT is TIMG1 (300 ms, fed from the PRO_CPU's tick hook once the
  APP_CPU has ticked), the task WDT TIMG0 (5 s). *Reboot* (`soc/reset.ts`): RTC_CNTL software
  resets and watchdog reset actions hold the CPUs; after `RESET_SETTLE` (100 µs) the chip
  reboots — every digital block back to its reset state, RAM, flash, the RTC_CNTL STORE
  registers and RTC memory kept (an RTC reset clears the last two), and direct boot runs again
  with the new cause in RESET_STATE (SW_RESET 3, TG0/TG1WDT_SYS_RESET 7/8, RTCWDT_SYS_RESET 9,
  TGWDT_CPU_RESET 11, SW_CPU_RESET 12, RTCWDT_CPU_RESET 13, RTCWDT_RTC_RESET 16 — ROM
  `rom/rtc.h`). A PRO_CPU software reset waits until the PRO_CPU has been unstalled for
  `RESET_SETTLE`: `esp_restart_noos` resets and stalls the other CPU, waits for the UARTs, …,
  then resets and unstalls the PRO_CPU last, so the reboot lands where it does on hardware and
  no UART output is cut off. CPU stall is RTC_CNTL `{SW_CPU_STALL C1, OPTIONS0 C0} = 0x86`
  (soc_ll_stall_core); a stalled CPU doesn't run and its CCOUNT doesn't advance. Each reboot is
  an info Problem `esp32-reboot`; after 5 reboots in a row less than 1 s apart the next one ends
  the run with `fault: reboot loop: <cause> …`, while a slower crash-and-reboot cycle keeps
  running as a board would. *WAITI skip-ahead* (`soc.ts`): a core in WAITI with nothing
  deliverable — or held, stalled, in reset — is asleep. When both are asleep as a slice begins,
  the loop jumps over every whole slice before the earliest of the next event, either core's
  next CCOMPARE match and the run's target; the sleeping cores advance their cycles exactly as
  slice-by-slice sleeping would (same slice boundaries, integer times), so skip on and off give
  bit-identical state. `skipIdle` turns it off (the A/B test); `skipped` counts the time it
  covered. Measured on blink, 10 s simulated (Apple M1): 98.7 % of the time is skipped, yet the
  wall time only drops from 3.65 s to 2.82 s (1.3×; 1.8× before the cache model) — what is left
  is real work, the FreeRTOS tick on both cores (~1,300 instructions per core per ms: context
  switch, stack-canary check, watchpoint setup, tick hooks, watchdog feeds). The predecoded
  instruction cache speeds that work up toward the ≥ 5× target (it reaches 2.3–2.7×;
  see below). The GPIO output latch (`soc/gpio.ts`: OUT/OUT1/ENABLE/ENABLE1 and their W1TS/W1TC
  aliases, with a timestamped `onOutput`) is what these tests watch, rather than the pin model.

  **Flash cache timing (`soc/bus.ts`).** Each CPU's cache is 32 KB of 32-byte blocks,
  two-way set-associative (TRM v5.8 §3.3.4): Benchtop keeps its 512 × 2 tags per CPU, by flash
  offset, with LRU replacement — not its contents (data still comes straight from the flash
  array). Every load through the cache looks its block up, and every instruction fetch the block
  of its first byte and, when the instruction runs into the next block, of its last (one
  rule for every fetch path, the predecode cache's included); looking up the block looked up
  last changes nothing and returns at once. A miss stalls the core for one block fill
  (`XtensaCore.stall`: the cycles count in CCOUNT and in time, not as instructions). The fill time comes from the image header's flash mode and frequency, counting
  the SPI clocks of the standard NOR read command (`cacheFillTime`, `soc/flash.ts`): Arduino's
  DIO at 80 MHz is 152 clocks = 1.9 µs (456 cycles at 240 MHz). A DPORT cache flush empties the
  tags. *Why:* without it, flash code ran with no miss cost, and IDF's startup has a real race
  it wins on hardware only because flash code is slow: after `startup_resume_other_cores` the
  APP_CPU polls `s_resume_cores` every 100 µs and then reads `g_startup_fn` from flash, while the
  PRO_CPU heads into its first flash operation, which disables the APP cache. With free misses the
  PRO_CPU got there in 84 µs and the APP_CPU faulted. With the model, serial-hello takes 1,401
  PRO and 417 APP misses in 2 s and reaches `app_main` at 11.4 ms (9.1 ms before). A CCOMPARE
  match a stall steps over still fires (the core compares match cycles, not values).

  **Peripheral order across the cores (`soc/soc.ts`, `soc/bus.ts`).** A core may run up to
  a slice ahead of the other. For memory that is harmless (spinlocks still exclude), but for
  peripherals it reorders cause and effect: both cores take the TG1 watchdog interrupt at the
  same instant, the PRO_CPU's handler clears its status, and the APP_CPU's handler — run later
  in the same slice — reads it as clear and takes the panic for a cache error. So before a
  peripheral access the bus asks `peripheralTurn(cpu)`: if the other core can run and is behind
  in time, the access throws `BUS_YIELD` (a shared object; the instruction hasn't happened and
  re-executes later), the run ends, and the scheduler runs the core that is behind until it
  catches up or yields itself. Peripherals therefore see accesses in time order; the cost is a
  core switch per peripheral access while both cores are busy (serial-hello: 464 yields in 2 s,
  blink: 5,169).

  **Pins, the `Mcu` adapter and the DevKit board.** *Pads* (`soc/gpio.ts`, `iomux.ts`,
  `rtcio.ts`, `pads.ts`): GPIO holds the output latch and enables, the matrix's FUNC_OUT_SEL
  (signal 256 = the GPIO_OUT bit) and FUNC_IN_SEL, PINn (open drain, interrupt type and
  enables), IN/IN1 (pad levels where IO_MUX FUN_IE is set), STATUS and the per-CPU interrupt
  views; IO_MUX (registers not in GPIO order — the PERIPHS_IO_MUX_* table) holds each pad's
  function, input enable and pulls, reset from TRM Table 6.10-1; RTC IO (inside the RTC_CNTL
  block) routes RTC pads to the analog domain and holds their pulls — on the RTC pads the pulls
  that work are RTC IO's RUE/RDE, as IDF's gpio_pullup_en assumes. The pad resolver turns these
  into each pin's mode and level: analog if RTC-routed — on GPIO25/26 with its DAC powered
  (RTC_IO_PDACn_XPD_DAC with MUX_SEL, what IDF 4.4's dac_output_enable/dac_output_voltage leave)
  also the DAC's volts, code (bits 26:19) / 255 · 3.3 V, which the pin reports as `outputVolts`
  (the cosine generator and DAC DMA aren't modeled); on the GPIO function, `output` from
  GPIO_OUT/GPIO_ENABLE or `peripheral` for another signal (UART TXD idles high); UART0 TX direct
  on GPIO1's function 0; open drain releases a 1; GPIO34–39 refuse output (Problem
  `esp32-input-only-pin`); otherwise an input with its pulls. *Interrupts:* GPIO interrupt
  sources 22/23 are CPU-specific (TRM §7.3: GPIO_INTERRUPT_PRO/APP), so the matrix has a second
  set of per-CPU lines; a pin's INT_ENA bits pick the CPU, and a level type stays pending while
  its level holds. *The adapter* (`esp32.ts`): `clockHz` is the 240 MHz reference clock, `cycles`
  the SoC's time; one McuPin `GPIO<n>` per GPIO (0–19, 21–23, 25–27, 32–39); inputs use VIH
  2.475 V / VIL 0.825 V with hysteresis, a floating input reads 0 and the firmware reading it is
  reported once (`esp32-floating-input`) — for pads the firmware configured itself (a GPIO_IN
  read covers every pad, and GPIO16–23 leave reset as inputs without pulls); `load` takes
  `esp32-bin` and direct-boots it, `reset`
  builds a fresh SoC and boots again (pins and listeners kept); `uart(0..2)` transmit (receiving is
  below); `i2c`/`spi` are below too. The ROM is checked against rom-manifest's SHA-256 and parsed once
  per byte array. `esp32McuFactory(rom)` is the bench factory; it folds the adapter's Problems
  into one per code on the board (first messages and a count), because the bench keeps one
  Problem per code and part. *The board* (`packages/parts/src/boards/esp32-devkit-v1.ts`): the
  30 pins of @wokwi/elements' `esp32-devkit-v1` (an apps/web test reads the element's source
  and checks names and positions), D<n> → GPIO<n>, TX0/RX0 → GPIO1/3, TX2/RX2 → GPIO17/16,
  VP/VN → GPIO36/39, 3V3 a 3.3 V supply, VIN USB's 5 V while prop `usbPowered` (default true;
  the model drives VIN at supply strength, so a module on VIN is powered and VIN wired to
  a GPIO is still `esp32-overvoltage`; off, VIN is an input), GND bused, EN unmodeled; its model shows
  GPIO2 on `led1`. The web view is the wokwi adapter's `esp32-devkit-v1` entry; a dropped `.bin`
  becomes `{ format: 'esp32-bin', app }` (the default partition table). The CLI reads the ROM
  from `.cache/esp32-rom` when it exists.

  **UART RX, LEDC PWM and ADC1.** *UART RX* (`soc/uart.ts`): `UartPort.receive` queues
  bytes on the RX line; each lands in the 128-byte RX FIFO when its stop bit ends, frames back to
  back at the configured baud (115200 8N1: 86.8 µs a byte), so the firmware sees bytes at line
  rate. RXFIFO_FULL is raised while the FIFO holds at least its threshold, RXFIFO_TOUT when the
  line has been idle for RX_TOUT_THRHD units after the last byte (8 bit times a unit on the APB
  clock, as uart_ll_set_rx_tout converts), RXFIFO_OVF — with a Problem — when a byte meets a full
  FIFO. MEM_RX_STATUS's read/write addresses differ by the fill level, which is what IDF's
  uart_ll_get_rxfifo_len uses. The line is byte-level: no waveform on the RX/TX pins, no framing
  errors. IDF's uart_set_pin prefers the "IOMUX pins" (U2TXD on GPIO17 function 4), so the pad
  resolver knows IO_MUX's direct UART outputs. *LEDC* (`soc/ledc.ts`): each timer counts its
  clock / CLOCK_DIVIDER (10.8 fixed point) to 2^DUTY_RES; a channel's output is high for the
  counter in [HPOINT, HPOINT + duty), driven by timed events at exact times (two or three a
  period; duty 0 or full is a constant level with none). The duty's 4-bit fraction, which the
  hardware dithers over 16 periods, is modeled as its average. DUTY_START latches a new duty at
  the next period boundary — the period running keeps its old duty, fall included (a
  write in the high phase doesn't cancel that fall, and a low-speed channel's CONF0 write — the
  PARA_UP ESP-IDF sends after DUTY_START — doesn't restart the waveform: only a new timer, output
  enable or idle level does, as on the C3 and S3; `fixtures/sketches/esp32/ledc-duty-step` steps
  both groups' duty every 8.5 periods and the test keeps every period); a timer write restarts its periods (Arduino-ESP32 2.0.17's
  `analogWrite` re-runs `ledcSetup` on every call, so its changes restart the period, as on
  hardware). Outputs reach pads as matrix signals 71–86. *ADC1* (`soc/sens.ts`): a conversion
  samples the pad's NetState voltage, finishes (SAR1_SAMPLE_CYCLE + bits + 2)·SAR1_CLK_DIV cycles
  of the 8 MHz RTC clock later (5.75 µs at reset values — a model choice) and returns
  round(V / FS · (2^bits − 1)) with FS 1.1 / 1.5 / 2.2 / 3.3 V for 0 / 2.5 / 6 / 11 dB: an
  idealized linear ADC, so a pot across 3V3 sweeps 0–4095 (the real 11 dB curve saturates near
  3.1 V). The hardware output is inverted unless SAR1_DATA_INV is set; IDF sets it. ADC2 is
  the same model on its own registers — SAR_MEAS_START2 (0x94), SAR_ATTEN2 (0x38), SAR_READ_CTRL2
  (0x90; SAR2_DATA_INV is bit 29) — over its ten channels: GPIO4, 0, 2, 15, 13, 12, 14, 27, 25, 26
  (`ADC2_GPIO`); each unit has its own conversion event. Fixture `adc2-read` (all ten, and 0 dB):
  `boot/peripherals.test.ts`. On a board WiFi takes ADC2: the simulated driver takes IDF's lock as
  the real one does, so an ADC2 read returns 0 while WiFi runs (fixture `adc2-wifi`).

  **Analog end to end:** the gallery's ESP32 joystick on ADC2 (`esp32-joystick`: an analog
  joystick's HORZ and VERT on GPIO25/26 — ADC2's channels 8 and 9 — printed as `x:…,y:…` for the
  Serial Plotter, its SEL on GPIO27 lighting the DevKit's LED) and the S2's DAC sine
  (`esp32s2-dac-sine`: the S2's `dac-sine` into a speaker on IO17) — specs in
  fixtures/specs/examples and checks in `examples-run-esp32.test.ts` and
  `examples-run-esp32s2.test.ts`.

  **I2C and SPI masters.** Both are transaction level, like the Uno's TWI: devices get
  `start/write/read/stop` or `transfer(mosi)` calls, never SDA/SCL/SCK edges. *I2C*
  (`soc/i2c.ts`, I2C0 = `Mcu.i2c(0)`, I2C1 = `i2c(1)`): TRANS_START runs the COMD list as IDF's
  i2c_master_cmd_begin writes it — RESTART, WRITE (the first byte after RESTART addresses a
  device, which ACKs from `start`), READ (into the RX FIFO), STOP, END (pauses for the driver to
  refill the list) — one timed event per command: one SCL period for RESTART and STOP, nine per
  byte, an SCL period being SCL_LOW_PERIOD + SCL_HIGH_PERIOD APB cycles. A 1-byte write is 20
  periods: 200 µs at 100 kHz, 50 µs at 400 kHz. A NACK where ack_check_en expects an ACK raises
  ACK_ERR and ends the transaction. *SPI* (`soc/spi.ts`, SPI2/HSPI = `spi(2)`, SPI3/VSPI =
  `spi(3)`; SPI0/1 run the flash): CMD USR moves the data phase byte by byte through every
  attached device whose CS net is low (`selected()`), fills W0… with MISO, and clears USR after
  bits / f_sck. LSB-first sends bit-reversed bytes, as they travel on the wire; clock modes only
  choose edges. *Pins* follow the firmware's routing (FUNC_OUT_SEL/FUNC_IN_SEL or IO_MUX's direct
  SPI functions), with the Arduino defaults (I2C0 21/22, VSPI 18/23/19, HSPI 14/13/12) before the
  firmware routes them, so a bench built before the firmware runs attaches its devices there. The
  bench re-checks every MCU's bus pins after each run and re-attaches all bus devices when one
  moved (`Wire.begin(16, 17)`), so a re-route takes effect at the next quantum boundary (≤ 1 ms).
  I2C pads are open drain with idle-high signals, so a released line reads as its pull-up.

  **RMT (`soc/rmt.ts`).** The transmitter behind `neopixelWrite` and `rmtWrite*`: 8
  channels sharing 512 words of RAM (RMTMEM 0x3FF56800; channel n's memory is MEM_SIZE blocks of
  64 items from block n). An item is {duration0, level0, duration1, level1}; each half is a timed
  event at its exact time (ticks of DIV_CNT APB or REF_TICK cycles — 100 ns = 24 reference cycles
  for `rmtSetTick(100)`), so a WS2812 decodes from the edge timestamps (T0H 400 ns, T1H 800 ns
  measured exactly). A zero duration ends the transmission (TX_END) and the output goes to the
  idle level; TX_CONTI_MODE loops. Every TX_LIM items raise TX_THR, and with MEM_TX_WRAP_EN the
  read pointer wraps — IDF refills one half from that interrupt while the other goes out, so 150
  items run through a 64-item block (`rmt-long`). The end clears TX_START (inferred: IDF's TX_END
  handler rewrites CONF1 read-modify-write and the channel doesn't restart, while repeated
  `rmt_write_items` calls without a stop do start). Outputs are matrix signals 87–94; source 47.
  Receive, the carrier and the APB FIFO access through CHnDATA report `esp32-rmt-unsupported`.

  **Predecoded instruction cache (`xtensa/icache.ts`).** Decoding was the largest share of
  every instruction (crc-bench profile: `decode` 31 % self time, the fetch in the run loop most
  of the rest of its 23 %). Each core now keeps a cache over the instruction bus 0x40000000–
  0x40BFFFFF in 4 KB pages keyed by virtual address (IROM translation differs per core): an
  Int32Array of two ints per byte offset, filled lazily — word 0 packs op + 1, length, r, s, t
  and the highest window quarter the instruction touches; word 1 is the target address of a
  branch, jump, call, loop or l32r (computed once), EXTUI's shift | width << 8, or the
  immediate. Two words, not the decoder's eight, so consecutive instructions share cache lines
  (it measured faster on tick-heavy code); pages are pooled. ~25–40 pages a core are live on the
  fixtures (≈ 2 MB in all). *What may be cached is the bus's call* (`codePage`): ROM, SRAM0
  (IRAM), SRAM1 through its word-inverted instruction alias and (PRO_CPU) RTC FAST as plain
  bytes, and IROM by its flash offset; pages under a restrictive region attribute, the SRAM0
  cache pools, the boot-remapped ROM0 page, RTC SLOW and APP_CPU RTC FAST reads go through
  `fetch()` every time, as does an instruction that runs past its page's end. *Invalidation:*
  `codePage` marks the physical 4 KB page in `memory.code`; a store to a marked page — data or
  instruction bus, fast or slow path, SRAM1 through either alias (data page n is instruction page
  31 − n), `memory.load` — drops that page in both cores. An MMU table write drops this core's
  pages of the 64 KB page the entry maps (unchanged writes do nothing); a cache-control change
  or a cache flush (`Cache_Flush`) drops this core's flash pages; a flash erase or program both
  cores' pages mapped to the touched range; a region-protection or boot-remap change and a
  reboot drop everything. ROM never invalidates otherwise. *Timing stays exact:* an IROM page's
  instructions still look up the flash cache as they execute (`codeFetched`, the same rule as
  `fetch()`), and a run through the cache equals a run without it in instruction counts,
  cycles, CCOUNTs, PCs, flash cache misses and output (`soc/predecode.test.ts`: crc-bench and
  3 s of blink; `fixtures/xtensa/smc` rewrites executed code in IRAM, through the SRAM1 data
  alias, by MMU remap and by flash program + Cache_Flush, and sees every change).

  **The interpreter loop (`XtensaCore.interpret`).** Block dispatch takes this
  shape: one function holds both the loop and the 195-case switch and runs from the cache until
  `stopAt` — straight-line code, branches, loops (LEND's loop-back included) and calls,
  switching pages as the PC leaves one — testing only `cycles < stopAt` between instructions.
  Whatever would change the plain loop's other per-instruction tests lowers `stopAt` to now
  instead: a deliverable interrupt (`updateIrq`), WAITI, invalidated code (`icache.onChange`),
  so the loop exits on the instruction boundary where the plain loop would have acted. The
  window-overflow check is the entry's quarter against `armedLimit` (windowLimit while armed,
  else 4). Without the cache (`predecode = false`, the debugger's instrumented loop, refused
  pages) an instruction is fetched, decoded, packed into a scratch entry and run by the same
  function, so there is one switch. Three V8 findings shaped it (Apple M1, Node 24, measured
  with stand-alone mirrors): (1) a switch labeled `case OP.ADD:` — a property of the 513-key OP
  object, or even a module `const` — compiles to a chain of compares (53 vs 14 ns a dispatch
  over 200 cases), so the hot switches use number literals with the name beside them,
  `case 2 /* OP.ADD */:`, and `xtensa/case-labels.test.ts` keeps them equal to the tables;
  (2) V8 won't inline a function with a switch this size, and a call per instruction cost 2×
  (16 vs 9 ns in the mirror); (3) descriptor loads are a large share on tick-heavy code, hence
  the two-word entries. JIT to JS functions stays out (firmware is user input).

  **Slice length and cross-core latency.** `SLICE_CYCLES` stays 256 reference cycles
  (`soc.sliceCycles` for measurements): a core can be up to one slice (≈ 1.07 µs) ahead of the
  other for memory, peripherals being ordered by BUS_YIELD. Measured, best of 3 (M1):

  | slice | serial-hello boot | blink 10 s | crc-bench | blink A/B (skip off / on) |
  |---|---:|---:|---:|---:|
  | 64 (267 ns) | 0.13 s | 0.78 s | 0.24 s | 6.2× |
  | 256 (1.07 µs) | 0.10 s | 0.74 s | 0.23 s | 2.35× |
  | 1,024 (4.3 µs) | 0.14 s | 0.72 s | 0.22 s | 1.33× |

  256 boots fastest (more yields at 1,024, more slices at 64) and is within 3–5 % elsewhere. The
  A/B ratio measures the slices skip-ahead saves more than skip-ahead itself: the run with it
  takes ~0.75 s at any slice; without it, 64-cycle slices take 4.85 s.

  **Measured (`npm run bench:esp32`, Apple M1, Node 24.18, best of 3):**

  | workload | instructions PRO / APP | without the instruction cache | with it | % of real time |
  |---|---:|---:|---:|---:|
  | serial-hello, boot to the first UART byte | 1.24 M / 1.38 M | 14.0 MIPS, 0.19 s | 34.1 MIPS, 0.08 s (cold 0.25 s) | 20.8 % |
  | blink, 10 s simulated | 15.5 M / 10.9 M | 13.5 MIPS, 1.95 s | 37.5 MIPS, 0.70 s | 1,420 % |
  | crc-bench, boot to its line | 1.29 M / 7.66 M | 17.1 MIPS, 0.52 s | 44.2 MIPS, 0.20 s | 21.7 % |

  crc-bench runs 2.6× as fast as without the cache (target 2×). The blink A/B test (skip-ahead on vs
  off) measures 2.3–2.7× against the ≥ 5× target: with skip-ahead on, what is left is the tick
  work, executed instruction by instruction (what would help is a faster interpreter, not a bigger skip).

  **High-level emulation (`hle/`).** Some firmware functions are answered by TypeScript
  instead: `Hle.replace(address, name, handler)` puts a handler at a function's first
  instruction, and `XtensaCore.setHle` hands the table to a core. When the core decodes an
  instruction at a listed address — the predecode cache's fill and the uncached paths all pack
  through `pack()` — it gets `OP_HLE` (id 1022, past the ISA table) instead, so code elsewhere
  pays nothing. The function's own `entry` never runs: the caller's CALLn set PS.CALLINC = n and
  a(4n) = the return address, so the arguments are the caller's a(4n+2)… (the seventh on the
  caller's stack), the result goes to a(4n+2), and execution continues at the return address. A
  handler that calls back into the firmware is a generator yielding `{ fn, args }`: it first gets
  a frame of its own (`hleEntry`, what `entry a1, 176` does — a window overflow first if the
  frame ahead is live, after which the HLE op simply runs again), then each step runs at a resume
  address whose op touches window quarter 3 (so a8–a15 are free), a call out is a CALL8 (a8 =
  the resume address, a10… the arguments, past six on the stack at a1) that returns there with
  its result in a10, and the frame is found again by its stack pointer (unique among live frames
  on every task's stack, so a task may block in a call out and resume on the other core). The
  generator's return value goes to a2 and execution goes to a return address that decodes as
  RETW, so a caller spilled meanwhile comes back through the window underflow handler as for any
  RETW. The frame's 176 bytes: 16 for stack arguments, 128 of scratch memory the handler uses
  while it runs (event data), 32 the windowed ABI reserves at the top. On the SoC the resume,
  return and WiFi-task addresses are 0x4006FFF0/F4/F8: ROM1's instruction view past its
  `.rodata` (zeros nothing executes), in the 1 GB region RETW needs. `fixtures/xtensa/hle.S`
  tests it on the bare machine: CALL4/8/12 callers, calls out from CALL4 and CALL8 callers, seven
  arguments, two TypeScript frames waiting at once, and a recursion deep enough that the
  TypeScript frame's entry spills and its return underflows.

  **WiFi at the driver API (`wifi/`).** Espressif's WiFi driver is closed (libnet80211,
  libpp, libphy) and its PHY calibration (`ram_txdc_cal_v70`, from `esp_wifi_start`) polls radio
  registers forever, so it is replaced at its API by name: `esp_wifi_init`/`deinit` (open source,
  but they only start the closed driver and its supplicant), `esp_wifi_*` (mode, start/stop,
  config, MAC, scan, connect/disconnect, AP info, power save, protocol, bandwidth, channel,
  country, TX power, the soft-AP station list) and the `esp_wifi_internal_*` calls lwIP's glue
  makes (the rx callback registration, transmit, buffer release). The list is the cross-reference
  of Arduino-ESP32 2.0.17's link map: closed-library symbols that open code calls. Everything
  above — the WiFi library, esp_netif, the default event loop, lwIP — is the firmware's own code.
  `WifiDriver` (chip-neutral: it sees calls through `WifiCall` and installs into any `WifiHle`,
  so the ESP32-C3 runs it too — see that entry) keeps the driver's state and posts events as the
  driver does, through
  `esp_event_post(WIFI_EVENT, …)`: STA/AP START and STOP from inside `esp_wifi_start`/`stop`
  (the caller's task), timed ones (SCAN_DONE, STA_CONNECTED, STA_DISCONNECTED) from the driver's
  task, which `esp_wifi_init` creates (`xTaskCreatePinnedToCore`: "wifi", 4 KB, priority 23,
  core 0) with its entry at an HLE address: it posts what is due and sleeps a tick while WiFi is
  started (50 otherwise). A scan dwells per channel as its configuration says (active: `max`
  where an access point answers, `min` elsewhere — Arduino's 100/300 ms; passive: `passive`;
  IDF's 120/360 ms defaults when 0) over 13 channels or the one asked, and lists results
  strongest first; a connect finds its SSID with a full scan at 120 ms a channel (NO_AP_FOUND
  when it isn't there, reason 15 after 4 s of 4-way handshake with a wrong WPA2 key, STA_CONNECTED
  30 ms after the scan otherwise). `esp_wifi_start` also calls the firmware's
  `adc2_wifi_acquire` and `esp_wifi_stop` its `adc2_wifi_release` (`WIFI_OPTIONAL`: when the build
  links them) — what the closed `wifi_start_process` does on a board (measured in a built ELF) —, so
  on the ESP32 IDF's `adc2_get_raw` fails with ESP_ERR_TIMEOUT while WiFi runs and Arduino's
  `analogRead` on an ADC2 pin returns 0, as on a board; on the S2/S3/C3 IDF 4.4's lock is a no-op
  (their hardware arbiter, driven by WiFi's power detection, isn't modeled), so ADC2 reads go on
  working there (`packages/parts/src/integration/adc2-wifi.test.ts`). Struct layouts (`wifi/types.ts`) were measured with the
  toolchain (offsetof/sizeof built with the sketch's flags). Symbols come from the hosts:
  `Esp32Mcu.useSymbols(table)` takes the table they build for the debugger (the web: the
  compiled sketch's ELF; the CLI and MCP server: an `.elf` or `.syms.tsv` beside the `.bin`) and
  installs the HLE on every SoC a reset builds. The radio's blocks (FE2, FE, 0x3FF4E000, NRX, BB,
  0x3FF71000–0x3FF7FFFF but RNG) count their accesses (`radioAccesses`, 0 when WiFi is answered);
  the first access reports `esp32-wifi-no-symbols` (error: a WiFi firmware without symbols, whose
  real driver would hang) or `esp32-wifi-unsupported` (warning: something outside the answered
  API). A WiFi firmware lacking `esp_event_post`, `vTaskDelay`, `xTaskCreatePinnedToCore` or
  `WIFI_EVENT` reports `esp32-wifi-unsupported` (error). `fixtures/sketches/esp32/wifi-scan`
  measures it: 8 s simulated of WiFi.mode, a scan with one AP and a connect run in 1.3 s wall.

  **The station on the bench's network.** The access points a scan lists and a connect
  finds are the bench's (`joinWifi(radio)`, see Virtual network). A connect honours the station
  configuration's scan threshold (`threshold.rssi`, `threshold.authmode` — Arduino sets WPA2
  whenever a password is given, so an open AP isn't joined with one) and `bssid_set`, and picks
  the strongest candidate. STA_CONNECTED joins the AP's LAN as the station MAC; lwIP's frames
  (`esp_wifi_internal_tx` and `_tx_by_ref`, copied at once — the caller keeps its buffer, so the
  netstack's ref/free callbacks are never needed) go onto it; frames for the station queue (32
  at most) and the WiFi task hands each to the rx callback lwIP's glue registered, in a buffer
  from `malloc` that `esp_wifi_internal_free_rx_buffer` gives back with `free`. lwIP's own DHCP
  client gets its address from the AP's server (with its ARP check), so `IP_EVENT_STA_GOT_IP` is
  esp_netif's. A wrong WPA2 key ends in reason 15 (IDF 4.4's 4-way handshake timeout) 4 s after
  the connect scan — Arduino-ESP32 2.0.17 reports that as WL_DISCONNECTED and auto-reconnects;
  an absent SSID in 201 (WL_NO_SSID_AVAIL); `WiFi.disconnect()` in 8 (ASSOC_LEAVE, no
  reconnect); an AP switched off in 200 (BEACON_TIMEOUT, WL_CONNECTION_LOST) after IDF's 6 s
  inactive time. The factory gives every ESP32 board its own eFuse MAC — 24:0A:C4 and three bytes
  hashed from its part id — so two boards on one LAN differ (`Esp32McuOptions.mac`; the SoC's
  default stays 24:0A:C4:00:00:01).

  **The soft-AP.** While WiFi is started in AP or AP+STA mode, `WifiDriver` hosts an
  access point on the bench (`WifiRadio.hostAp`, see Virtual network) as the AP MAC (the base MAC
  + 1) from the AP configuration: IDF's default until one is set ("ESP_" and the AP MAC's last
  three bytes, open, channel 1, 4 stations — `esp_wifi_init` fills it), then
  `esp_wifi_set_config(WIFI_IF_AP)`'s, hosted again at once (Arduino's `WiFi.softAP` starts the
  AP, then sets its configuration); an empty SSID (`WiFi.softAPdisconnect`) hosts nothing. Auth
  modes map to the bench's securities (WPA2-Enterprise as WPA2; open: no password); the station
  limit is `max_connection` (0: 4), at most the chip's list (15 on the ESP32, 10 on the C3).
  A station joining gets the lowest free AID and posts AP_STACONNECTED (`wifi_event_ap_staconnected_t`:
  MAC, AID, is_mesh_child — 8 bytes), leaving posts AP_STADISCONNECTED (the same layout in IDF
  4.4), both from the WiFi task; `esp_wifi_ap_get_sta_list` fills `wifi_sta_info_t`s (12 bytes:
  MAC, RSSI −45, 11b/g/n bits) and `num`; `esp_wifi_ap_get_sta_aid` finds one; `esp_wifi_deauth_sta`
  turns one (AID 0: every one) away. Frames for the AP interface queue beside the station's (32
  at most) and go to its rx callback the same way; `esp_wifi_internal_tx(WIFI_IF_AP)` sends on
  the AP's LAN (ESP_ERR_WIFI_NOT_STARTED while it isn't hosted). The firmware's own lwIP serves
  it: esp_netif starts its DHCP server (192.168.4.1/24 by default, `WiFi.softAPConfig` another)
  on AP_START, and IP_EVENT_AP_STAIPASSIGNED is its own. A new configuration while it runs, or the
  AP going down (`esp_wifi_stop`, a mode without AP), posts AP_STADISCONNECTED for each station
  first (stations hear `lost`). `esp_wifi_get_channel` reports the AP's channel when no station
  link sets it. AP+STA runs both: a station on an AP part and the soft-AP side by side (two
  subnets — the soft-AP and an AP part both default to 192.168.4.0/24, as on hardware, so a
  sketch moves its AP with softAPConfig); the real ESP32's soft-AP follows its station's channel,
  ours keeps its own. `dispose()` ends a driver (a reset builds a new one): its station leaves,
  its AP closes. Measured layouts: `fixtures/sketches/esp32/wifi-softap` prints them (`layout 8 6
  8 12 6 184 180`); it hosts "benchtop-ap" with a WebServer, `softap-client` joins it from a
  second ESP32 with no AP part on the bench (DHCP 192.168.4.2, three GETs, then leaves), and
  `wifi-apsta` hosts "bridge-ap" at 192.168.5.1 while on the bench's "benchtop"
  (`packages/parts/src/integration/softap.test.ts`; the driver alone: `wifi/softap.test.ts`).

  **Deep sleep (`soc/rtc-cntl.ts`, `soc.ts`).** `esp_deep_sleep_start()` (IDF's open sleep
  code, in the firmware) ends in RTC_CNTL STATE0.SLEEP_EN: the SoC sleeps (`sleeping`; `canRun`
  false for both cores, so the WAITI skip-ahead jumps over it — an hour asleep runs no
  instruction). DIG_PWC.DG_WRAP_PD_EN makes it deep: the digital domain's pending timers (the
  watchdogs among them) are dropped. Wake sources are WAKEUP_STATE's enables: the timer (the
  RTC slow counter reaching SLP_TIMER0/1 — IDF 4.4 sets no MAIN_TIMER_ALARM_EN for sleep), ext0
  (RTC IO EXT_WAKEUP0's RTC GPIO at EXT_WAKEUP_CONF.EXT_WAKEUP0_LV) and ext1 (EXT_WAKEUP1's RTC GPIOs
  all low, or any high, latched in EXT_WAKEUP1_STATUS), checked at sleep entry and whenever the
  bench changes a pad's input (`gpio.onInputs`) — levels, so a button held down wakes the chip again
  each time it sleeps, as on a board. The wake writes WAKEUP_STATE's cause and INT_RAW.SLP_WAKEUP;
  deep, it is a system reset with DEEPSLEEP_RESET (5) — exempt from the rapid-reboot guard — that
  keeps the RTC domain: RTC memory, STORE0–7, the sleep and wake registers (RtcCntl's
  `RTC_DOMAIN` list survives any non-RTC reset now) and RTC IO; the direct boot then skips the app's
  RTC segments, as IDF's bootloader does, so `RTC_DATA_ATTR` counts on. On the way in, the ROM's
  `set_rtc_memory_crc` has RTC_MEM_CONF's CRC unit sum RTC fast memory for the wake stub: modeled
  at once as a CRC-32 (the polynomial isn't documented; only the ROM's wake path, which direct boot
  skips, reads it) — unmodeled, its FINISH bit would never come and the interrupt watchdog would fire. Also:
  an image's `.rtc.text` (IDF's wake stub, at RTC fast memory's instruction address 0x400C0000)
  loads; and an RTC pad routed to RTC with its input enabled (FUN_IE: a wake pin after
  `rtc_gpio_init`) is a digital input with the RTC pulls — only one with its input off (ADC, DAC,
  touch) is analog. `fixtures/sketches/esp32/deep-sleep-timer` wakes every 2 s (boot 2, 3, 4: cause
  TIMER, reset DEEPSLEEP, 2.0–2.4 s apart) and `deep-sleep-pins` on GPIO33 LOW (ext0) and GPIO32
  HIGH (ext1) (`packages/parts/src/integration/sleep.test.ts`, `soc/sleep.test.ts`).

  **Light sleep.** The same SLEEP_EN with DG_WRAP_PD_EN off: the chip sleeps and the run
  goes on where it stopped — RAM, registers and the cores' state kept. The APB clock stops with it,
  so the TIMG groups are gated (`Timg.gate`: counters frozen, alarms cancelled, the MWDT paused with
  its stage time kept) and the RTC WDT pauses when WDTCONFIG0.PAUSE_IN_SLP (bit 7) is set — IDF arms
  it with a 1 s RESET_RTC stage across every light sleep, so without the pause any sleep over a
  second reset the chip. The wake ungates them; IDF then advances esp_timer by the time the RTC
  timer says it slept, so `millis()` counts each sleep once. A further wake source in light sleep:
  GPIO — a GPIO matrix pin with PINn.WAKEUP_ENABLE (bit 10) and a level interrupt type (4 low,
  5 high), `gpio_wakeup_enable` + `esp_sleep_enable_gpio_wakeup` (`Gpio.wakeLevel`), cause GPIO (7).
  `rtc_sleep_init` powers the RF down through four radio-block registers (BB, NRX, FE, FE2 power
  controls): `periph.ts`'s `RADIO_POWER_CONTROL` keeps them from counting as a WiFi driver's
  accesses. `fixtures/sketches/esp32/light-sleep`: ten 100 ms timer sleeps (cause TIMER, millis
  100–103 ms on each), then a minute asleep until the button on D4 — no reboot.

  **PSRAM (`soc/psram.ts`, `spi-flash.ts`, `mmu.ts`, `bus.ts`).** The board menu's PSRAM
  "Enabled" builds with `BOARD_HAS_PSRAM`, and Arduino's `psramInit` runs IDF 4.4's esp32 psram
  driver: it talks to the chip on SPI1 with user commands while SPI_PIN (0x34) has CS0_DIS set
  and CS1_DIS clear — `psram_cmd_recv_start` sets them around each command — so `SpiFlashController`
  sends those to `cs1`, a `QuadPsram` (the quad protocol the ESP32-S3's PSRAM shares): the ID
  (0x9F: MFID 0x0D, KGD 0x5D, EID 0x40 — density 2, 64 Mbit, so 8 MB as on a WROVER-E), reset,
  QPI. The cache side: `psram_cache_init` clears DRAM1 in both CPUs' CACHE_CTRL1 and
  `cache_sram_mmu_set` fills MMU entries 1152–1279 (32 KB pages: CMMU_SRAM_PAGE_MODE 0, the only
  size IDF uses) for 0x3F800000–0x3FBFFFFF with the chip's 32 KB page numbers (`FlashMmu
  .translatePsram`). The bus arms a 64 KB page for the fast path (`PAGE.PSRAM`) when its two halves
  map contiguously, and decides per access otherwise (himem's banks map single 32 KB pages from
  beyond 4 MB). PSRAM shares the flash cache: each load and store looks its block up in the same
  tags (offset by `PSRAM_TAG`), a miss stalling as a flash one — both run at 80 MHz QIO;
  write-back traffic isn't modeled. A masked or invalid access reports `esp32-psram` and faults
  the core. The driver routes SPICS1 to GPIO16 and the clock to GPIO17, as a WROVER wires them:
  the pads show them as peripheral outputs, CS1 idling high (`IDLE_HIGH_SIGNALS`). DPORT's
  HOST_INF_SEL and RTC_CNTL's SDIO_CONF, which the driver touches, are storage. The chip is
  volatile: a deep sleep's wake (VDD_SDIO off) drops its bytes (`QuadPsram.powerOff`), a light
  sleep or a software reset keeps them, and `Mcu.reset` builds a fresh one. Arduino maps 4 MB:
  `ESP.getPsramSize()` 4192123. himem can't be linked into an Arduino sketch — its constructor
  asks for the PSRAM's size before `psramInit` runs and aborts, on a board too. `fixtures/sketches
  /esp32/psram`: found, a 1 MB `ps_malloc` buffer checked, a 256 KB `malloc` in PSRAM
  (`soc/psram.test.ts`, and on the bench in esp32-circuits.test.ts). The board's `module` prop —
  `auto` (the default) or `WROVER-E` (PSRAM), `WROOM-32` (none: `QuadPsram.present` false, CS1
  reads 0 and the MMU maps nothing, so the build's `psramInit` fails as on that board and detaches
  GPIO16/17) — is read by `esp32McuFactory`; an unknown module runs as `auto` with `esp32-module`
  (warning). The gallery's `esp32-psram-frame` (a WROVER-E) keeps a 150 KB frame in PSRAM and
  pushes it to an ILI9341. The module also says the flash chip's size, which RDID reports
  (`FlashChip.jedecId`: EF 40 and the density as a power of two — 16 for 4 MB, 17 for 8, 18 for 16
  — of `chipBytes`, or on `auto` of the flash the image header asked for): `WROOM-32` and
  `WROVER-E` 4 MB, `WROOM-32E-N8` 8 MB, `WROOM-32E-N16` 16 MB (no PSRAM), `WROVER-E-N16R8` 16 MB
  with PSRAM (`ESP32_MODULE_SPECS`); the direct boot's `g_rom_flashchip` carries the same ID. A
  build whose header asks for more than the chip holds stops where a board does: ESP-IDF's
  startup ("Detected size(4096k) smaller than the size in the binary image header(16384k). Probe
  failed.", an assert, the reset loop); one asking for less runs. The chip records the first ID read (`identified`: the build uses PSRAM)
  — from then on `Esp32Mcu.pinClaims()` holds GPIO16/17 on `auto` (a WROVER-E holds them from the
  start), and the pads watch them (`Pads.watchPsram`, also run at the ID read): once a pad has
  carried SPICS1 or SPICLK, firmware that takes it — another matrix signal, an IO_MUX function
  (Serial2's U2RXD/U2TXD), a GPIO output or input — gets `pin-reserved` (warning, once per pad),
  as a board's PSRAM would stop answering; the simulated one keeps working.

  **Touch (`soc/touch.ts`).** The ESP32's version-1 touch sensor, written from IDF 4.4's
  esp32 touch_sensor_ll.h and the SENS/RTC IO/RTC_CNTL headers: T0–T9 on GPIO4, 0, 2, 15, 13, 12,
  14, 27, 33, 32 (`ESP32_TOUCH_PINS`). `Esp32Touch` owns SENS's SAR_TOUCH_CTRL1 (MEAS_DELAY — the
  window in 8 MHz ticks —, XPD_WAIT, OUT_SEL below/above, OUT_1EN), THRES1–5 and OUT1–5 (two pads a
  word: the even slot in 31:16), CTRL2 (MEAS_EN 9:0, MEAS_DONE, START_EN/START_FORCE, SLEEP_CYCLES,
  MEAS_EN_CLR) and ENABLE (WORKEN, OUTEN2, OUTEN1), reached through `RtcCntl`; it reads RTC IO's
  TOUCH_CFG (the reference voltages) and TOUCH_PADn (the slope) and STATE0.TOUCH_SLP_TIMER_EN (23)
  there. SENS swaps pads 8 and 9 (IDF's TOUCH_LL_BITS_SWAP and touch_ll_num_wrap); RTC IO doesn't. A
  round measures every WORKEN pad in turn (XPD_WAIT, then the window); a reading is the
  charge-discharge cycles that fit — window / (2·C·ΔV / I), with the S2/S3 model's constants
  (10 pF pad, 1 µA a slope step) — so a touch lowers it: Arduino's defaults (a 4096-tick window,
  2.7 V / 0.5 V, slope 7) read 81 bare, 67 with a touch pad, 37 with a finger on it. MEAS_DONE
  clears as a round starts; at its end the pads past their thresholds set MEAS_EN (sticky until
  MEAS_EN_CLR) and, when they satisfy OUT_1EN (SET1 alone, or both sets), INT_RAW.TOUCH (bit 6)
  rises — RTC_CORE (46), beside the watchdog's — every round while touched, which is what Arduino's
  touchAttachInterrupt callback sees on a board. In timer mode a round starts SLEEP_CYCLES slow-clock
  cycles (150 kHz) after the last one ended. SENS is in the RTC domain: a digital reset stops a round
  but keeps the registers. The Mcu is the bench's `TouchSensing`; a touch pad reads as analog (RTC IO
  routes it with its input off). Fixtures `touch-read` (T0 and T3) and `touch-interrupt`
  (threshold 40): `soc/touch.test.ts`, `packages/parts/src/integration/esp32-touch.test.ts`.

  **Touch wake.** WAKEUP_STATE's TOUCH (bit 8, RTC_TOUCH_TRIG_EN — `WAKE.TOUCH`): the touch
  FSM is the RTC domain's, so a deep sleep that clears the SoC's events re-arms it (`resume`), and a
  round that would raise the touch interrupt (`onFire`) wakes the sleeping chip with cause TOUCH. The
  wake is a DEEPSLEEP reset in place: SENS keeps MEAS_EN, which IDF's
  `esp_sleep_get_touchpad_wakeup_status` reads for the pad. `sleepState` lists "touch T3 (GPIO15)"
  for the SET1 pads in WORKEN. Fixture `touch-wake` (Arduino's TouchWakeUp shape on T3, threshold
  40): `packages/parts/src/integration/touch-wake.test.ts`, with the S2's and the S3's.

  **Touch end to end:** the gallery's ESP32 touch LED (`esp32-touch-led`: a pad on T0 lights
  the LED on GPIO2 while its reading is below 40) and ESP32 touch wake (`esp32-touch-wake`: the
  `touch-wake` fixture, a pad on T3), and the S3 touch lamp (`esp32s3-touch-lamp`: the S2's sketch on
  the DevKitC-1's RGB LED) — specs in fixtures/specs/examples and checks in `examples-run-esp32.test.ts`
  and `examples-run-esp32s3.test.ts`; MCP's `sim_state` shows the ESP32 asleep with "touch T3
  (GPIO15)" as its wake until `sim_input` touches the pad (`sessions.test.ts`).

  **The ESP32-C3's sleep (`packages/esp32c3`).** RTC_CNTL at its C3 offsets (`rtc-cntl.ts`):
  STATE0.SLEEP_EN (0x18) with DIG_PWC (0x88) bit 31 for deep; WAKEUP_STATE (0x3C) ENA bits 31:15
  (TIMER 8, GPIO 4); the timer target in SLP_TIMER0/1 (0x04/0x08); SLP_WAKEUP_CAUSE (0xF8, read-only)
  the cause; INT_RAW (0x44) bit 0 the wake, cleared through INT_CLR (0x4C). The deep-sleep GPIO
  wake is RTC_CNTL_GPIO_WAKEUP (0x110): GPIO0–5, each with an enable (bit 31−n) and a 3-bit type
  (bits 23−3n, 4 low / 5 high), STATUS (5:0) latched, cleared by bit 6 —
  `esp_deep_sleep_enable_gpio_wakeup`. Light sleep's GPIO wake is the matrix's, as on the ESP32.
  The SoC (`soc.ts`) sleeps as the ESP32's: deep drops the digital timers, light gates both TIMGs;
  the run loop jumps asleep to the next event or the target. Deep's wake is a reset: the SoC stops
  with `resetRequested` and reason DEEPSLEEP, and the Mcu builds a fresh chip at the same time (the
  software-reset path) carrying RTC fast memory, the RTC timer's origin and the RTC domain's
  registers (`rtcDomain` / `keepRtcDomain`: the sleep timer, wake enables and cause, GPIO_WAKEUP,
  STORE0–7); the direct boot keeps RTC fast memory on any reset but power-on and skips the app's
  RTC_FAST segments on DEEPSLEEP. Deep sleep's wakes don't count toward the reboot-loop guard.
  IDF's `rtc_deep_sleep_start` on the C3 CRCs RTC fast memory through SYSTEM's
  RTC_FASTMEM_CONFIG / RTC_FASTMEM_CRC (0x48 / 0x4C — not RTC_CNTL, as on the ESP32) and spins on
  FINISH: modeled at once (`system.ts`). One more C3 change: IDF isolates every pad for sleep at
  startup (`gpio_sleep_set_direction`, `gpio_sleep_sel_en`) with read-modify-writes of IO_MUX's
  sleep fields; such a write no longer counts as configuring the pad, which had made every
  floating pin warn as "read while floating" at the first `digitalRead`. Fixtures:
  `esp32c3/deep-sleep` (the timer every 2 s and GPIO4 LOW; boot count in `RTC_DATA_ATTR`) and
  `esp32c3/light-sleep` (the ESP32's sketch) on `fixtures/projects/esp32c3-sleep.json`.

  **Sleep in the hosts.** `packages/core/src/bench/sleep.ts`: an MCU that can sleep opts
  in with `sleepState()` (`Sleeper`, found by `usesSleep` — not a contract, as `NonVolatile`):
  deep or light, nanoseconds until the RTC timer wakes it (null when it doesn't) and its armed wake
  pins in words ("GPIO4 low", ext1's "GPIO32 high (any)"). Both ESP32 MCUs answer from their SoC's
  `sleepWakes()`. `Bench.sleepOf(board)` turns the timer's wake into a bench time. The worker puts
  every sleeping board into its frames' stats (`FrameStats.sleep`, protocol 17) and the canvas
  draws a badge above it — "Deep sleep wakes on timer in 3.2 s · GPIO4 low" — outside the parts'
  own views (so image export leaves it out). The MCP's `sim_state` lists the boards asleep
  (`sleeping`: deep or light, `timerWakesAt`, `wakePins`). The gallery's ESP32 deep sleep example
  (`fixtures/sketches/esp32/deep-sleep-counter`, project `esp32-deep-sleep`) wakes every 5 s and on
  the button on D4 (ext0), counting both in RTC memory. One diagnostic changed with it: an APP_CPU
  read of RTC FAST memory raises `esp32-rtc-fast-app-cpu` only when the word holds something other
  than the 0 it reads — IDF 4.4's `esp_sleep_start` reads its `RTC_FAST_ATTR` `s_adc_tsen_enabled`
  (false) on whichever CPU sleeps, the APP_CPU in Arduino's `setup()`; writes still always warn.

  **Crypto accelerators (`soc/crypto/`).** Arduino-ESP32 2.0.17 builds mbedTLS with
  CONFIG_MBEDTLS_HARDWARE_AES, _SHA and _MPI, so its hashes, ciphers and bignum work run on the
  accelerators at 0x3FF01000 (AES), 0x3FF02000 (RSA) and 0x3FF03000 (SHA). They are modeled at
  the register level (the math in TypeScript: `sha-math.ts` FIPS 180-4, `aes-math.ts` FIPS 197),
  each operation complete when started — BUSY reads 0, IDLE 1 (the real blocks take tens of
  cycles a block, which firmware only polls through). DPORT_PERI_CLK_EN / PERI_RST_EN (0x01C,
  0x020: AES bit 0, SHA bit 1, RSA bit 2) gate them: unclocked or in reset a block reads 0 and
  drops writes; going into reset clears it. **SHA:** TEXT (32 words) holds a 512- or 1024-bit
  block as big-endian words (IDF's `sha_ll_fill_text_block` byte-swaps; the ROM's
  `ets_sha_finish` pads in the registers), and per type t (SHA-1, -256, -384, -512) START,
  CONTINUE, LOAD and BUSY sit at 0x80 + 0x10·t; TEXT is shared but each engine — SHA-1,
  SHA-256, SHA-384/512 together — keeps its own state, so messages of different engines
  interleave (IDF locks them separately, and TLS 1.2 hashes its transcript with SHA-256 and
  SHA-384 at once: a single shared state broke the first HTTPS handshake); LOAD puts the
  digest into TEXT, SHA-384/512's 64-bit words as high then low (what
  `sha_ll_read_digest` swaps back). **AES:** MODE 0–2 encrypt and 4–6 decrypt with a 128/192/256-bit
  key, KEY_0–7 and TEXT_0–3 as little-endian words (IDF memcpys them; the ROM packs byte 0
  lowest) — the order at AES_ENDIAN's reset value, which IDF never changes (other values are
  kept, not modeled); the key is expanded once per key. Tested through the registers on FIPS
  vectors and against Node's crypto, and end to end by `fixtures/sketches/esp32/crypto-kat`
  (mbedTLS SHA-1/256/384/512 and AES ECB/CBC, printed and compared with Node).
  **RSA (`rsa.ts`):** four 512-byte memory blocks — M (0x000), Z (0x200), Y (0x400), X
  (0x600) — of words least significant first, M_DASH, MODEXP_MODE/START, MULT_MODE/START,
  INTERRUPT (1 once done; write 1 clears; IDF polls it — CONFIG_MBEDTLS_MPI_USE_INTERRUPT is off)
  and CLEAN (1 when ready). As the ROM's `ets_bigint_*` drivers drive it: MULT with MULT_MODE =
  n/16 − 1 (n words) is a Montgomery multiplication Z ← X·Z·R⁻¹ mod M (R = 2^(32n)) — IDF's port
  exponentiates with these on the ESP32 (ESP_MPI_USE_MONT_EXP: the hardware MODEXP is slow for
  public keys); MULT_MODE ≥ 8 a plain multiplication (L = 16·(mode − 7) words: A in X's low
  half, B in Z's high half, the L-word product into Z); MODEXP Z ← X^Y mod M. BigInt does the
  arithmetic, M' isn't needed and is kept. DPORT_RSA_PD_CTRL bit 0 powers the memories down
  (the block reads 0). `fixtures/sketches/esp32/rsa-kat` (mbedtls_mpi_exp_mod at 512–3072 bits
  with e = 65537 and full-length exponents, mbedtls_mpi_mul_mpi) matches BigInt.
  **HTTPS.** With the three accelerators, mbedTLS's TLS 1.2 handshake completes:
  `fixtures/sketches/esp32/https-get` (WiFiClientSecure with a CA from serial, or
  setInsecure(); HTTPClient GET) reaches a node:tls server through the access point's gateway
  and `--network` — ECDHE-RSA-AES128-GCM-SHA256, the server's certificate checked against the
  CA, about 260 ms of simulated time for handshake and GET; a CA that didn't sign the server
  fails the handshake (GET −1), as on a board. The test makes its CA and server certificate at
  run time (`apps/cli/src/tls.test-helper.ts`: keys from node:crypto, X.509 v3 DER by hand,
  signed with `crypto.sign`), so no key is committed. Certificate dates aren't checked
  (CONFIG_MBEDTLS_HAVE_TIME_DATE is off in Arduino's build), so no clock is needed for HTTPS.

- **RP2040** — `@benchtop/rp2040` wraps [rp2040js](https://github.com/wokwi/rp2040js)
  1.4.0 (MIT, Wokwi): its Cortex-M0+ core 0 and peripherals (GPIO, SIO, PWM, timer, UART, I2C,
  SPI, ADC, PIO, DMA, USB). Core 1 isn't simulated yet: its bootrom's side of the FIFO is
  (below). `createRp2040Mcu()` /
  `rp2040McuFactory` give the bench an `Mcu` of kind `'rp2040'` (an additive contract change,
  with `FirmwareImage { format: 'uf2' }`).

  **Time.** `cycles` count a 125 MHz reference clock (8 ns), whatever clk_sys the firmware
  programs (arduino-pico runs 133–200 MHz); each instruction takes rp2040js's cycle count at the
  current clk_sys (a clock listener follows it). The adapter owns rp2040js's `IClock`
  (`clock.ts`): nanoseconds plus the alarms the timer, ADC, PWM and UART schedule, ticked once per
  instruction (one compare when nothing is due); while the core waits in WFI/WFE the loop jumps
  to the next alarm (unless PIO runs: see below). Measured: blink (mostly asleep in `delay`) ≈
  13× real time (≈ 6× before the USB fix below), a busy loop ≈ 15 % (rp2040js's decoder is
  an if-chain), an idle MicroPython REPL ≈ 500×.

  **Our bootrom** (`bootrom/`; the real one isn't used — its float library may only run on an
  RP2040 device, or under GPLv2). The datasheet's §2.8.3 fixed header (table 163: boot stack
  0x20042000, reset/NMI/HardFault handlers, 'M' 'u' 0x01, version 3, the 16-bit pointers to the
  function table, the data table and `rom_table_lookup`), every function and data code of
  tables 164–168 and 171, and the soft float/double tables of tables 169/170 (each preceded at
  table − 2 by its size in words, which the SDK checks). Every entry is a 4-byte Thumb stub,
  `bkpt #id; bx lr`; the adapter catches a BKPT whose PC is inside the ROM and runs the function
  in JS (`handlers.ts`, `float.ts`), charging the datasheet's average cycles. Float semantics
  follow §2.8.3.2.1: correctly rounded basic operations, denormals in and out as zero, NaNs in
  and out as infinities (+∞ unless the datasheet gives a sign), conversions to integers rounding
  toward −∞ and clamping; fsin also returns the cosine in r1 (dsin in r2:r3), which the SDK's
  sincosf relies on. Flash functions work on offsets from the start of flash: erase writes 0xFF,
  program ANDs bits in; the XIP enter/exit/flush functions have nothing to do (rp2040js serves
  XIP reads from the flash array). `reset_to_usb_boot` reports `rp2040-usb-boot` and halts;
  `_wait_for_vector` (core 1) faults. A BKPT outside the ROM halts with a fault (no debugger: on
  the board, a HardFault).

  **What our bootrom leaves (direct boot).** Reset runs the ROM's reset stub, which boots the
  loaded image directly instead of the real sequence (flash second stage, checksum, BOOTSEL):
  for a flash image, VTOR = 0x10000100 (the vector table after the 256-byte second stage, which
  isn't run: rp2040js needs no SSI setup for XIP reads), SP and PC from that table; for a
  RAM-only UF2, PC = its lowest address and SP = 0x20042000 (datasheet §2.8.4.2). A flash with no
  valid vector table halts as "BOOTSEL mode". Clocks, pads and peripherals are as rp2040js resets
  them; the SDK's runtime init programs what it needs. Flash keeps what the firmware programmed
  across `reset()` (and across a load, which programs only the image's sectors).

  **Firmware.** UF2 (`@benchtop/core`'s `firmware/uf2.ts`, shared with the RP2350:
  512-byte blocks, magics, payload sizes, block numbers and totals — sequences may follow one
  another, as picotool's RP2350-E10 block does, each block keeping its family —, the family ID
  0xE48BFF56; blocks flagged "not main flash" are skipped; every block must lie in
  flash 0x10000000–0x10FFFFFF or RAM 0x20000000–0x20041FFF) or ELF (PT_LOAD segments at their
  physical addresses).

  **Pins and buses.** `GPIO0`–`GPIO29` as `McuPin`s: SIO outputs are `output`; PWM and PIO
  outputs, UART TX/RTS and SPI CSn/SCK/TX are `peripheral` (UART and SPI bytes travel at byte
  level, so those pins idle); GPIO26–29 with input disabled and function NULL are `analog`;
  otherwise inputs with the pads' pulls. Inputs use a Schmitt trigger (high ≥ 2.0 V, low ≤ 0.8 V,
  datasheet §5.5.3); GPIO26–29 also feed ADC channels 0–3 (12-bit of 3.3 V) and channel 4 (the
  temperature sensor) reads 0.706 V (27 °C). UART 0 is USB serial (arduino-pico's `Serial`):
  rp2040js's CDC host enumerates the device; bytes sent before that are lost, as on a board.
  rp2040js's host answers every OUT endpoint the device arms at once — with an empty packet
  when it has nothing to send — so TinyUSB re-armed in a loop and the USB interrupt fired every
  ~27 µs (an idle MicroPython REPL ran at 27 % of real time and never slept); a real host sends
  OUT data only when it has some, so the adapter holds an arm until bytes are queued.
  UARTs 1 and 2 are UART0 and UART1: `pins()` from the GPIO function select, `baud()` from the
  divisors, received bytes paced at 10 bits each. I2C and SPI controllers 0 and 1 implement the
  bus contracts (rp2040js's I2C callbacks completed at once; SPI transfers to the selected
  devices), with arduino-pico's default pins before the firmware routes them — that glue, and
  USB serial's, is `bridges.ts` (`I2cBridge`, `SpiBridge`, `UsbSerialBridge`), which the RP2350
  adapter uses too. rp2040js's
  warnings about registers it doesn't model become one `info` Problem (`rp2040-unimplemented`).

  Three rp2040js gaps the adapter covers: core 1 (below); its PWM
  compare alarms, which reschedule themselves with a zero delay while a slice
  counts with its 32-bit reset TOP — our clock defers an alarm that re-fires at the same instant
  by one 8 ns reference cycle, so the core keeps running; and its I2C abort, which flushes the
  TX FIFO but raises TX_EMPTY only when a data byte goes out. After an address NACK (a bus
  scan's empty address, a part taken off the bus) TX_EMPTY stayed low, and the pico-sdk's
  `i2c_write_blocking_internal`, which waits for TX_EMPTY before it reads TX_ABRT, spun until
  Wire's timeout (Stream's 1 s) ended it: a one-byte-write scan of 0x08–0x77 took 111 s and
  `endTransmission` returned 5. `I2cBridge.wire` gives each controller an `abort` that raises
  TX_EMPTY after the flush, as the DW_apb_i2c does with TX_EMPTY_CTRL (`raiseTxEmptyOnAbort`;
  the RP2350 shares it). The scan now takes ≈350 µs of simulated time (the bus is transaction
  level, so no 100 kHz bit time) and an empty address gives 4 — arduino-pico 6.2.0's
  `endTransmission` maps the SDK's PICO_ERROR_GENERIC to 4, not the AVR core's 2. The
  `i2c-scan` fixtures (pico, pico2) test it, with a part attached, detached and on a bench.

  **Core 1 (`core1.ts`).** rp2040js emulates one Cortex-M0+ and reads `rp.core` (and
  `rp.ppb`) wherever a core matters. `DualCore` puts a second core of the same kind on the chip
  and makes those per core (datasheet §2.3.1, §2.4.8). Each core has its own PPB — rp2040js's
  `RPPPB` reads `this.rp2040.core`, so each PPB gets a view of the chip (`Object.create(rp)`)
  whose `core` is its own, and SysTick fires into its own core. While a core executes,
  `rp.core` and `rp.ppb` are its own and the SIO's divider and interpolator state is swapped in
  (`switchTo`, preallocated). A peripheral's IRQ line goes to both NVICs (`rp.setInterrupt`
  fanned out; each core enables its own); SIO_IRQ_PROC0/1 only to their core. The SIO: CPUID
  reads the executing core; each core's RX FIFO (8 words, written by the other core) with
  FIFO_ST's VLD/RDY and sticky WOF/ROE (write 1 to clear). Core 1 starts in its bootrom's wait
  for a launch (§2.8.2), played in JS: released from reset (PSM FRCE_OFF.proc1 cleared, as
  `multicore_reset_core1` does) it pushes a 0; it echoes each word of the launch sequence (0, 0,
  1, vector table, SP, entry) and starts at the entry with that VTOR and SP; forced off again it
  is a fresh core in the wait. Once core 1 runs, SEV on either core sets both event flags and
  wakes a WFE (a fast-core hook; rp2040js's SEV only logs, and a one-core run keeps that, so
  the lockstep test holds). A sleeping core takes a pending SysTick or PendSV before the run
  loop lets it sleep on (rp2040js sets only the pending flag for those; core 1 waits in WFE with
  its SysTick running). Not modeled: IO_BANK0's per-core interrupt enables (PROC1_INTE…), so
  core 1 sees bank 0's line through PROC0's. Running: while core 1 runs, the run loop
  alternates the cores in slices of at most 5 µs, never past the next alarm or the target —
  core 0 batched as before (the clock follows it), then core 1 batched up to where core 0 got,
  or to the slice's end when core 0 fell asleep in it (time goes on). Core 1 keeps its own time
  (`core1Nanos`, at most a slice behind) and the clock shows it while core 1 runs
  (`beginSide`/`endSide`: `nanos` = its start plus its retired cycles), so a timer it reads is
  its own instruction's; alarms fire as the clock moves. A sleeping core costs nothing; both
  asleep, time jumps to the next alarm. With PIO running or a breakpoint set, core 0 goes one
  instruction at a time and core 1 catches up (batched) after each; core 0 asleep, core 1
  drives time. One-core sketches never enter any of this. MicroPython busy on both cores
  (`_thread` spinning beside the main loop) runs 0.5 s in 1.74 s on an M1, one core busy in
  0.91 s: the second core costs what its instructions cost.
  `fixtures/rp2040/core1.c` (freestanding) checks CPUID, the FIFOs both ways, each core's
  SysTick at its own reload, a TIMER interrupt reaching only the core that enabled it, SEV
  waking WFE, FIFO_ST's flags, and a reset and second launch (`core1.test.ts`); MicroPython's
  `_thread` prints from core 1 (`micropython.test.ts`).
  **High-level emulation (`hle.ts`).** As on the ESP32 (Xtensa) and the ESP32-C3
  (`@benchtop/riscv`), a firmware function can be answered by TypeScript —
  `Rp2040Mcu.setHle(table)`, `Rp2040Hle.replace(address, name, handler)` — for the Pico W's
  CYW43 at its driver's API. Both cores decode per halfword (rp2040js's if-chain, the fast core's
  `OP_OF`), so the trap is in memory: `install` writes `UDF #0x48` over each replaced function's
  first halfword in flash and keeps the original (restored by `setHle(null)`; written again after
  every image write — `load`, and a MicroPython reset). A UDF reaches rp2040js's `onBreak`, where
  the adapter asks the table first (`has(pc)`, the PC's Thumb bit masked: an exception entry
  leaves it set), so nothing else pays, on the stock and the fast core and on core 1 (DualCore
  puts the running core in `rp.core`). Only functions in flash: one the startup copies to SRAM
  would need its load address. The call is AAPCS: r0–r3, more at sp, r0 back, return through
  `BXWritePC(lr)` — a replaced exception handler returns through EXC_RETURN. A generator's call
  gets a 144-byte frame (16 bytes of stack arguments, 128 of scratch, 8-aligned) with the
  caller's lr kept beside it; its steps run at `HLE_RESUME` (0x0E00, a `udf #0x48` in our
  bootrom), where calls out return (lr = 0x0E01), and the frame is found again by sp — each
  core has its own stack, and an interrupt taken meanwhile stacks below the frame.
  `fixtures/rp2040/hle.c` (freestanding) tests five arguments, generators, two waiting at once
  and a recursion 50 deep around one, stack arguments and scratch memory in a call out, a
  replaced SysTick handler, and both cores inside a generator at the same time (`hle.test.ts`;
  the stock core gives the same results for core 0's part — its SEV doesn't wake core 1).

  **The Pico W's CYW43439 (`cyw43/`).** A Pico W firmware (arduino-pico's
  `rp2040:rp2040:rpipicow`) carries the open cyw43-driver and the chip's closed firmware blob,
  which the driver would upload over a PIO-driven gSPI bus (GP23 WL_REG_ON, GP24 data and
  host-wake, GP25 CS, GP29 clock). Neither the bus nor the chip is modeled; the driver's own
  low-level layer — the functions of `cyw43_ll.c`, the only code that talks to the bus — is
  answered by name through the HLE, and everything above it runs as built: `cyw43_ctrl.c` (the
  join state machine fed by async events, scan bookkeeping, link up/down to lwIP), the SDK's
  `cyw43_arch` and async context, lwIP, arduino-pico's WiFi. `Cyw43` answers `cyw43_ll_init`
  (keeps the `cyw43_ll_t` address and the callback data, the `cyw43_t`), `cyw43_ll_bus_init`
  (the chip is up: no upload), `cyw43_ll_wifi_get_mac` (the OTP MAC — CYW43_USE_OTP_MAC — so
  the board's), `cyw43_ll_gpio_set/get` (WL_GPIO0–2; WL_GPIO0 is the LED), `cyw43_ll_wifi_on`,
  power management and multicast filters (accepted), `cyw43_ll_ioctl` (GET_VAR answers zeros),
  and the poll path: work for the firmware (async events, received frames) waits in a queue
  while the chip holds host-wake (GP24) high; the SDK's level-high GPIO interrupt on GP24
  schedules `cyw43_do_poll` on the async context, `cyw43_poll_func` asks `cyw43_ll_has_work`,
  and `cyw43_ll_process_packets` hands each item, written into the `cyw43_ll_t`'s own 2108
  bytes (the replaced layer doesn't use them), to `cyw43_cb_process_async_event` or
  `cyw43_cb_process_ethernet` (arduino-pico links `__wrap_cyw43_cb_process_ethernet`), then
  drops host-wake. `Rp2040Mcu({ cyw43 })` attaches it: `useSymbols` installs the answers, the
  pin `WL_GPIO0` is the chip's GPIO 0, GP24's input is host-wake, ADC3 (GP29) reads 0 —
  arduino-pico's `CheckPicoW()` reads ADC3 and GP25 and takes a low ADC3 for a Pico W; without
  symbols the firmware raising GP23 (the real driver powering the chip) reports
  `rp2040-cyw43-no-symbols` once (the sketch runs on: the real driver's bus bring-up times out
  and each LED write returns an error). The `raspberry-pi-pico-w` part is the Pico's footprint
  and header with a `WL_GPIO0` point at the LED in place of TP5; the RP2040 factory makes a
  Pico W of any board whose pin map names `WL_GPIO0` (no contract change), with Raspberry Pi's
  28:CD:C1 and three bytes hashed from the part id as its MAC. `fixtures/sketches/picow/blink`
  blinks the LED through `cyw43_ll_gpio_set` every 500 ms (`cyw43/cyw43.test.ts`,
  `packages/parts/src/integration/picow.test.ts`); the compile bridge and the MCP server build
  for `rp2040:rp2040:rpipicow`; MicroPython isn't offered on it (the Pico W's UF2 isn't fetched).

  **The Pico W's station.** The same chip on the bench's radio (`Rp2040Mcu.joinWifi` →
  `Cyw43.setRadio`), in the chip's own words: what cyw43_ll.c would have parsed out of the bus
  becomes `cyw43_async_event_t`s (140 bytes; the scan result, 92, at offset 48 — measured with the
  Pico W's toolchain by `fixtures/sketches/picow/wifi-layout`) for cyw43_ctrl.c. A scan
  (`cyw43_ll_wifi_scan`) dwells 40 ms on each of 13 channels and reports each access point as an
  ESCAN_RESULT (status 8) when it reaches that channel — `auth_mode` as cyw43_ll.c computes it
  (privacy 1, WPA 2, RSN 4: a WPA2 network is 5, which arduino-pico shows as CCMP) — hidden ones
  only to a scan for their SSID, then the end (status 0). A join (`cyw43_ll_wifi_join`) searches the
  same way and answers as the chip does, which cyw43_ctrl.c's join state machine reads: found,
  security matching and key right — AUTH (0), LINK (up; the station joins the AP's LAN here),
  SET_SSID (0), then for a protected network PSK_SUP keyed (6) 20 ms later; the driver's state is
  then complete and it brings lwIP's link up. Not found — or with security the join can't speak
  (a key for an open network, none for a protected one: the chip prunes it) — SET_SSID (3), "no
  network". A wrong key: AUTH, then PSK_SUP failed a second later: "bad auth". A new join cancels
  one under way. The SET_DISASSOC ioctl (`WiFi.disconnect()` → `cyw43_wifi_leave`) and an access
  point switched off (after 6 s without beacons) report DISASSOC: link down. `cyw43_ll_send_ethernet`
  puts lwIP's frames on the LAN (a pbuf chain when the caller says so; refused while not
  associated, as by the chip), and the LAN's frames for the station queue (32 at most) for the poll
  path into `__wrap_cyw43_cb_process_ethernet`. The ioctls answer GET_VAR "cur_etheraddr" (the
  MAC), GET_RSSI, GET_SSID and GET_CHANNEL. The soft-AP (`cyw43_ll_wifi_ap_*`) reports
  `rp2040-cyw43-unsupported`. Bring-up also leaves the pins as the real gSPI setup does (GP23 and
  GP25 driven high, GP24 a SIO input with its pad listening): without that, host-wake's level
  interrupt never fired and work only moved on the driver's 50 ms housekeeping polls, which stop
  after ≈ 2.5 s. arduino-pico's side, seen through it: after `WiFi.mode()` its `begin()` returns at
  once (ESP8266 compatibility); its `status()` maps the driver's link — down 0, joined 3 with an
  address (else 6), fail / no network / bad auth 4; its first DHCP discover goes out before the
  association completes and is lost (as on a board), so the address comes with lwIP's retry, ≈ 2 s
  after the join. Measured: `fixtures/sketches/picow/wifi-scan` (scan, join, DHCP) runs 6 s
  simulated in ≈ 0.3 s wall, `wifi-http-get` GETs and POSTs to an http-server part in ≈ 0.45 s
  (`packages/parts/src/integration/picow.test.ts`, which also drives `wifi-connect`: a wrong key,
  an absent SSID, leaving, an AP switched off, an open network).

  **The Pico W in the gallery.** The board's own drawing (`views/raspberry-pi-pico.ts`, the
  Pico's with the CYW43439 under its shield can, the PCB antenna past it and the SWD pads moved up
  beside the RP2040); the gallery's WiFi category gains a Pico W web server (`picow/wifi-webserver`:
  "picow-web", `/led?state=on|off` switching the onboard LED through the CYW43, two HTTP client
  parts) and a Pico W HTTP client (`picow/wifi-http-get`), each with a spec and a check in
  `examples-run-picow.test.ts`; the app's symbol glob carries their `.syms.tsv` (read as Thumb);
  `sim_wifi` lists Pico W boards (a board whose pin map names `WL_GPIO0`). The web server joins
  ≈ 2.0 s into a run and answers an HTTP client part within 5 ms.


  **PIO and DMA.** rp2040js runs PIO from `setTimeout`, apart from simulated time and
  ignoring clock dividers and delays; the adapter turns that off and steps the eight state
  machines itself (`pumpPio`): each executes its next instruction once its wait — the
  instruction's cycles, delay included, × its clock divider, in clk_sys cycles — has passed, all
  of them in time order with the clock moved to each step, so PIO pin changes reach the bench at
  their own times even inside a long CPU instruction (an exception entry, a ROM call's charged
  cycles). While the core sleeps, PIO steps up to the next alarm; once every running machine is
  stalled (on a FIFO, a pin or an IRQ) and has looked at its condition since the core last ran,
  the bench last called `runUntil` and the last alarm fired (the clock counts fired alarms),
  nothing can change before the next alarm and the loop jumps to it. Measured: one state machine
  stepping 640,000 times a simulated second costs ≈ 15 % (pio-square ≈ 5× real time against
  blink's ≈ 6×). DMA is rp2040js's own, paced by the peripherals' DREQs; SPI frames wider than
  8 bits (the SDK's 16-bit mode, as a DMA fill uses) travel to the bus as two bytes, MSB first.

  **The Pico board.** `raspberry-pi-pico` (packages/parts/src/boards): our own pin table
  from the datasheet's mechanical drawing and pinout — 21 × 51 mm, two rows of 20 castellated
  pads on 2.54 mm, 17.78 mm apart (it straddles a breadboard's channel with two free rows each
  side), pin 1 GP0 top left, USB up; GP0–GP22 and GP26–GP28 map to GPIOn, the eight grounds (AGND
  included) are one bus, 3V3 is a 3.3 V supply and VBUS/VSYS carry USB's 5 V while `usbPowered`
  (default). The onboard LED is GP25, which no header carries: the board's TP5 test pad (GP25 on
  the real board) is a pin, off the 2.54 mm grid so no hole lies under it, and the model watches
  it (visual `led`, PWM-dimmed). The view is our own SVG (apps/web/src/views/raspberry-pi-pico.ts).
  The bridge allows `rp2040:rp2040:rpipico` and returns the build's UF2 (artifact `uf2`); a new
  sketch on a Pico starts from a blink-and-count template.

  **Tests.** `fixtures/sketches/pico/` (built for `rp2040:rp2040:rpipico`, arduino-pico 6.2.0;
  the UF2 is committed): blink toggles GP25 every 500 ms ±1 %; serial-hello prints on USB serial,
  UART0 (GP0/GP1) and UART1 (GP4/GP5); float-math's results through the ROM's tables match the
  host's to the printed digits; pwm-fade measures 1 kHz ±1 % at the duty given. On benches
  (packages/parts integration/pico-circuits.test.ts): a pot on GP26 reads 12-bit within ±8,
  Adafruit SSD1306 over Wire (GP4/GP5) and the ILI9341 driver over SPI0 draw their pictures, an
  `attachInterrupt` on GP14 counts each button press once; multicore (`setup1()`/`loop1()`)
  blinks GP15 at 2 Hz from core 1 beside GP25 at 1 Hz from core 0 and trades words through
  `rp2040.fifo` (`core1 on 1`, `fifo 3 -> 30`), also a gallery example ("Pico dual core") and a
  spec. `fixtures/rp2040/romcalls.c` (freestanding, built with
  arduino-pico's arm-none-eabi-gcc by scripts/rp2040-programs.ts, loaded as an ELF) calls every
  bootrom function through `rom_func_lookup`/`rom_data_lookup` as the SDK does. PIO and DMA
  (packages/rp2040 pio.test.ts and the integration tests): pio-square, a two-instruction
  program on PIO1, measures 10 kHz ±0.5 % at a 50 % duty on GP3; neopixel's WS2812 program (our
  own .pio, assembled by arduino-pico's pioasm into the committed .pio.h) sends 0 and 1 bits high
  for 250 and 875 ns ±10 ns and lights a NeoPixel strip with the sketch's colors; spi-tft-dma,
  whose rectangles are DMA fills into SPI0 in 16-bit frames paced by its TX DREQ, draws exactly
  spi-tft's picture.

  **The core.** rp2040js's `CortexM0Core` finds an instruction by testing its opcode against an
  if-chain of ~90 patterns. `m0/fast-core.ts` subclasses it — the class is taken from an
  RP2040's own core, since rp2040js doesn't export it — and replaces only `executeInstruction`:
  `OP_OF` (built once, by the same tests in the same order, for all 65,536 first halfwords) names
  the instruction and a switch runs it; 32-bit encodings (0xE800 and up) stay one case that tests
  BL, DMB, DSB, ISB, MRS, MSR and UDF.W in rp2040js's order. Fetches and the common loads and
  stores read SRAM and flash from the arrays rp2040js's bus uses, under the same range checks;
  everything else goes through the bus. The exception model, the NVIC and SysTick fields the PPB
  reads, `BXWritePC` and the special registers are inherited. Results, flags, PC, cycles and
  warnings equal the stock core's, quirks included (the carry after a shift by 0 or by 32 and
  more, PC + 2 for an unknown 32-bit instruction): `m0/m0.test.ts` runs both cores in lockstep on
  every Pico fixture (≥ 100,000 instructions each), through MicroPython's boot and raw-REPL
  install (≥ 1,000,000), and on 20,000 random instructions from random states, comparing
  registers, flags, exception state, cycles and memory after each. `createRp2040Mcu({ core:
  'stock' })` keeps rp2040js's core (the reference). Alone the table is ≈ 10 % faster: the call
  per instruction and the run loop around it cost more than the decoding, which batching
  addresses.

  **Batched runs.** With no PIO machine running and no breakpoint set, the run loop hands the
  core every instruction up to the next alarm (or the run's target) in one `runCycles` call: one
  loop around the switch, the hot cases inline (conditions, CMP, literal loads, PUSH/POP on an
  SRAM stack, BL/BX), `cycles` caught up when the loop returns. The clock (`clock.ts`) keeps
  instruction time anchored — `anchor + count × ns per cycle`, never a running sum — so a batch
  and one instruction at a time reach exactly the same times; sleeping, PIO idling and a
  clk_sys change move the anchor. Inside a batch `nanos` follows the core's `retired` cycles (the
  instructions' own counts: rp2040js's SIO divider adds 8 to `cycles` outside them), so a
  peripheral reading the time sees its instruction's start. A batch ends after the instruction
  that arms an alarm sooner than its end, starts a PIO machine (`pio.run`), changes clk_sys,
  sleeps (WFI/WFE) or makes a ROM call (BKPT: the adapter charges its cycles); the bounds are
  found with the very sums one instruction at a time makes (`cyclesUntil`). `batch.test.ts`
  runs every Pico fixture and MicroPython's install batched and one at a time (a breakpoint no
  code reaches forces the latter) and compares cycles and registers every 50 µs; RAM programs
  show timer reads advancing inside one batch and an alarm armed mid-batch firing on time.
  `perf.test.ts` (run alone, after the other tests) pins the busy loop: on an Apple M1
  float-math's spinning `loop()` runs ≈ 165 MHz of its 200 MHz clk_sys per wall second against
  rp2040js's ≈ 42 (3.9×); 2 s of it, boot and JIT warm-up included, takes 2.9 s instead of
  10.3 s with rp2040js's core and a clock tick per instruction (3.5×). Sleeping sketches were
  already fast (blink: 2 s in 0.05 s).

  **Debugger.** `Rp2040Mcu.debug()` (`debug.ts`) is core 0's `McuDebug`: r0–r12, sp,
  lr, pc, xpsr from rp2040js's core. Memory `data` reads our bootrom, flash (every XIP alias),
  SRAM and the USB DPRAM from their arrays — peripheral registers read 0, since rp2040js has no
  side-effect-free path into them —; writes reach SRAM and DPRAM; `flash` is the chip from
  offset 0. The adapter's run loop calls `executeInstruction` itself, so breakpoints are a check
  before it, made only while a breakpoint exists: a pending interrupt is taken first (as
  `executeInstruction` would) so a handler's first instruction can stop, then a PC on a
  breakpoint returns `breakpoint`, and the next run executes it unchecked. `stepCore0` executes
  one instruction with PIO and the clock moved as in a run (asleep: up to the next alarm).
  `instructionAt`: 32-bit Thumb-2 when the first halfword's top five bits are 0b11101–0b11111;
  calls are BL and BLX. Symbols from nm listings drop Thumb's bit 0 (`SymbolTable.fromNm(text,
  true)`; `fromElf` does it for Arm ELFs).

  **MicroPython.** A `{ format: 'micropython', files, main }` image runs on the stock
  MicroPython 1.29.0 UF2 (`micropython-manifest.ts`, fetched by `npm run fetch:micropython`
  after you approve the download, into `.cache/micropython`, size and SHA-256 pinned, never committed;
  `createRp2040Mcu({ micropython })`, `rp2040McuFactory(…, micropython)`; without it the board
  reports `micropython-missing` and halts). The Pico 2 runs the same way on the RPI_PICO2-RISCV
  UF2 (see the RP2350 section). Every load and reset starts the interpreter's image
  with an empty flash filesystem and puts the sketch on the board as an IDE does, over USB
  serial (`micropython.ts`, `MicroPythonInstaller`): CR until the friendly REPL's `>>> `,
  Ctrl-A into the raw REPL, per file part (≤ 2 KB, in `f.write` calls of ≤ 256 characters, as
  Python literals in printable ASCII — no byte is a control character the REPL acts on) the
  code and Ctrl-D, checking "OK…\x04…\x04>" with stderr empty (else `micropython-install`
  carries MicroPython's message), Ctrl-B, Ctrl-D for a soft reboot — and from the line after
  "MPY: soft reboot" the serial monitor sees the device, so main.py's first print shows. The
  main file is written as main.py, the others by name. While installing, the installer owns the
  line: the device's output goes to it and the bench's input waits; it is ticked every 50 ms of
  simulated time (REPL pokes every 200 ms; 15 s for the REPL to appear, 10 s per later stage).
  Installing takes ≈ 18 ms of simulated time. The interpreter runs unmodified: `machine.Pin`
  (`Pin("LED")` is GP25), `ADC.read_u16`, PWM, I2C, SPI, `time.sleep_ms` (an exact 250 ms
  period), `neopixel` (its bitstream's timing decodes cleanly), tracebacks and the REPL.
  Measured: MicroPython blink (asleep in `sleep_ms` between toggles) ≈ 25–45× real time.

- **RISC-V core** — `@benchtop/riscv`, our own RV32 interpreter in TypeScript for the
  Raspberry Pi Pico 2's Hazard3 cores (the RP2350 SoC around it is below), written so the
  ESP32-C3 can reuse it. DOM-free, no SoC knowledge.

  **ISA and decoding.** `isa.ts` numbers what executes (`OP`: 114 ops; a compressed
  instruction executes as its base op — c.addi as ADDI, c.mv as ADD, c.zext.b as ANDI 0xff)
  separately from what prints (`NAME`, the compressed and Zcb spellings), and a `RiscvProfile`
  says which extensions decode: `RV32IMAC` (base: RV32I, M, A, C, Zicsr, Zifencei) or
  `HAZARD3` (plus Zba, Zbb, Zbs, Zbkb, Zcb, Zcmp, Xh3bextm and user mode). `decode(word,
  profile, out)` fills a caller-owned `Int32Array` descriptor (op, length, rd, rs1, rs2,
  immediate, spelling, aux: CSR number, AMO aq/rl, fence sets, Zcmp rlist, bextm width) with
  no allocation. RV32C's HINT encodings (c.addi rd,0; c.li/c.mv/c.add/c.lui on x0; c.slli
  with shamt 0 → c.slli64) decode and execute as no-ops; its custom points (shamt[5] set),
  F/D's compressed loads and stores and the reserved encodings are invalid. Where the specs
  leave room the decoder follows objdump: FENCE only with fm 0 (or the one FENCE.TSO word)
  and rd = rs1 = 0, FENCE.I and the system instructions as exact words, a word with the
  ≥ 80-bit length prefix stepped as one invalid halfword.

  **Disassembler.** `disassemble(word, pc, profile, aliases)` prints exactly what GNU objdump
  prints in its `-M no-aliases` form and in its default form (li, mv, not, neg, seqz/snez,
  sltz/sgtz, beqz…bgtz, j, jal, jr, ret, jalr rs, csrr/csrw/csrs/csrc and their immediate
  forms, rdcycle & co., nop, unimp, zext.b, fence, fence.tso; compressed and Zcb instructions
  under their base names, except the HINTs on x0, which keep their c. spelling; undecodable
  words as `.insn 2, 0x0004` / `.insn 4, 0x…`), with objdump's CSR names. The oracle is the
  arduino-pico core's RISC-V toolchain (binutils 2.43.1): `disasm.test.ts` compares every row
  of four corpora in `fixtures/riscv/corpus/` (scripts/riscv-corpus.ts, assembled for the
  Hazard3 ISA so objdump decodes the extensions: every 16-bit word; 17,546 chosen 32-bit words
  — random per opcode and funct3, every funct7 of the register-register opcodes, every fence
  set, alias probes —; `csrrs`/`csrrwi` on all 4,096 CSR numbers; and the 14,612 instructions
  of real code: newlib's printf, strtod, qsort and libgcc's soft-float, with our C built using
  Zb* and Zcb) in both forms. Tolerated and counted: what objdump doesn't know (Xh3bextm,
  cm.mvsa01/cm.mva01s — a spec-derived table checks them) and what it decodes that an RV32
  core without supervisor mode must reject (RV64 shift amounts ≥ 32, Zcmp's reserved register
  lists 0–3, c.addi16sp with 0, sfence.vma). A second test proves the HAZARD3 profile changes
  nothing that decodes without it. (Cross-check: the test programs assembled from the specs'
  encoding tables by hand-written macros came out byte-identical to binutils 2.43's own
  assembly of the same instructions.)

  **Core.** `RiscvCore` holds x0–x31 in an `Int32Array`, the PC, the privilege mode and the
  machine CSRs, and reaches memory only through `RiscvBus` (read/write 8/16/32 little-endian,
  `fetch16`; a bus refuses with `RiscvBusError` — the core raises the access fault of the
  access's kind, instruction/load/store-AMO — or postpones with `RISCV_BUS_YIELD`). The run
  loop (`interpret`) works like the Xtensa core's: locals for PC, cycles and the code page; one
  field test per instruction (`attention`: a deliverable interrupt, WFI, a stop request, or
  dropped code pages); one switch with literal case labels (`case-labels.test.ts`) over packed
  two-word entries — from the predecode cache (`icache.ts`: 4 KB pages, two ints per halfword
  slot, filled lazily, only for pages the bus's `codePage` accepts; a bus that accepts writable
  pages calls `invalidateCode` on stores, FENCE.I drops everything) or decoded through
  `fetch16` (`predecode = false`, refused pages). Misaligned loads and stores (and AMOs, LR/SC)
  trap; LR/SC keep a one-address reservation that traps and mret clear. Zcmp's push/pop store
  s11 … s0, ra downward from sp − 4 and adjust sp after, so a fault midway re-executes cleanly.
  Timing is flat: one cycle per instruction, one per trap entry (not an instruction), WFI sleeps
  to the end of the run unless an enabled interrupt is pending. bench-loop.S (a bitwise CRC-32):
  ≈ 36 simulated MIPS predecoded and ≈ 15 without the cache in plain Node (Apple M1).

  **Privileged model.** Machine and user modes (no supervisor). mstatus (MIE, MPIE, MPP with
  only M/U legal, MPRV, TW), misa (from the profile), mie/mip (MSI 3, MTI 7, MEI 11; mip is
  the SoC's lines: `setInterruptLine`), mtvec (direct, or vectored: interrupts at base + 4 ×
  cause), mepc (bit 0 clear), mcause, mtval (fault address, illegal instruction bits, the
  EBREAK's PC; `writeMtval: false` keeps it 0), mscratch, mcounteren (gates cycle/instret in U),
  mcountinhibit, mcycle/minstret as 64-bit counts (a write is what the next instruction reads),
  read-only zero hpm counters, mvendorid/marchid/mimpid/mhartid from options. Traps take
  MEI > MSI > MTI; ecall from U is cause 8, from M 11; mret in U, sret, dret, U-mode WFI with
  TW, privileged or read-only CSR writes and unknown CSRs are illegal instructions. PMP:
  pmpcfg0–3 and pmpaddr0–15 hold their WARL values (R = 0/W = 1 cleared, 30-bit addresses, lock
  bits and the locked-TOR rule honored) but nothing is enforced yet. **The SoC seam:**
  `csrHook` (`readCsr`/`writeCsr`) answers every CSR the core doesn't implement — Hazard3's
  Xh3irq and msleep, the ESP32-C3's performance counter — after the core's own
  privilege and read-only checks; its optional `accessCsr(csr, kind, operand, writes)`
  takes a whole CSR instruction, for CSRs whose value read depends on the same instruction's
  operand (Hazard3's indexed arrays). The SoC drives MEIP/MTIP/MSIP with `setInterruptLine`.
  `ebreakHook` turns EBREAK into a halt (the test machine's exit), `trapHook` reports every
  trap, `mretHook` every MRET. Xh3power (profile flag `xh3power`): `h3.block`
  (`slt x0, x0, x0`) sleeps like WFI unless an unblock is latched, `h3.unblock`
  (`slt x0, x0, x1`) calls `unblockHook`, and the SoC's `unblock()` wakes a blocked hart or
  latches for its next block — the SDK's `__wfe`/`__sev` on RISC-V, so a sketch in `delay()`
  sleeps instead of spinning.
  **High-level emulation (`hle.ts`).** As on the Xtensa core (the ESP32's hle/), a
  function can be answered by TypeScript: `RiscvHle.replace(address, name, handler)` and
  `core.setHle(table)`; an address the table lists decodes as `OP_HLE` (127, past the ISA's ids
  in the entry's 7-bit op field; `pack()` asks the table, so the predecode cache and the
  uncached path agree, and the table costs nothing elsewhere). The calling convention does the
  rest: arguments in a0–a7 (later ones on the caller's stack at sp), the result to a0, then on to
  ra. A handler that calls back into the firmware is a generator yielding `{ fn, args }`: its
  call gets a frame of its own — sp down FRAME_SIZE (144: 16 bytes of stack arguments, 128 of
  scratch memory, 16-aligned), the caller's ra kept with it — and every step runs at `resumePc`
  (an address the firmware never executes): a call out puts its arguments in a0–a7 and on the
  stack, sets ra = resumePc and jumps to `fn`; the frame is found again by sp; at the end a0 gets
  the value, sp goes back up and execution continues at the kept ra. No register windows, so no
  spills and no return trampoline. `fixtures/riscv/programs/hle.S` tests it on the bare machine,
  cached and not: nine arguments, generators calling the firmware, two waiting at once, a
  recursion 50 deep around one, a call out with stack arguments, scratch memory.
  **External interrupt cause.** A SoC whose interrupt controller picks the line itself
  (the ESP32-C3's) presents it with `setInterruptCause(cause)` (0 = none): while it is nonzero
  the core treats an interrupt as pending, and with mstatus.MIE set takes it as cause
  `0x80000000 | cause` — through vectored mtvec at base + 4 × cause, which is how IDF's C3 vector
  table dispatches. mie/mip don't gate it (the controller has its own enables); WFI wakes on it.

  **Tests.** Hand-written programs in `fixtures/riscv/programs/` (scripts/riscv-programs.ts:
  the arduino-pico toolchain's `as` for the Hazard3 ISA, linked at 0x80000000; h3.bextm and
  cm.mvsa01/cm.mva01s through the spec-derived `.insn` macros of `harness.inc`; committed
  `.bin` + `.lst`) run
  on a bare machine (256 KB RAM, a console/exit/interrupt-lines MMIO page): alu.S and
  bitmanip.S over 400 operand pairs against BigInt references written from the specs'
  definitions, memory.S (every width, sign, offset), branches.S, atomics.S (every AMO, LR/SC),
  compressed.S (RVC and Zcb), zcmp.S, traps.S (every exception cause, user mode, counters,
  CSRs, PMP storage, the hook, vectored interrupts and their priority, WFI with and without
  MIE), each with and without the predecode cache where it matters.

  **The ESP32-C3** carries the core over unchanged (its RV32IMAC profile, misa reporting
  RV32IMC) and adds only the external interrupt cause above — see the ESP32-C3 entry below.

- **RP2350, RISC-V side** — `@benchtop/rp2350`: the Raspberry Pi Pico 2's chip on two
  `@benchtop/riscv` harts with the Hazard3 profile, with the **real bootrom**: release A4 of
  pico-bootrom-rp2350 (BSD-3), fetched by `npm run fetch:rp2350-rom` into `.cache/rp2350-rom`
  after a human approves (sizes and SHA-256 pinned in `rom-manifest.ts`, which equal GitHub's
  published digests; never committed). `createRp2350Mcu({ rom })` / `rp2350McuFactory` give the
  bench an `Mcu` of kind `'rp2350'`; without the ROM it reports `rp2350-rom-missing` and halts.

  **Boot.** Both harts start at the bootrom's RISC-V entry (0x7dfc) and the bootrom boots the
  flash image as on the chip — most of its boot path is Arm code its RISC-V half runs through
  varmulet, its Armv6-M emulator in RISC-V assembly, so a boot is ≈ 15 ms of simulated time and
  a few hundred thousand of our instructions. It leaves BOOTRAM as the chip has it after boot
  (the 16-byte native XIP setup stub at its start with the read mode and clock divider its
  flash scan settled on — EBh quad, divider 3 —, which the SDK copies and calls after a flash
  operation), QMI in that mode, and core 1 in its wait for a launch: the SDK's
  `multicore_launch_core1` talks to the bootrom's own code. PSM's FRCE_OFF.proc1 holds core 1
  in reset and restarts it in the bootrom. Before booting, `boot.ts` finds the image the
  bootrom will enter, as its flash scan does (the first PICOBIN block loop in the first 4 KB
  with an EXE IMAGE_TYPE; ENTRY_POINT, else flash start and the top of SRAM): an image this SoC
  can't run halts with the reason instead (no image: "BOOTSEL"; an Arm or RP2040 image; a
  LOAD_MAP). arduino-pico's images start with its OTA loader, which then enters the sketch at
  0x10003000. What the bootrom needed from the models: ROM writes ignored (varmulet's PUSH ends
  with a dummy write-back to address 0), USB's DPRAM as plain RAM (it keeps varmulet's state
  there), OTP ARCHSEL_STATUS reading 3 — the cores are RISC-V, else it reboots to switch
  architectures —, the QSPI lines idle high in SIO's GPIO_HI_IN (CSn low is BOOTSEL pressed),
  BOOTRAM's boot locks, and QMI's direct mode.

  **Memory and bus** (`soc.ts`). ROM 32 KB; XIP flash 4 MB at 0x10000000 (through the cached
  and uncached aliases; CS1, PSRAM, has no device), the XIP cache as SRAM at 0x13ffc000; SRAM
  520 KB; BOOTRAM 1 KB and USB DPRAM 4 KB as RAM; APB/AHB blocks of 4 KB registers with the
  XOR/SET/CLR aliases (narrow writes replicated across the word); SIO per hart; anything else
  a bus error. Registers nobody models read their pico-sdk reset values
  (`periph/reg-defaults.generated.ts`, from the headers by
  `scripts/gen-rp2350-reg-defaults.ts`) and are reported once each (`rp2350-unimplemented`,
  info); blocks that only need to keep what is written (ACCESSCTRL, QMI's M0/M1, TICKS, …)
  stay quiet. SRAM, XIP-cache and flash pages are predecodable; writes into them, and flash
  programming, drop the predecoded code.

  **Time.** Simulated nanoseconds with alarms (`clock.ts`); a hart's instruction is one clk_sys
  cycle, and clk_sys follows the clock tree — the ROSC (≈ 11 MHz) at boot, then XOSC × PLL
  (150 MHz once the SDK set it up); `cycles` count a 150 MHz reference. The run loop runs the
  harts in slices (≤ 20 µs) up to the next alarm, an alarm scheduled earlier than the slice's
  end stopping the hart at its next instruction.

  **Peripherals** (`periph/`). Xh3irq per hart (`xh3irq.ts`, the arrays, meinext, meicontext's
  priority stack and clearts, force bits cleared by a meinext read); SIO (GPIO, the 4-word
  FIFOs, spinlocks, doorbells, RISCV_SOFTIRQ, MTIME at the 1 µs tick or clk_sys with
  MTIMECMP per core); TIMER0/1 (µs counter, alarms on the low word, IRQs 0–7); RESETS; CLOCKS
  with XOSC, ROSC and the PLLs; PSM; IO_BANK0 (function select, overrides, edge/level
  interrupts per core on IRQ 21) and PADS_BANK0 (reset isolated, ISO cleared by the SDK);
  UART0/1 (PL011, paced at the programmed baud, FIFOs, IFLS levels, receive timeout); QMI's
  direct mode on a W25Q32-class flash chip (`flash-chip.ts`: IDs, status, reads with EBh
  continuous mode, page program, erases — finished at once; a 16-bit TX entry shifts its low
  byte first); BOOTRAM's locks and write-once registers; OTP's registers (rows read 0,
  unprogrammed); SYSINFO (A4 silicon, the QFN60 package, an ASIC).

  **More peripherals.** PWM (`pwm.ts`): 12 free-running slices (the gated and
  edge-counting divider modes are reported), each kept as the time its count was 0, with the
  next output edge or wrap scheduled as an alarm — outputs change at their exact times and a
  steady slice costs a few events a period; a wrap sets INTR (IRQs 8 and 9); GPIO n is slice
  (n >> 1) & 7, channel A on even pins. The ADC (`adc.ts`): 12 bits of 3.3 V on GPIO26–29, the
  temperature sensor at 0.706 V, 2 µs a conversion, START_MANY with round robin, the 4-entry
  FIFO and its IRQ (35). SPI0/1 (`spi.ts`): a PL022 in master mode whose frames reach the bench
  at once, the reply waiting in the RX FIFO (transfers take no simulated time). I2C0/1, PIO0–2
  and the USB controller are rp2040js's classes (`rpjs.ts`), whose register maps the RP2350
  shares (checked register by register in the pico-sdk headers): `rpjsHost` is the slice of
  rp2040js's `RP2040` object they touch — the SoC's clock and alarms, interrupts (the RP2040's
  USB IRQ 5 is the RP2350's 14), clk_sys/clk_peri, the DPRAM, pin inputs, warnings as
  `rp2350-unimplemented` —, and `RpjsBlock` puts each on the bus with its atomic aliases, every
  write through `writeUint32Atomic` (it records the raw value USB's write-1-to-clear registers
  clear with). Writes to the DPRAM tell the controller (`DPRAMUpdated`), as rp2040js's own bus
  does. PIO v1's RXF_PUTGET and GPIOBASE sit where the RP2040 has INTR…IRQ1_INTS, which moved up
  by 0x44: the block remaps them; GPIOBASE 16 is reported, and v1's new instruction encodings
  aren't decoded. No DMA yet (DREQs go nowhere). IO_BANK0 asks the SoC (`peripheralDrive`) for a
  PWM, PIO or SPI pin's level and output enable; I2C pins are open drain and released (the bus
  travels at byte level).

  **PIO in time** (`soc.ts`). While a state machine runs, the harts run in 2 µs slices and the
  PIO blocks step in time order between them, as the RP2040's do. arduino-pico starts a
  `ccount` program with every sketch, a `jmp x--` to itself at full speed: a state machine in
  such a counting loop (a JMP X--/Y-- to itself with no delay, side-set or forced instruction)
  is fast-forwarded to the end of the slice and doesn't hold the harts to short slices — a
  2.6 s blink took 21 s of wall time without that, 145 ms with it. Between hart slices the time
  is the clock's own, so a PIO-driven pin changes at the time the PIO set it.

  **Pins and UARTs** (`rp2350-mcu.ts`). `GPIO0`–`GPIO29` (the RP2350A): SIO outputs are
  `output`, a UART TX pin and PWM, PIO and SPI outputs `peripheral` (UART bytes travel at
  byte level, the TX pin idles high), GPIO26–29 with
  input disabled and function NULL `analog`, else inputs with the pad's pulls; inputs through
  a Schmitt trigger (≥ 2.0 V high, ≤ 0.8 V low) that software sees while the pad's input is
  enabled. UART ports 1 and 2 are UART0/UART1 (`pins()` from the function select, aux pins
  included; `baud()` from the divisors and clk_peri); port 0 is USB serial (rp2040js's
  CDC host on the controller, as on the Pico). GPIO26–29's voltages feed ADC channels 0–3 —
  also an analog net's (a pot's wiper), which has volts and no digital level. I2C and SPI
  controllers 0 and 1 implement the bus contracts through the Pico's bridges.

  **The Pico 2 board.** `raspberry-pi-pico-2` in packages/parts is the Pico's definition
  — footprint, pins, power, the LED on GPIO25 through TP5 — with MCU `rp2350`; its view is the
  Pico's with the RP2350's label. The bridge compiles for it with
  `rp2040:rp2040:rpipico2:arch=riscv`, the only Pico 2 FQBN it accepts (no Arm cores here). The
  worker fetches the bootrom from `/rp2350-rom/bootrom-combined.bin` (the dev server serves the
  cache, as for the ESP32 ROM) and the CLI reads it from `.cache/rp2350-rom`; the gallery has a
  Raspberry Pi Pico 2 category (blink, potentiometer, PWM steps, OLED, TFT, NeoPixel, a button
  interrupt), each with a spec.

  **Tests** (packages/rp2350; the ROM from the cache — the tests fail with the fetch command
  without it): Xh3irq's semantics; QMI's direct mode on the flash chip as the bootrom drives it;
  the image scan on fixtures and hand-made blocks; and on `fixtures/sketches/pico2/` (built for
  `rp2040:rp2040:rpipico2:arch=riscv`, arduino-pico 6.2.0): serial-hello's lines on UART0 and
  UART1 at 115200 ±1 % with clk_sys at 150 MHz, blink's 500 ms ±1 %, eeprom's
  `EEPROM.commit()` — erase and program through the bootrom's flash functions, under varmulet —
  surviving a reset, and mips: a busy loop whose sum matches the host's, reported at ≈ 100
  MIPS (≈ 70 % of real time at 150 MHz; a sketch sleeping in `delay()` runs ≈ 20–30× faster than
  real time). `packages/parts/src/integration/pico2-circuits.test.ts` runs the Pico's
  sketches rebuilt for the Pico 2 on full benches: USB serial, the ADC from a potentiometer, PWM
  into an LED, Wire to the SSD1306, SPI to the ILI9341, a pin interrupt, NeoPixels through PIO.
  `packages/rp2350/src/micropython.test.ts` runs MicroPython: print, a traceback and the
  REPL, blink at 250 ms ±1 % across a reset, `_thread` on core 1, the missing-interpreter halt.
  `pico2-micropython.test.ts` puts it on benches: the ADC from a pot, the neopixel module on a
  strip.

  **Debugger.** `Rp2350Mcu.debug()` (`debug.ts`) is hart 0's `McuDebug` — the hart
  `setup()`/`loop()` run on: x0–x31 by ABI name (zero, ra, sp, …, t6), pc, then mstatus, mepc,
  mcause read-only. Memory `data` is hart 0's address space read without side effects
  (`Rp2350Soc.peek`: ROM, flash, SRAM, the XIP cache, BOOTRAM and DPRAM from their arrays; a
  register block's stored value — `Periph.peek`, never its `read`; anything else 0); writes reach
  RAM only (and drop predecoded code there). `flash` is the chip's bytes from offset 0. With a
  breakpoint set, the SoC runs hart 0 one instruction at a time (`runChecked`, entered only
  then): before an instruction at a breakpoint it stops, catches the clock and PIO up to hart 0
  and reports `breakpoint`; the next run executes that instruction unchecked. Asleep in WFI the
  hart sleeps as usual; an interrupt it takes stops right after the entry (the core's
  `stopOnTrap`, read only when an interrupt is taken), so a breakpoint on a handler's first
  instruction is seen. `step` runs one instruction on hart 0 and lets the SoC catch up;
  `instructionAt` decodes the size (2/4) and calls (JAL/JALR, compressed too, linking ra or t0).
  Without a bootrom the view is empty and never stops (`NoSocDebug`). Symbols for UF2 firmware
  come from nm listings (`SymbolTable.fromNm`; the fixtures keep `debug-demo.syms.tsv`), and on
  32-bit cores every symbol lives in the one `data` space.

  **MicroPython.** A `{ format: 'micropython' }` image runs on the stock
  RPI_PICO2-RISCV 1.29.0 UF2 (fetched with the Pico's; `createRp2350Mcu({ rom, micropython })`,
  `rp2350McuFactory(…, { rom, micropython })`), installed exactly as on the Pico: the Pico's
  `MicroPythonInstaller` on the same `UsbSerialBridge`, both from `@benchtop/rp2040`'s public
  API (an ESP32 MicroPython would move the installer to `@benchtop/core`). Every reset rewrites
  the interpreter's image and boots it through the bootrom with an empty filesystem. The
  interpreter needed one more register: IO_QSPI's SS STATUS (OUTTOPAD is the flash's chip
  select, high while QMI is idle), which pico-sdk's flash code polls before it changes QMI's
  timing (`IoQspi` in `gpio.ts`; without it MicroPython hung in that loop). `_thread` runs its
  function on core 1, launched through the bootrom, as on the Pico.
  `machine.ADC`, `Pin`, `time.sleep_ms` and `neopixel` (`machine.bitstream`, timed by the cycle
  counter) work as on the Pico.

  **The Pico 2 W.** `createRp2350Mcu({ cyw43 })` attaches the Pico W's CYW43439 model
  (`@benchtop/rp2040`'s `cyw43/`, behind its chip-neutral `Cyw43Call`/`Cyw43Hle` view — the Thumb `Rp2040Hle` and `@benchtop/riscv`'s `RiscvHle` both satisfy it, as the ESP32's
  `WifiCall` did for the C3). `useSymbols` answers the driver's ll layer on both harts through a
  `RiscvHle` — a fresh one every boot, since its generator frames don't survive a reset — whose
  generators resume at `RP2350_HLE_RESUME_PC` (0x7FF0): bootrom Arm code past the RISC-V bootrom's
  `.text`, `.romtable` and `.entry` (which end at 0x7E00), so no hart ever executes it, and an
  instruction fetch there is legal. The pin `WL_GPIO0` is the chip's GPIO 0, GP24 its host-wake
  (`Rp2350Pin.force`), and bring-up writes GP23/24/25 as the SDK does at the RP2350's IO_BANK0
  (0x40028000), PADS_BANK0 (0x40038000 — isolation cleared, input enabled) and SIO (OUT_SET 0x018,
  OE_SET 0x038, OE_CLR 0x040). Without symbols the firmware raising GP23 reports
  `rp2350-cyw43-no-symbols` once. `raspberry-pi-pico-2w` is the Pico W's footprint around the
  RP2350; the RP2350 factory makes a Pico 2 W of a pin map naming `WL_GPIO0` (no contract change).
  arduino-pico builds it as `rp2040:rp2040:rpipico2w:arch=riscv`; `fixtures/sketches/pico2w/blink`
  blinks the LED through `cyw43_ll_gpio_set` every 500 ms (`packages/rp2350/src/cyw43.test.ts`).
  Its WiFi on the bench is the Pico W's (`packages/parts/src/integration/pico2w.test.ts`):
  `pico2w/wifi-scan` scans, joins and gets 192.168.4.2; `pico2w/wifi-webserver` (the gallery's
  Pico 2 W web server, "pico2w-web") switches the LED for an HTTP client part. Found:
  `pico2w/wifi-http-get` halts in pico-sdk's `__halt_on_unhandled_exception` with mcause 6 (store
  address misaligned) — arduino-pico 6.2.0's RISC-V C library `strcpy` copies a word at a time with
  no alignment check, `String::concat` in HTTPClient's request hands it an odd destination, and
  Hazard3 traps misaligned stores as this core does; the firmware has no handler that emulates
  them. Kept as found (a test pins it); a real Pico 2 W in RISC-V mode will settle it.

- **ESP32-C3** — `@benchtop/esp32c3`: Espressif's RISC-V chip on one `@benchtop/riscv`
  core, running Arduino-ESP32 2.0.17 images (FQBN `esp32:esp32:esp32c3`) booted directly with
  its mask ROM. It shares what isn't Xtensa with `@benchtop/esp32`: the event table, the
  app-image and partition parsers (`parseEspImage(bytes, chip)`, `buildFlash(app, partitions,
  chip)` — the C3 is chip id 5 with its own segment regions), the Problem log, sha256. The
  bench `Mcu` and the ESP32-C3-DevKitM-1 board are described below.

  **ROM.** `esp32c3_rev3_rom.elf` (ECO3 — Arduino-ESP32 2.0.17 links against
  `esp32c3.rom.eco3.ld`, CONFIG_ESP32C3_REV_MIN_3) from the same pinned esp-rom-elfs-20241011
  tarball as the ESP32's ROM: `npm run fetch:esp32-rom` extracts it into `.cache/esp32c3-rom`
  and checks its SHA-256 (`rom-manifest.ts`); with the tarball cached it downloads nothing.
  `parseC3Rom` takes its PROGBITS sections at ROM addresses (0x4000_0000 code, and 0x3FF0_0000,
  the data bus's view of the ROM's top 128 KB, for .rodata) as code, those at DRAM addresses as
  the RAM its reset path would leave (function tables, interface pointers, .data — each at its
  address; no store table to unpack as on the ESP32), and its symbols.

  **Memory map** (`soc/memory.ts`, TRM §3): ROM 0x4000_0000–0x4005_FFFF (the data bus sees its
  last 128 KB at 0x3FF0_0000); 400 KB SRAM as IRAM 0x4037_C000–0x403D_FFFF and DRAM
  0x3FC8_0000–0x3FCD_FFFF (one array: IRAM = DRAM + 0x70_0000, both views of the same bytes);
  8 KB RTC fast memory at 0x5000_0000; flash through the cache at IROM 0x4200_0000 and DROM
  0x3C00_0000, 8 MB windows mapped in 64 KB pages by one 128-entry table at 0x600C_5000 (bits
  7:0 the flash page, bit 8 invalid; the two windows share the table, so an index serves both —
  a read through an invalid entry is a bus error); peripherals 0x6000_0000–0x600D_0FFF. Code
  runs predecoded from ROM, IRAM and mapped flash; a store into an IRAM page the core
  predecoded, an MMU table write and any flash program/erase drop the affected code.

  **Time and the run loop** (`soc/soc.ts`) follow the ESP32's: reference cycles at 160 MHz (the
  crystal is 4 a CPU cycle, SYSTIMER's 16 MHz tick 10); an instruction costs 160 MHz / the CPU
  clock (SYSTEM's SYSCLK_CONF and CPU_PER_CONF: the 40 MHz crystal at reset, 160 MHz after
  esp_clk_init). The loop runs slices of at most 256 reference cycles up to the next event, or
  sleeps through to it in WFI. A load or store to the peripheral space yields first and runs as
  that one instruction with exact time, so peripherals read `now()` as the instruction's own
  time. The CSR hook answers the C3's performance counter (mpccr 0x7E2 counts CPU cycles — IDF's
  cycle count; 0x802 is its user view, which the ROM's `ets_delay_us` reads), and keeps the debug
  trigger (0x7A0–0x7A5) and dedicated-GPIO (0x803–0x805) CSRs as written.

  **Interrupts** (`soc/intmatrix.ts`, TRM §8): 62 sources, each mapped to one of 31 CPU lines
  (INTERRUPT_CORE0 at 0x600C_2000); per line an enable, a type (level, or edge — latched on a
  rising source until CPU_INT_CLEAR) and a priority 1–15; one threshold. The controller
  presents the enabled pending line with the highest priority **at or above** the threshold
  (the lowest number on a tie; priority 0 never interrupts) as the core's external cause. IDF
  runs at threshold 1 with its interrupts at priority 1, and raises the threshold in critical
  sections — so "above" would mask everything, which is how FreeRTOS's first yield (FROM_CPU0,
  source 50, through SYSTEM's CPU_INTR_FROM_CPU_0) got lost before the rule was fixed.

  **Peripherals: the boot set.** Every block answers with its reset values (`reg-defaults.generated.ts`
  from the IDF 4.4 headers, `node scripts/gen-esp32-reg-defaults.ts --chip esp32c3`); an access
  to one not modeled reads back what was written and logs an info Problem
  (`esp32c3-unimplemented-register`). Modeled:
  - SYSTIMER (`systimer.ts`): two 52-bit units at 16 MHz, three comparators (one-shot target or
    period, on unit 0 or 1). The target and period latch on COMPn_LOAD; UNIT_SEL and
    PERIOD_MODE act as written — IDF's `vPortSetupTimer` loads the period and *then* sets
    PERIOD_MODE (`systimer_hal_select_alarm_mode`), and the tick must still run. IDF 4.4 uses
    unit 1 / comparator 0 for the 1 kHz FreeRTOS tick and unit 0 / comparator 2 for esp_timer.
  - TIMG0/1 (`timg.ts`): the 54-bit timer with alarm and autoreload, the MWDT's stages, the
    RTC slow-clock calibration (`rtc_clk_cal`).
  - UART0/1 (`uart.ts`): TX FIFO drained one frame at a time at the baud (sclk from
    CLK_CONF, CLKDIV with its fraction, CONF0's frame), RX queue, the usual interrupts.
  - RTC_CNTL (`rtc-cntl.ts`): the RTC timer's latch, RESET_STATE's cause, software reset; the
    eFuse block (MAC 34:85:18:00:C3:01, wafer version 3) idle with its reads done.
  - SYSTEM and EXTMEM (`system.ts`): clocks; FROM_CPU 0–3 as sources 50–53; cache operations
    (invalidate, preload, lock, autoload, freeze) complete at once.
  - SPI0/SPI1 and the flash (`spi-mem.ts`): a 4 MB GigaDevice-style chip (JEDEC C8 40 16) with
    three status registers — esp_flash sets SR2's QE for QIO and reads it back, and asserts if
    it doesn't stick —, page program (AND), sector/block/chip erase, user commands and the ROM's
    direct ones; SPI0's registers only configure timing.
  - APB_SARADC (`saradc.ts`): the one-shot conversion startup's self-calibration polls for
    (`read_cal_channel`), completing at once with a sample from a hook (the pins' volts, below).

  **Peripherals: pins and buses.**
  - GPIO, the GPIO matrix and IO_MUX (`gpio.ts`, 22 pads): OUT/ENABLE with their W1TS/W1TC
    aliases, IN while FUN_IE is set, PINn's open drain and interrupt types (edges latched in
    STATUS, levels held; PCPU_INT → source 16), FUNC_IN_SEL (5-bit pad, 0x1E constant 1, 0x1F
    constant 0) and FUNC_OUT_SEL (signal 128 = the GPIO_OUT bit, inversion, output-enable source).
    IO_MUX function 1 is the GPIO everywhere; function 0 is too on 0–3, 8–11, 18, 19, U0RXD/U0TXD
    on 20/21 (pads that drive or feed a peripheral directly, as FSPI on function 2). The pad
    resolver (`Pads`) gives each pad a mode and level as the ESP32's does; an ADC pad (GPIO0–5) a
    conversion used, with its input and pulls off, reads `analog`.
  - LEDC (`ledc.ts`): the ESP32's low-speed group alone — six channels on four timers, edges at
    exact times, DUTY_START at a period boundary. Arduino-ESP32 2.0.17 clocks it from the 40 MHz
    crystal on the C3 (`LEDC_USE_XTAL_CLK`), so 5 kHz tops out at 12 bits: a sketch asking for 13
    gets IDF's "can not be achieved" error, as on a board.
  - USB-Serial-JTAG (`usb-serial-jtag.ts`), its CDC side: the 64-byte IN FIFO sent on WR_DONE or
    when full, a host that reads each packet 50 µs (plus 0.75 µs a byte) later — `onTx` hears the
    bytes, SERIAL_IN_EMPTY rises —, host→device bytes in packets of up to 64 (SERIAL_OUT_RECV_PKT),
    and a start-of-frame every millisecond once the firmware touches the block: Arduino's HWCDC
    calls the port unplugged when SOF stops for 5 ms, so its tick hook needs them.
  - I2C (`i2c.ts`): the ESP32's transaction-level command engine with the C3's eight command
    slots and op codes (RESTART 6, WRITE 1, READ 3, STOP 2, END 4), the bus clock from CLK_CONF
    (crystal or RC_FAST, divided), and SCL_SP_CONF's bus-clear bit reading back 0 — IDF resets
    the FSM and clears the bus after every NACK and waits for that bit.
  - SPI2 (`spi.ts`): the ESP32's transaction-level master with the C3's layout (USR bit 24, the
    UPDATE handshake, one MS_DLEN for both directions, W0 at 0x98).
  - RMT (`rmt.ts`): TX channels 0–1 of the C3's second-generation RMT (per-channel TX_CONF0, its
    RAM at +0x400 with 48 items a channel, the clock from SYS_CONF), half items at exact times —
    `neopixelWrite` and the core's `LED_BUILTIN` (a WS2812 on GPIO8) decode with WS2812 timing.
  - The SAR ADC's samples come from `padVolts` (the bench's net volts): ADC1 channels 0–4 are
    GPIO0–4, ADC2 channel 0 GPIO5, an idealized linear 12-bit code over the attenuation's range —
    0.75, 1.05, 1.3 and 2.5 V, the C3 datasheet's.

  **Debugging.** `Esp32c3Debug` is the core's `McuDebug`, as `Rp2350Debug` is hart 0's:
  ABI registers, pc, mstatus/mepc/mcause; `data` reads through `Esp32c3Soc.peek` (memory, the
  flash through the MMU, a block's stored registers — never a FIFO pop), writes reach SRAM and RTC
  fast memory only; `flash` is the chip. While breakpoints are set the run loop executes one
  instruction at a time, stopping before one at a breakpoint (`atBreakpoint`; the next run
  executes it); `step` runs one instruction and fires the events it passed.

  **Arduino's own timing, seen through it:** on a single-core chip Arduino-ESP32's `loopTask`
  calls `yieldIfNecessary()` — a `vTaskDelay(5)` whenever 2 s have passed — so a 500 ms blink
  has one 505 ms interval every two seconds, on a board as here.

  **What the bootloader leaves** (`boot/direct-boot.ts`; the IDF 4.4 bootloader and the ROM's
  reset path): the partition table at 0x8000 and the app at its partition; the MMU entries for
  each IROM/DROM segment's pages and every other entry invalid; RAM segments copied; the ROM's
  RAM sections placed and `s_ticks_per_us` = 40 (the ROM startup's `ets_update_cpu_frequency`);
  RTC_CNTL STORE4 = 0x0028_0028 (a 40 MHz crystal, read by `rtc_clk_xtal_freq_get`); the RTC
  and TIMG watchdogs off (no CONFIG_BOOTLOADER_WDT handover); the power-on reset cause; the core
  in machine mode at the image's entry with sp at the top of the ROM's `.stack_pro`
  (0x3FCD_E710), where the bootloader runs, and the CPU on the crystal.

  **NVS (`nvs.ts`).** `decodeNvs(partition)` reads ESP-IDF's NVS — what Preferences,
  `nvs_set_*` and the WiFi driver keep — clean-room from the format IDF documents, checked on what
  `fixtures/sketches/esp32/prefs-types` writes: 4 KB pages (state, sequence, version 0xFE, a header
  CRC), a 2-bit-per-entry state bitmap, 126 entries of 32 bytes (namespace index, type, span,
  chunk, CRC, 16-byte key, 8 data bytes). Pages in use are read in sequence order, written entries
  only, a later item winning for the same namespace and key; namespaces are namespace 0's u8 items;
  strings and blob chunks carry size and a payload CRC over the next span − 1 entries; a version-2
  blob is its index item's chunks put together (the fixture's 5000 bytes: 3360 on one page, 1640
  on the next). The CRC is IDF's `crc32_le(0xFFFFFFFF, …)` — the reflected CRC-32 from 0, inverted
  at the end (`nvsCrc32("123456789")` = 0xD202D277). Values: numbers to 32 bits as numbers, 64-bit
  as decimal strings, strings as text, blobs as bytes. The flash is untrusted (a host's saved
  copy): a bad header or entry CRC, a span off the page, a missing chunk is a `problems` line and
  skipped — never thrown. `nvsPartitions(flash)` finds the `nvs` partitions in the table at 0x8000.

  **Software resets.** `ESP.restart()` (and a panic's restart) sets RTC_CNTL OPTIONS0's
  SW_SYS_RST: the SoC stops its run
  there (`resetRequested`) and the Mcu builds a fresh chip at the same reference time (the bench's
  clock and `cycles` run on: `Esp32c3SocOptions.time`), keeping what a system reset keeps — the
  flash, RTC fast memory and the RTC timer's power-on origin; the systimer counts from the reset —
  and boots with reset cause SW_SYS (3), reported as `esp32c3-reboot` (info). Five reboots in a
  row less than a second apart end the run ("reboot loop"), as the ESP32's guard does.

  **Measured** (serial-hello, plain Node, Apple M1): the greeting's first byte leaves 19 ms of
  simulated time after the entry (≈ 1.07 M instructions, mostly startup's self-calibration and
  heap init); idle in `delay()` the core sleeps in WFI between ticks, ≈ 575 instructions a
  millisecond, so 10 s of simulated time take ≈ 0.34 s of wall time (≈ 30× real time). `node scripts/esp32c3-trace.ts
  <fixture>` is the boot debugger: UART0, the core's state, where the time went (symbolized),
  the Problems, the last samples' PCs and the stop PC's function disassembled.

  **The bench `Mcu` (`esp32c3-mcu.ts`)** — `'esp32c3'` in `BoardSpec.mcu` and `Mcu.kind`
  (an additive contract change). Built like the ESP32's adapter: `clockHz` the 160 MHz
  reference clock, pins `GPIO0`–`GPIO21` from the pad resolver with 3.3 V thresholds and
  hysteresis (VIH 0.75·VDD, VIL 0.25·VDD), a floating read reported once per pad the firmware
  configured itself (`esp32c3-floating-input`; `IoMux.configured`), `load`/`reset` building a
  fresh SoC and booting directly, the ROM checked against its SHA-256 (`esp32c3-rom-missing`
  says how to get it, and the board won't run without it). `uart(0)` is what the serial monitor
  shows: UART0 and the USB-Serial-JTAG port together (a `CDCOnBoot=cdc` build's `Serial`); typed
  bytes go to the USB port once the firmware has sent on it — Arduino's core touches the port's
  registers in every build, so only its output tells — else to UART0. `uart(1)` is UART1,
  `i2c(0)` the I2C controller (Arduino's defaults SDA 8, SCL 9 before the firmware routes it),
  `spi(2)` SPI2 (SCK 4, MOSI 6, MISO 5); `debug()` is Esp32c3Debug, its breakpoints outliving
  resets. The bench's per-chip tables treat it as the ESP32 (3.3 V logic, 45 kΩ pulls, 40 mA a
  pin, at most 3.6 V on a pin — `esp32-overvoltage` — and no pin groups).

  **The board (`esp32-c3-devkitm-1`)** — our own pin table from Espressif's DevKitM-1 user
  guide: J1 (GND, 3V3, 3V3, IO2, IO3, GND, RST, GND, IO0, IO1, IO10, GND, 5V, 5V, GND) down the
  left edge and J3 (GND, TX, RX, GND, IO9, IO8, GND, IO7, IO6, IO5, IO4, GND, IO18, IO19, GND)
  down the right, 0.9" apart; IO<n> → GPIO<n>, TX/RX → GPIO21/20, the GNDs, 3V3s and 5Vs each one
  bus, 5V driven by USB while `usbPowered` (the default), RST unmodeled. Its RGB LED is a WS2812 on
  GPIO8: the model decodes IO8's edges with the NeoPixel's `Ws2812Decoder` into `pixels[0]`, so
  `pixel c3[0] is #rrggbb` assertions read it, and the view (`views/esp32-c3-devkitm-1.ts`, our
  own drawing: the MINI-1 module and antenna, the headers, the LED with its glow, BOOT and RESET,
  micro-USB) shows its color. GPIO8 is also Wire's default SDA: a line held high there doesn't
  latch a pixel (the decoder now only waits for a latch while DIN is low — before, a NeoPixel whose
  DIN stayed high after some bits polled every nanosecond). The factory runs in the web worker
  (the ROM fetched from `/esp32c3-rom/`, served from `.cache/esp32c3-rom` in development), the
  CLI and the MCP server (`CliIo.esp32c3Rom`); the compile bridge allows `esp32:esp32:esp32c3`;
  the Debugger tab shows `mstatus` and starts its memory view at DRAM (0x3FC80000). Gallery:
  RGB blink, serial hello, a potentiometer dimmer (ADC → LEDC) and an OLED clock (DS1307 +
  SSD1306 on the default I2C pins), each with a spec in fixtures/specs/examples and a check in
  `examples-run-esp32c3.test.ts`; and in the WiFi category an ESP32-C3 RGB web server (its
  `.syms.tsv` in the manifest's symbol glob, a test that every WiFi example ships its symbols).

  **WiFi.** The C3's Arduino sketches call the same IDF 4.4 WiFi API as the ESP32's, so
  the ESP32's `WifiDriver` (@benchtop/esp32's `wifi/`, see the ESP32's WiFi above) answers them
  here too, through `@benchtop/riscv`'s `RiscvHle` instead of the Xtensa `Hle`. The driver sees a
  call through `WifiCall` (arguments, memory, scratch, calls out) and installs into a `WifiHle`
  (`replace`), which both ISAs' HLE tables satisfy; what it keeps per chip is in `WifiHost`: the
  task's entry address (`taskPc`) and `sizeof(wifi_sta_list_t)` (`staListSize`). Every other
  layout in `wifi/types.ts` is the C3's too — `fixtures/sketches/esp32c3/wifi-layout` prints them
  with the C3's toolchain and `packages/esp32c3/src/wifi.test.ts` holds them to the table — but
  the station list: ESP_WIFI_MAX_CONN_NUM is 10 on the C3, so it is 124 bytes (`STA_LIST_C3`).
  The resume and WiFi-task addresses, 0x40059A00 and 0x40059A08, are in the ROM's gap between
  `.text` (ends 0x40059590) and `.rodata` (0x40059C00 on the instruction bus): nothing is
  loaded there (ROM1's view past its `.rodata`, the ESP32's choice, is the C3's
  `.rodata.interface` table). `Esp32c3Mcu.useSymbols` and `joinWifi` are the ESP32's, and the
  factory gives each board its own eFuse MAC — Espressif's 34:85:18 and three bytes hashed from
  its part id (`Esp32c3McuOptions.mac`, `RtcCntl.mac`; the SoC's default stays
  34:85:18:00:C3:01). The radio's blocks (FE2 0x60005000, FE 0x60006000, NRX 0x6001C000, BB
  0x6001D000) count accesses and report `esp32c3-wifi-no-symbols` / `esp32c3-wifi-unsupported` as
  the ESP32's do — but for their power-down controls (BB_BBPD_CTRL, NRXPD_CTRL, FE_GEN_CTRL,
  FE2_TX_INTERP_CTRL), which every boot's `rtc_init` sets (`rtc_sleep_pu`), WiFi or not. Without
  symbols the closed driver's PHY setup touches FE and then polls the analog through RTC_I2C
  forever. lwIP's DNS needed one more model: APB_CTRL's WDEV_RND_REG (+0xB0, `apb-ctrl.ts`), a
  deterministic xorshift32 as the ESP32's RNG — `dns_alloc_random_port` draws from `esp_random`
  until it gets a port ≥ 1024, and a register reading back one value never gives one.
  Measured: `fixtures/sketches/esp32c3/wifi-scan` (scan, connect, DHCP) runs 5 s simulated in
  ≈ 1.5 s wall, `wifi-http-get` GETs and POSTs to an http-server part
  (`packages/parts/src/integration/esp32c3-wifi.test.ts`); `wifi-rgb-server` listens 1.6 s
  into a run and sets its LED within 10 ms of an http-client part's Send (4 s simulated in
  0.8 s); `sim_wifi` lists ESP32-C3 boards with the ESP32's.

- **ESP32-S3** — `@benchtop/esp32s3`: Espressif's dual-core Xtensa LX7 chip, running
  Arduino-ESP32 2.0.17 images (FQBN `esp32:esp32:esp32s3`) booted directly with its mask ROM. It
  is built from the two packages before it: `@benchtop/esp32`'s `XtensaCore` (the LX7's options
  are the ESP32's — windowed registers, the FPU, MAC16, loops, 32 interrupts with the same
  level/type table), its event table, Problem log, image parser (`buildFlash(…, ESP32S3_CHIP)`:
  chip id 9) and interrupt-matrix logic (`InterruptMatrix(99)`); and `@benchtop/esp32c3`'s
  new-generation peripheral models, which share the S3's register maps — SYSTIMER, the timer
  groups, the UARTs (UART2 at 0x6002_E000), SPI0/1 and the flash chip, the SAR ADC. Those models
  now take from their `SocContext` the time base (`refHz`: the C3's 160 MHz, the S3's 240 MHz)
  and the chip's register defaults (`regDefault`), and their interrupt sources as constructor
  arguments (the C3 passes its own; nothing changed for it). Its own: SYSTEM (`system.ts`: the
  clock — CPUPERIOD_SEL 2 is 240 MHz —, CPU_INTR_FROM_CPU, CORE_1_CONTROL_0, the RTC memory CRC
  unit), EXTMEM (cache operations at once; a freeze's DONE follows its ENA), the 512-entry MMU
  table at 0x600C_5000 (read from the ROM's Cache_Ibus_MMU_Set; the IBUS and DBUS windows share
  it, a 9-bit index of 64 KB pages), RTC_CNTL at the S3's offsets (about half moved from the
  C3's) and the eFuse block at 0x6000_7000, the analog I2C master (0x6000_E000: ANA_CONF0 bit
  24, BBPLL_CAL_DONE, reads 1 — rtc_clk_bbpll_configure waits on it), and the interrupt matrix's
  registers (a map register per source and core at INTERRUPT_CORE0 + 4·source, core 1 at
  +0x800; INTR_STATUS_0–3).

  **The cores.** `XtensaCore` with `s3: true` decodes the S3's own rows (`isa-table.ts`, flag
  'S3'): the PIE vector coprocessor's state moves FreeRTOS saves and restores lazily on a
  Coprocessor3Disabled exception — RUR/WUR of user registers 0–18 (ACCX, QACC_H/L, SAR_BYTE,
  FFT_BIT_WIDTH, UA_STATE) and `ld.qr`/`st.qr` of the eight 128-bit q registers, all gated by
  CPENABLE bit 3 — and LX7's SALT/SALTU; it leaves out the ESP32's own TIE (flag 'ESP32': the
  f64 helpers, the expstate ops, `lddr32.p`/`sddr32.p`), whose encodings are the S3's 4-byte
  vector (EE.*) space. The vector compute ops aren't decoded yet (esp-dsp and esp-nn use them). A
  decode corpus from the S3's own objdump (`fixtures/xtensa/corpus/s3-serial-hello`, the IRAM
  of the S3 serial-hello: vectors and FreeRTOS's port) holds the decoder to it. The predecode
  cache spans 64 MB from 0x4000_0000 on the S3 (`icachePages`), so flash code at 0x4200_0000
  runs through it.

  **Memory** (`memory.ts`): 512 KB of SRAM as one buffer — SRAM0 (32 KB, instruction bus
  only), SRAM1 (416 KB, both: 0x4037_8000 / 0x3FC8_8000), SRAM2 (64 KB, data only); the ROM
  (384 KB at 0x4000_0000, its top 128 KB also at 0x3FF0_0000); RTC fast memory (8 KB at
  0x600F_E000, both buses) and RTC slow memory (8 KB at 0x5000_0000). The bus (`bus.ts`) is the
  ESP32's design — a 64 KB page table of kind and base, flash pages armed through the MMU on
  first touch — without the flash cache's timing (not modeled yet).

  **Time and running** (`soc.ts`): 240 MHz reference cycles; the two cores interleave in
  256-cycle slices as the ESP32's do — the core behind in time runs, a peripheral access yields
  to a core behind it, WAITI skip-ahead jumps over whole slices with both asleep — and a model
  scheduling an event inside the running slice ends the slice there (`hurry`). The APP_CPU
  starts held; CORE_1_CONTROL_0 with CLKGATE_EN set and RUNSTALL and RESETING clear starts it at
  the ROM's reset vector, whose second-core path waits for the boot address the app passes. A
  system reset (OPTIONS0.SW_SYS_RST, a timer group's watchdog) stops the run with
  `resetRequested`, for its caller to boot a fresh chip, as the C3's Mcu does.

  **ROM.** `esp32s3_rev0_rom.elf` from the same pinned esp-rom-elfs-20241011 tarball, extracted by
  `npm run fetch:esp32-rom` into `.cache/esp32s3-rom` (SHA-256 pinned in `rom-manifest.ts`; with
  the tarball cached nothing is downloaded). `parseS3Rom` reads it as `parseC3Rom` does the C3's:
  code at ROM addresses, RAM sections at their DRAM addresses, symbols.

  **What the bootloader leaves** (`directBootS3`): the app at its partition and its RAM segments
  copied, the MMU mapped page by page (every other entry invalid), the ROM's RAM data placed, the
  ROM's `s_ticks_per_us` = 40, RTC_CNTL STORE4 = 40 MHz XTAL, the TIMG watchdogs off, and the
  ROM's legacy flash descriptor (`rom_spiflash_legacy_data` → its default struct) with the JEDEC
  id and the image's flash size — the ROM's default says 2 MB, and `esp_flash_read` refuses reads
  past it until the app has probed the chip (the core dump's config at 0x3F_0000 is read before
  that: without the descriptor IDF reports "Failed to read core dump data size"); the PRO_CPU as
  `callx8 entry` leaves it on the ROM's PRO stack (0x3FCE_B710), on the 40 MHz crystal. The
  S3's register reset values come from its headers (`gen-esp32-reg-defaults.ts --chip esp32s3`,
  which reads IDF's newer `/** NAME : R/W; bitpos: […]; default: N;` annotations — for the S3
  only, so the ESP32's and C3's tables stay as their models were tuned against). Two of those
  reset values met the shared models for the first time: TIMG's RTCCALICFG resets with
  START_CYCLING set, and IDF waits a running calibration out through RTCCALICFG2's TIMEOUT
  before its own — the timer group now times out at once when a threshold is written then.
  `scripts/esp32s3-trace.ts` boots a fixture and shows both cores (as `esp32c3-trace.ts`).
  `fixtures/sketches/esp32s3/serial-hello` prints its greeting and ticks a second apart from the
  APP_CPU with both cores in WAITI between; `blink` toggles GPIO2 every 500 ms. One known
  difference: with no flash-cache timing, startup runs faster than on a board, so a log line
  printed during it can still be in the UART FIFO when `Serial.begin` resets the FIFO.

  **Peripherals.** GPIO, the matrix and IO_MUX (`gpio.ts`) are the C3's model over the
  S3's 49 pads (GPIO0–21, 26–48) with per-pad state — every 32-bit register has a second word
  (OUT1, ENABLE1, IN1, STATUS1, PCPU_INT1) —, FUNC_IN_SEL's 6-bit selector, the S3's signal
  numbers and the IO_MUX functions that drive a pad directly (U0TXD/U0RXD on 43/44, U1TXD/U1RXD
  on 17/18, FSPI on 10–13 and 34–37). The module's flash pads (GPIO26–32) are refused: the bench
  can't drive them, and firmware that makes one a GPIO gets `esp32s3-flash-pin`; GPIO33–37 are
  free pads (an octal PSRAM holds them — see the PSRAM paragraph). The flash (`@benchtop/esp32c3`'s
  `FlashChip`, the C3's too) grows to what the image asks for at a direct boot (8 or 16 MB builds),
  and its RDID density follows the module — the N8, N8R2 and N8R8 8 MB, the N16R8 (8 MB octal
  PSRAM) 16 MB (`S3_MODULE_FLASH`) —, or on `auto` the image's; ESP-IDF stops a build bigger than
  the chip at startup, as on a board. The C3's LEDC (8 channels), USB-Serial-JTAG (0x6003_8000),
  I2C (two controllers, 0x6001_3000 and 0x6002_7000), SPI2 and RMT run at the S3's addresses and
  sources; the RMT's register layout (`RmtLayout`: 4 TX and 4 RX channels, the RAM at +0x800)
  and the UART's moved fields (`UartFields`: a 10-bit TX-empty threshold, the RX timeout enable
  at bit 23) are parameters now. The ADC (`sens.ts`): IDF 4.4 converts on the S3 through SENS
  (0x6000_8800, inside RTC_CNTL's page) — SAR_MEAS1/2_CTRL2's EN_PAD, START and DONE, SAR_ATTEN1/2
  — not through the digital controller the C3 uses (APB_SARADC is storage here). ADC1 is
  GPIO1–10, ADC2 GPIO11–20; the code is an idealized linear 12 bits over the S3 datasheet's
  ranges (0.95, 1.25, 1.75, 3.1 V), and startup's self-calibration (`read_cal_channel`) polls the
  same DONE bit. WDEV_RND_REG (0x6003_507C) is the C3's xorshift RNG (`ApbCtrl`, given a base and
  offset). Two fixes to shared code came out of the S3's fixtures: the C3's LEDC restarted a
  channel's waveform on every CONF0 write, so the PARA_UP IDF writes after a duty change dropped
  the pulse in flight — now only a new timer, output enable or idle level restarts it; and the
  S3's run loop fires the events due when a core takes a peripheral turn, so a register read
  sees the model at that core's time. The debugger view (`debug.ts`, `Esp32s3Debug`) is the
  ESP32's on the S3: the APP_CPU unless the PRO_CPU stopped last, side-effect-free reads
  (`S3Bus.peek8`, flash through the MMU), RAM writes (`poke8`), `stepCore`, instruction sizes
  from the S3's decode table. Fixtures `esp32s3/{gpio-interrupt, adc-read, ledc-fade, i2c-scan,
  spi-loopback, rgb-blink, serial-echo, cdc-hello, debug-demo}` run on the SoC
  (`peripherals.test.ts`, `debug.test.ts`).

  **On the bench.** `'esp32s3'` is in `Mcu.kind` and `BoardSpec.mcu`. `Esp32s3Mcu` (`esp32s3-mcu.ts`) is the C3's adapter on the S3 SoC: pins
  `GPIO0`–`GPIO21` and `GPIO33`–`GPIO48` (not the module's flash pads), 3.3 V thresholds with
  hysteresis and floating reads reported, the pins' volts feeding the ADC; `uart(0)` is UART0
  and the USB-Serial-JTAG port together (typed bytes go to USB once the firmware has sent on
  it), `uart(1)`/`uart(2)`, `i2c(0)`/`i2c(1)`, `spi(2)` with their routed pins (the variant's
  defaults before: SDA 8, SCL 9; SCK 12, MOSI 11, MISO 13); the flash kept across resets
  (`nonVolatile`); a system reset the firmware asks for (or a timer group's watchdog) boots a
  fresh chip at the same time keeping RTC memory and the RTC timer, five in a second ending the
  run; the ROM checked against its pinned SHA-256 (`esp32s3-rom-missing` says how to get it).
  The board, `esp32-s3-devkitc-1`, is our own pin table from the DevKitC-1 v1.0 user guide (two
  22-pin headers 0.9" apart; GPIO26–34 aren't on them) and our own SVG; its WS2812 on GPIO48 —
  Arduino-ESP32 2.0.17's `RGB_BUILTIN` (the board's v1.1 moved it to GPIO38) — is decoded into the
  board's `pixels[0]`, as the C3 DevKitM-1's is. The worker fetches the ROM from /esp32s3-rom/ (dev
  server), the CLI and the MCP server read `.cache/esp32s3-rom`; the compile bridge and
  `compile_sketch` build `esp32:esp32:esp32s3`; the Debugger tab shows PS as on the ESP32. Four
  gallery examples (RGB blink, serial, a potentiometer dimmer, an OLED clock) have specs.

  **WiFi.** The S3's cores are the ESP32's, so its WiFi is the ESP32's without a seam: the
  Xtensa `Hle` and `WifiDriver` (@benchtop/esp32, now exported) install on both cores of every SoC
  `Esp32s3Mcu` builds, from the symbols `useSymbols` gives it. Every WiFi struct layout is the
  ESP32's — `fixtures/sketches/esp32s3/wifi-layout` prints them with the S3's toolchain,
  `wifi_sta_list_t` included (15 stations; the C3's 10 was the exception) — so the driver runs on
  its defaults but for the task's entry. The resume, return and WiFi-task addresses (0x40058A00,
  0x40058A04, 0x40058A08) sit in the S3 ROM's gap between `.text` (ends 0x400577A8) and
  `.rodata` (0x40058C00 on the instruction bus), zero and never executed, as the C3's do. The radio's
  blocks are the C3's addresses and power-down controls (`soc/periph.ts`); an access by the closed
  driver reports `esp32s3-wifi-no-symbols` (or `-unsupported` with WiFi answered) once per boot —
  without it, a WiFi sketch run without its symbols would stall with no Problem at all. The
  factory's per-board MAC and the RNG were there already. `fixtures/sketches/esp32s3/{wifi-scan, wifi-http-get, wifi-webserver}`
  (the ESP32's sketches) scan, connect, take a DHCP lease, GET and POST, and serve http-client
  parts on the bench (`packages/parts/src/integration/esp32s3-wifi.test.ts`); `sim_wifi` lists S3
  boards.

  **Sleep.** The ESP32's and C3's model at the S3's RTC_CNTL offsets, IDF's
  sleep code running as built: STATE0.SLEEP_EN stops both cores (`canRun` is false while the
  chip sleeps — IDF stalls the other core first anyway) — deep with DIG_PWC.DG_WRAP_PD_EN, its
  events cleared; light with the timer groups gated. WAKEUP_STATE's ENA picks the wake sources:
  the RTC timer (SLP_TIMER0/1), ext0 (RTC_IO EXT_WAKEUP0's RTC GPIO — on the S3 the GPIO of the same
  number, 0–21 — at EXT_WAKEUP_CONF's level), ext1 (EXT_WAKEUP1's mask, all low or any high,
  latched into EXT_WAKEUP1_STATUS) and, for light sleep, a GPIO with PINn's WAKEUP_ENABLE at its
  level. A wake sets SLP_WAKEUP_CAUSE and INT_RAW's SLP_WAKEUP; a deep sleep's is a system reset
  with cause DEEPSLEEP: `Esp32s3Mcu` boots a fresh chip at the same time keeping RTC fast and slow
  memory, the RTC timer and the RTC domain's registers (`rtcDomain`: the sleep and wake ones,
  STORE0–7, RTC_IO), and the boot skips the RTC segments (the direct boot already took the
  reason); deep-sleep wakes don't count toward the reboot-loop guard. RTC_IO's pads (0x6000_8400,
  in RTC_CNTL's page) matter on the bench: a pad routed to the RTC (MUX_SEL) takes RUE/RDE as its
  pulls (`rtcPad`), so ext0's button reads high until pressed — and an ADC pad, which IDF also
  routes there, stays analog. `sleepState()` is the bench's `Sleeper` (the board's badge,
  `sim_state`). fixtures `esp32s3/{deep-sleep-timer, deep-sleep-pins, light-sleep}` (the ESP32's
  sketches; ext0 on GPIO4, ext1 on GPIO5) run in `packages/parts/src/integration/sleep.test.ts`:
  boots 2 s apart, an hour asleep in milliseconds, `millis()` counting a light sleep once.
  The gallery's S3 web server (the C3's RGB-LED sketch as "s3-web", its symbols through the
  examples manifest's SYMS) and S3 deep-sleep counter (the ESP32's) have specs; `sim_wifi`,
  `sim_http` and `sim_state` cover the S3 as the ESP32.

  **PSRAM.** Arduino-ESP32 2.0.17's S3 menu builds with "QSPI PSRAM" (the qio_qspi SDK:
  Arduino's `psramInit` starts it) or "OPI PSRAM" (qio_opi: ESP-IDF starts it at boot), each
  speaking its own protocol over SPI1 to the chip on the second chip select. `S3Psram`
  (`soc/psram.ts`) answers both: quad — a 24-bit ID (0x9F: MFID 0x0D, KGD 0x5D, EID density bits
  7:5 = 0, 16 Mbit), reset (0x66/0x99), QPI enter/leave (0x35/0xF5), data reads and writes — so
  the chip is 2 MB as on the WROOM-1 N8R2; octal — OPI DTR mode registers through 16-bit commands
  (0x4040 read, 0xC0C0 write: MR1 vendor 0x0D, MR2 Good-Die and density 0x3, 64 Mbit), so 8 MB as
  on the N8R8. The board's `module` prop narrows it: `auto` (the default) answers both — the
  build decides —, `N8` nothing (`present` false), `N8R2` only quad, `N8R8` only octal, so a build
  of the other kind finds no PSRAM, as on that board; a build without PSRAM never asks, and the
  bytes are allocated on first use. The quad protocol is `@benchtop/esp32`'s `QuadPsram`, which
  `S3Psram` extends with the octal commands. SPI1 routes a user command to `SpiMem.cs1` while MISC has CS0_DIS
  set and CS1_DIS clear (`@benchtop/esp32c3`'s spi-mem.ts; the C3 has none). The cache side:
  an MMU entry with SPIRAM (bit 15) set arms its data-bus page (`K_PSRAM` in bus.ts) on the chip's
  bytes, read and written as SRAM is, by both cores (`mmuPsramPage`, within the size the protocol
  says); an unmapped access in 0x3D00_0000–0x3DFF_FFFF still reports `esp32s3-psram`. SPI0's PSRAM
  timing registers are storage; no cache timing (as flash). PSRAM is volatile: a reset or a deep
  sleep's wake builds a fresh chip; a light sleep keeps it. `fixtures/sketches/esp32s3/psram-quad`
  and `psram-octal` find 2 MB and 8 MB, check a 1 MB `ps_malloc` buffer and see a 256 KB `malloc`
  land in PSRAM (`soc/psram.test.ts`). An octal build sets GPIO33–37's IO_MUX to their SPI
  functions (SPIIO4–7, SPIDQS); while the octal PSRAM runs, firmware making one a GPIO again gets
  `pin-reserved` (warning, once per pad: `S3IoMux.octalPsram`), and `Esp32s3Mcu.pinClaims()` holds
  them — an N8R8 from the start, `auto` once an octal build's PSRAM answers. Quad PSRAM's chip
  select is GPIO26, a flash pad no header has. The compile step (`scripts/compile.ts`
  `sketchFqbn`, the bridge's and `compile_sketch`'s) builds an S3 sketch whose main file has a
  `// benchtop: psram` line with `PSRAM=opi` — the FQBN asked for stays an allowlisted one and the
  option is fixed, not taken from the sketch's text; the gallery's PSRAM frame buffer (a 150 KB
  240×320 frame in PSRAM pushed whole to an ILI9341) carries the line. The words such lines
  may carry are a fixed table per FQBN (`SKETCH_OPTIONS`): the ESP32's `psram`
  (PSRAM=enabled), the S3's `psram` (PSRAM=opi) and `usb-otg` (USBMode=default,CDCOnBoot=cdc), on
  one line or a line each; unknown words are ignored. The board's module chooses the PSRAM option
  — the bridge's `/api/compile`, `/api/compile-inline` and `/api/watch` and MCP's `compile_sketch`
  take an optional `module`, refused unless it is `auto` or one its FQBN knows (`moduleError`;
  `MODULE_OPTIONS`: ESP32 `WROVER-E` PSRAM=enabled, `WROOM-32` none; S3 `N8R2` PSRAM=enabled
  (quad), `N8R8` PSRAM=opi, `N8` none; with each module's FlashSize — 8M on the N8s and the
  WROOM-32E-N8, 16M on the N16 modules, the menu's default 4 MB otherwise). An explicit module decides PSRAM — a comment's `psram`
  then adds nothing — and other words (`usb-otg`) still apply; `auto` leaves it to the comment
  lines. The app sends its board's module (`fqbn.ts` `moduleOf`) with every compile and watch; an
  inline sketch's `sourceHash` includes it (not for `auto`, so earlier hashes stand), so a changed
  module shows the build stale, and a sketch folder compiles again (a watched one restarts its
  watch, whose key has the module).

  **USB-OTG (`soc/usb-otg.ts`, `soc/usb-host.ts`).** The board menu's USB Mode "USB-OTG
  (TinyUSB)" (`USBMode=default`) links TinyUSB's dcd_esp32sx — its ESP32-S2/S3 port of the
  Synopsys DWC2 device driver, slave mode — and with USB CDC On Boot, `Serial` is TinyUSB's CDC-ACM
  port. `S3UsbOtg` models USB0 at 0x6008_0000 as that driver uses it: the registers block, then
  sixteen FIFO windows (window n pushes into IN endpoint n's TX FIFO; any read pops the shared RX
  FIFO); seven IN and seven OUT endpoints. GINTSTS's latched bits are W1C and RXFLVL, IEPINT,
  OEPINT, OTGINT and the global-NAK-effective bits derived; the USB source (38) is GAHBCFG's
  global enable && GINTSTS & GINTMSK. IN endpoints keep the core's slave-mode bookkeeping:
  DIEPTSIZ's XFRSIZ counts bytes not yet in the FIFO — words fill a packet of min(max packet,
  XFRSIZ) and a full one is queued — and PKTCNT packets not yet sent; the host's IN token takes a
  queued packet (a zero-length one when XFRSIZ is 0), and PKTCNT 0 clears EPENA and raises XFRC.
  TXFE (read-only, "FIFO empty") reaches DAINT only through DIEPEMPMSK — the driver's refill
  interrupt. OUT: an enabled endpoint without NAK accepts the host's packet as an RX FIFO entry
  (PKTSTS 2, byte count, data), and the transfer's end adds PKTSTS 3 — whose pop raises XFRC —
  clears EPENA and sets NAK; SETUPs always land (PKTSTS 6 + 4, STUP on the second's pop) and clear
  endpoint 0's STALLs. CNAK/SNAK/EPDIS/STALL act as the databook says; GRSTCTL's flushes and soft
  reset are immediate. The PHY: the host sees the device while RTC_CNTL USB_CONF (0x120) has
  SW_HW_USB_PHY_SEL and SW_USB_PHY_SEL set and USB_WRAP's PHY_SEL is 0 with the pads enabled
  (usb_ll_int_phy_enable) and D+ is pulled up — DCTL's soft disconnect clear, or USB_WRAP's pull
  override. USB_WRAP is storage. `UsbHost` is the cable's other end, chip-neutral behind
  `UsbDevicePort` (one transaction per call: setup, in, out, bus reset, SOF), written from USB 2.0
  chapter 9 and the CDC PSTN subclass: debounce 10 frames, a 10-frame reset (USBRST, then ENUMDNE
  at full speed), GET_DESCRIPTOR(device, 64), SET_ADDRESS(1), the device, configuration and
  product string descriptors, SET_CONFIGURATION; then per CDC-ACM function (a communication
  interface of subclass 2 and its data interface, by the union descriptor or the next data
  interface) SET_LINE_CODING 115200 8N1 and SET_CONTROL_LINE_STATE DTR|RTS, and from then on its
  bulk IN read and bulk OUT written as fast as the device ACKs (four packets per endpoint per
  service). HID and MIDI are read too (`usb-hid.ts`, `usb-midi.ts`, both clean-room from HID 1.11
  with the HID Usage Tables and USB-MIDI 1.0). After the CDC ports open, each HID interface's
  report descriptor is read (GET_DESCRIPTOR(report) to the interface, its length from the HID
  descriptor) and parsed — short items, main/global/local, push/pop, report IDs, collections; each
  input report is a keyboard, mouse, consumer control, system control, gamepad or "other" by its
  top-level application collection — then SET_IDLE(0), and the interrupt IN endpoint is polled
  every bInterval frames. Keyboard reports type text with a US layout (newly pressed keys only,
  Shift and the host's Caps Lock; Enter a newline; Backspace deletes; named keys and Ctrl/Alt/GUI
  chords as "[F1]", "[Ctrl+C]"); mouse buttons, moves (merged while moving), wheel and pan, media
  and system keys, gamepad buttons and axes become events. A MIDI streaming interface (audio
  class, subclass 3) has its bulk IN read like CDC's; each 4-byte event packet becomes a message
  line (note on/off, pressures, control change and pitch bend merged while one controller moves,
  program change, SysEx gathered, real-time by name; clocks counted). `UsbLog` keeps the last 4 KB
  typed and 256 events, timed in the MCU's seconds; `Esp32s3Mcu.usbHost()` (null until the
  firmware touches USB0) gives the phase, the product string, the functions used ("serial
  (CDC-ACM)", "keyboard", "mouse", "media keys", "MIDI", …), the text and the events —
  `bench/usb.ts`'s `UsbHosting`, found by duck typing — and `Bench.usbOf(board)` turns the times
  into bench nanoseconds. Other classes (mass storage, audio streaming, DFU, vendor) enumerate and
  are named once (`esp32s3-usb-device`, info), as is a HID report that is none of those kinds.
  The host talks back. Its Num, Caps and Scroll Lock are one state for all its keyboards, as a
  computer's: a keyboard's lock key (0x53, 0x39, 0x47) toggles one and isn't typed, and the bench
  sets them (`UsbHost.setLocks`). The report descriptor parser also reads Output items: the first
  output report with LED usages (page 0x08: Num Lock 1, Caps Lock 2, Scroll Lock 3) is
  `HidLayout.leds` — its ID, size and each lock's bit. On every change each such keyboard gets
  that report (its ID byte first when the device uses IDs) on its interrupt OUT endpoint, again
  next frame while NAKed, or — with no OUT endpoint — as SET_REPORT(Output, ID) on endpoint 0;
  after configuration it gets one when a lock is on, as Linux sends it. MIDI to the device:
  `encodeMidi` (usb-midi.ts) turns whole MIDI 1.0 messages into USB-MIDI packets on cable 0 —
  channel voice (CIN = the status's high nibble), system common by length (2, 3, or 5 for a lone
  byte), real-time bytes (0xF), SysEx in 3-byte packets (CIN 4) ended by 5, 6 or 7 — refusing data
  without a status (no running status), short messages, undefined statuses and an unended SysEx;
  `sendMidi` queues them for the first MIDI streaming interface with a bulk OUT endpoint (a MIDI
  interface needs only one of IN and OUT), sent in packets of up to 64 bytes as the device ACKs
  them. `usbHost()` also says the locks, `keyboardLeds` (a keyboard that takes them) and `midiIn`
  (a MIDI port to send to); `bench/usb.ts`'s `UsbSending` (`usbMidi`, `usbLocks`) is how the bench
  sends — `Bench.usbMidi(board, bytes)` (why not, or null) and `Bench.setUsbLocks(board, locks)`.
  The runner's `midi` and `locks` steps use them. Beside CDC bytes, MIDI and the LEDs, the host
  sends a drive's blocks. A mass storage interface
  (class 8, SCSI, Bulk-Only) is `drive` (`usb-msc.ts` `MscDrive`, clean-room from the Bulk-Only
  Transport 1.0 and the SCSI command layouts): after the HID set-up, GET MAX LUN (LUN 0 read, more
  named), INQUIRY (vendor, product, revision), TEST UNIT READY (every 100 frames until the medium
  is there; a failure gets REQUEST SENSE), READ CAPACITY(10), MODE SENSE(6) (write protect). Each
  command is a 31-byte CBW, its data, a 13-byte CSW; a stalled endpoint gets
  CLEAR_FEATURE(ENDPOINT_HALT) and the same command's CSW. The mount is demand-paged: core's
  `FatVolume` mounts and lists through `DriveBlocks` (a `SparseBlocks` that records the blocks it
  lacked and those written); the drive fetches what was lacking (READ(10), runs of up to 8 blocks)
  and tries again — the volume's system area whole when it is at most 4 MB (needed before the
  bench may write: `FatVolume.systemArea`), then directories, then file data up to 1 MB (a file
  past that is fetched when read; `read` answers undefined until it is in). 512-byte blocks only.
  Every second, as a computer does, the host polls TEST UNIT READY: a medium gone drops the cache
  (`no-medium`), its return mounts it again — a sketch toggling `mediaPresent` makes the host see
  its own writes. Writes from the bench (`PartStorage.write`/`remove`) change the cache at once
  and go out as WRITE(10) commands in block order; a write-protected drive refuses them.
  `Esp32s3Mcu.usbStorage()` (`bench/usb.ts`'s `UsbStorageHosting`) is the drive's `PartStorage`,
  and `Bench.storage(board)` returns it when the board's part model carries none; `usbHost()`'s
  `drive` says its state, vendor, product, revision, size, file system and label.
  Time: 1 ms frames start at the firmware's first USB0 access (a
  sketch without USB-OTG costs no events); a change the host waits on — an endpoint enabled, a
  packet queued, the soft connect — brings its service forward to 50 µs from now. `uart(0)` carries
  the open CDC port with UART0 and USB-Serial-JTAG, and typed bytes go to it while it is open.
  `fixtures/sketches/esp32s3/usb-cdc` (USBMode=default, CDCOnBoot=cdc): enumerated as
  "ESP32S3_DEV" within 50 ms, its greeting, ticks and an echo (`soc/usb-otg.test.ts`, with the
  controller's pieces on their own and the host against a scripted CDC + HID device). The
  gallery's `esp32s3-usb-rgb` takes colors typed over the USB port and sets the RGB LED; its
  `// benchtop: usb-otg` line builds it in that mode. `fixtures/sketches/esp32s3/usb-keys` (a
  keyboard, mouse and media keys with Arduino's USB library, a CDC port beside them) and
  `usb-midi` (TinyUSB's MIDI class added through `tinyusb_enable_interface` — Arduino-ESP32 2.0.17
  has no MIDI class) on buttons and a pot (`soc/usb-otg.test.ts`; on the bench in
  esp32s3-circuits.test.ts). `usb-drive` — Arduino's USBMSC over a 64 KB RAM disk the sketch lays
  out as FAT12 (README.TXT, COUNT.TXT; a CONFIG.TXT the computer writes sets the RGB LED; a button
  rewrites COUNT.TXT and toggles the medium) — mounted, read, written (`soc/usb-msc.test.ts`, with
  a scripted Bulk-Only target; on the bench in esp32s3-circuits.test.ts). `usb-locks` (Arduino's
  keyboard: its LED event printed and shown on the RGB LED; a button types "a", another presses its
  own Caps Lock) and `usb-synth` (TinyUSB's MIDI class: notes from the host played as a square wave
  on IO5 at their pitch, the RGB LED by note; control changes, SysEx and the rest printed) —
  `soc/usb-otg.test.ts`, with the SET_REPORT path against the scripted boot keyboard (no OUT
  endpoint); the runner's steps in `apps/cli/src/usb-steps.test.ts`.

  **Touch** is the S2's (in the S2's section): the version-2 model moved here as
  `soc/touch.ts`'s `TouchV2` over a `TouchChip` — where a chip keeps the fields, which are the same
  on both. The S3's (`S3_TOUCH_CHIP`, esp32s3 rtc_cntl_reg.h/sens_reg.h): RTC_CNTL TOUCH_CTRL1
  0x108, CTRL2 0x10C, SCAN_CTRL 0x110, SLP_THRES 0x114, FILTER_CTRL 0x11C, TIMEOUT_CTRL 0x124; each
  pad's slope in RTC_CNTL's TOUCH_DAC (0x14C, pad n at bits 31−3n…29−3n) and TOUCH_DAC1 (0x150, pads
  10–14), not RTC_IO; SENS SAR_TOUCH_CONF 0x5C, THRES1 0x64, CHN_ST 0x9C, STATUS0 0xA0, STATUS1
  0xA4 … APPR_STATUS 0xE0. IDF enables the S3's touch interrupts through INT_ENA_W1TS/W1TC (0x138,
  0x13C; `RtcChip.intEnaW1ts`), and RTC_CNTL's line drives ETS_RTC_CORE_INTR_SOURCE (39). TOUCH1–14
  are GPIO1–14 (`S3_TOUCH_PINS`): the Mcu is the bench's `TouchSensing`, and a channel in the scan
  map reads as an analog pad. Fixtures `touch-read` and `touch-interrupt` (the S2's sketches):
  `soc/touch.test.ts`, `packages/parts/src/integration/esp32s3-touch.test.ts`. touch wake, as
  the S2's (its section).

- **ESP32-S2** — `@benchtop/esp32s2`: Espressif's single-core Xtensa LX7 chip with
  native USB, running Arduino-ESP32 2.0.17 images (FQBN `esp32:esp32:esp32s2`) booted directly
  with its mask ROM. The S2 sits between the generations, so its models were chosen by measured
  register layout — each S2 header against the ESP32's, the S3's and the C3's, counting the
  registers at the same offset under the same name: LEDC, the GPIO matrix and eFuse are the S3's
  (54/54, 397/397, 116/116); the timer groups (42/45) and I2C (37/44) the original ESP32's; the
  UART half and half; RMT, SPI, SYSTIMER, SYSTEM, EXTMEM and the cache MMU its own. So the S2's
  timer groups are `@benchtop/esp32`'s `Timg` (now exported, its interrupt sources a constructor
  option, and RTCCALICFG2 at 0xA8 — the S2 resets with a periodic calibration running and IDF
  waits it out through the timeout, as the C3's model learned for the S3); its UARTs the C3's
  model with `S2_UART_FIELDS` (MEM_CONF, FSM_STATUS and ID 4–8 bytes earlier, RX_TOUT_EN at bit
  31, the baud clock APB with CONF0.TICK_REF_ALWAYS_ON or else the 1 MHz REF_TICK); SPI0/1 and
  the flash chip, the RNG (WDEV_RND_REG at 0x3F43_5110 — not the S3's +0x7C) and the analog I2C
  master (`S3AnalogI2c`, 0x6000_E000 on PeriBus2) shared too. Its own (`packages/esp32s2/src/soc`): SYSTEM (`system.ts`: SYSCLK_CONF
  0x8C and CPU_PER_CONF 0x18 — 240 MHz on the PLL —, FROM_CPU 0x58–0x64, the RTC memory CRC
  unit at 0x78), EXTMEM (0x6180_0000: PRO_DCACHE_CTRL and PRO_ICACHE_CTRL's ENA/DONE pairs done at
  once, PRO_CACHE_STATE idle — `Cache_Suspend_ICache` waits for it), RTC_CNTL (the RTC timer,
  the reset cause, SW_SYS_RST) and eFuse at the S2's offsets, SYSTIMER (`systimer.ts`: one
  64-bit counter adding PLL_STEP per 80 MHz APB cycle or XTAL_STEP per 40 MHz crystal cycle —
  IDF sets 1 and 2, 80 ticks a µs either way — and three comparators, one-shot or periodic;
  esp_timer runs on it, the FreeRTOS tick on CCOMPARE), the interrupt matrix's block (95 sources,
  one core's map at 0x3F4C_2000 + 4·source, PRO_INTR_STATUS_0–2), and SENSITIVE (memory
  protection — not enforced) and APB_CTRL as storage.

  **The core.** `XtensaCore` with `s2: true` decodes the S2's set (`OpInfo.notS2`): the S2's
  core-isa.h has windowed registers, 32 interrupts, MUL32/DIV32, NSA, MINMAX, CLAMPS, SEXT and
  THREADPTR, LX7's SALT/SALTU — and no zero-overhead loops, MAC16, FPU, booleans or S32C1I, whose
  174 ops (and their special registers) are illegal instructions there; neither chip's TIE is
  decoded (the S2's own, the dedicated GPIO's `*_gpio_out` ops, would fault as unimplemented). A
  decode corpus from the S2's own objdump (`fixtures/xtensa/corpus/s2-serial-hello`) holds the
  decoder to it. One core, so no IPC and no interleaving.

  **Memory** (`memory.ts`, `bus.ts`): 320 KB of SRAM seen at 0x3FFB_0000 (data) and 0x4002_0000
  (instruction), 128 KB of ROM at 0x4000_0000 (its second half also at 0x3FFA_0000), RTC fast
  memory at 0x3FF9_E000 / 0x4007_0000 and slow memory at 0x5000_0000. Flash goes through the
  cache's six MMU windows of 64 entries (`cache_memory.h`, `mmu.h`): the ICache's IBUS0 (IRAM0,
  entries 0–63 from 0x4000_0000; flash code from 0x4008_0000), IBUS1 (IRAM1, 0x4040_0000) and —
  the S2 reads constant data through its instruction cache — IBUS2 (DROM0, entries 128–191 from
  0x3F00_0000); the DCache's DBUS0 (DRAM0, 0x3FC0_0000), DBUS1 (DRAM1, 0x3F80_0000) and DBUS2
  (DPORT, 0x3F40_0000, flash from 0x3F50_0000). An entry is ACCESS_FLASH (15) | the page,
  INVALID (14), or ACCESS_SPIRAM (16 — PSRAM isn't modeled: `esp32s2-psram`). The peripherals sit
  on both PeriBus1 (0x3F40_0000) and PeriBus2 (0x6000_0000), one set of blocks
  (`S2PeripheralMap`, named by their PeriBus1 address); EXTMEM and the MMU table are their own
  8 KB at 0x6180_0000.

  **Time and running** (`soc.ts`): 240 MHz reference cycles; the one core runs in 256-cycle
  slices up to the next event, a model scheduling one inside a slice ends it (`hurry`), events
  due fire before a peripheral access, and WAITI skip-ahead jumps over whole slices. A system
  reset stops the run with `resetRequested`. The SoC implements both models' contexts: the C3's
  (`matrix`, `refHz`, `regDefault`, `hurry`) and the ESP32's (`interrupts`, `resets`, `pc`).

  **ROM.** `esp32s2_rev0_rom.elf` from the same pinned esp-rom-elfs-20241011 tarball, extracted by
  `npm run fetch:esp32-rom` into `.cache/esp32s2-rom` (SHA-256 pinned in `rom-manifest.ts`; with
  the tarball cached nothing is downloaded); `parseS2Rom` as the S3's.

  **What the bootloader leaves** (`directBootS2`): the app at its partition (chip id 2) and its
  RAM segments copied, the MMU mapped page by page in each segment's window, the ROM's RAM data
  placed, `g_ticks_per_us` = 40, the legacy flash descriptor (`SPI_flashchip_data`) with the
  JEDEC id and the image's size, RTC_CNTL STORE4 = 40 MHz XTAL (0x3F40_80BC), the TIMG watchdogs
  off, the core as `callx8 entry` leaves it on the ROM's stack (`__stack`, 0x3FFF_E710), on the
  crystal. The S2's register reset values come from its headers (`gen-esp32-reg-defaults.ts
  --chip esp32s2`, PeriBus1; its headers mix both comment styles, so the newer style is read too).
  `scripts/esp32s2-trace.ts` boots a fixture and shows where the time went.
  `fixtures/sketches/esp32s2/serial-hello` prints "hello from esp32s2" and ticks a second apart
  (to within a 1 ms tick) at 240 MHz with the core in WAITI between — 2.5 s in ≈ 0.7 s wall —
  and `blink` toggles its pin. Two boot stalls found it: the cache state register
  (PRO_CACHE_STATE) and the periodic RTC calibration; and DROM's MMU window (IBUS2, not DBUS0).

  **Peripherals**, again chosen by layout, so the shared models grew a chip parameter
  rather than copies: GPIO, the matrix and IO_MUX are `@benchtop/esp32s3`'s `S3Gpio`/`S3IoMux`/
  `S3Pads` over a `GpioChip` (`S2_GPIO_CHIP`, `soc/gpio.ts`: 47 pads — GPIO0–21 and 26–46, the
  module's flash on 26–32 refused —, the S2's gpio_sig_map.h numbers (no UART2), its GPIO and NMI
  sources, the blocks at 0x3F40_4000 / 0x3F40_9000; the IO_MUX functions are the S3's: U0 on 43/44,
  U1 on 17/18, FSPI on 10–13 and 34–37). LEDC is the C3's `Ledc` (8 channels, 0x3F41_9000). RMT is
  the ESP32's model over an `RmtLayout32` (`S2_RMT_LAYOUT`: 4 channels, CONF0 at 0x10, STATUS 0x30,
  INT_RAW 0x50, TX_LIM 0x70, APB_CONF 0x80, RMTMEM at 0x400, the threshold interrupt from bit 12)
  — the DevKitM-1's WS2812 on GPIO18 through it; I2C the ESP32's (`Esp32I2c`, a `{ base, source,
  defaults, last }` per controller: 0x3F41_3000 and 0x3F42_7000, with the S2's four storage
  registers after COMD15 — timeouts, bus clear, clock stretch — up to 0xA4); SPI2 the ESP32's `Esp32Spi` over a
  `SpiLayout` (`S2_SPI2_LAYOUT`: USR bit 24, CLOCK 0x14, USER 0x18, separate MOSI/MISO lengths at
  0x24/0x28, W0–W17 from 0x98, a 5-bit ADDR_BITLEN, DMA's link enables (0x50/0x54 bit 31) reported
  as unsupported like slave mode); the ADC the S3's `S3Sens` over a `SensChip` (SENS at
  0x3F40_8800, in RTC_CNTL's page — `S2RtcCntl.sens` — the same registers, 13-bit codes): ADC1
  channels 0–9 on GPIO1–10, ADC2's on 11–20, an idealized linear code over the S2 datasheet's
  ranges (`S2_ADC_FULL_SCALE`: 0.75, 1.05, 1.3, 2.5 V), so Arduino's analogRead gives 0–8191 by
  default (core 2.0.17 maps an ADC2 read to the resolution twice — `__analogReadRaw`, then
  `__analogRead` — so below 13 bits ADC2 drops twice the bits ADC1 does, as on real boards);
  APB_SARADC (the digital controller, where IDF only sets the arbiter) is storage. The DAC (esp32s2
  dac_ll.h): RTC_IO's PAD_DAC1/PAD_DAC2 (GPIO17/18's own RTC pad registers, RTC_IO + 0xC8/0xCC) drive
  the pad with DAC (bits 10:3) / 255 · 3.3 V while XPD_DAC (11) powers it and the pad is routed to
  the RTC (MUX_SEL 19) — what IDF 4.4's dac_output_enable + dac_output_voltage (Arduino's `dacWrite`)
  leave. The S3's `S3RtcCntl` computes it for a chip whose `RtcChip.dac` is set (`dacVolts`; the
  S3's RTC_IO has the same registers and no DAC), the shared `S3Pads` carries it (`padDac`,
  `dacVolts` — analog mode), and the S2's pin reports it as `outputVolts`, as the ESP32's DAC does;
  the cosine generator and DAC DMA aren't modeled. USB-OTG is the S3's DWC2 model and the bench's host (`S3UsbOtg` at 0x3F48_0000, which
  PeriBus2 reaches as 0x6008_0000; its USB_WRAP at 0x3F43_9000): the S2 has no other USB, so the
  OTG side always owns the PHY. `CDCOnBoot=cdc` builds put `Serial` on TinyUSB's CDC-ACM port, which
  the host enumerates ("ESP32S2_DEV") and opens. `Esp32s2Debug` (`debug.ts`) is the S3's view on
  one core: pc, a0–a15, sar, ps, windowbase, windowstart (no loop registers on the S2), memory
  through `S2Bus.peek8`/`poke8`, the adapter's breakpoint set on the core, `stepCore`.
  Fixtures (`fixtures/sketches/esp32s2/`): `gpio-interrupt`, `ledc-fade`, `adc-read`, `i2c-scan`,
  `spi-loopback`, `rgb-blink`, `usb-cdc`, `debug-demo` — `soc/peripherals.test.ts` and
  `debug.test.ts`.

  **On the bench.** `'esp32s2'` is in `Mcu.kind` and `BoardSpec.mcu`. `esp32s2-mcu.ts` is the `Mcu` — the S3's
  adapter on one core: pins GPIO0–21, 26 and 33–46 (GPIO27–32 are the flash; the GPIO model's
  `GpioChip.firstFlashPad` is 27 on the S2, whose S2FH4 has no PSRAM, so SPICS1 — GPIO26 — is a
  GPIO the DevKitM-1 breaks out), 3.3 V thresholds and the floating-input warning, the pin's volts
  to the ADC, `uart(0)` = UART0 and the OTG CDC port together (typed bytes to the open CDC port,
  else UART0), `uart(1)`, `i2c(0/1)`, `spi(2)` with the variant's default pins (SDA 8, SCL 9; SCK
  36, MOSI 35, MISO 37), the kept flash (`nonVolatile`), resets and the reboot-loop guard, the
  debugger (`Esp32s2Debug`), and the bench's USB host as the S3's (`usbHost`, `usbStorage`,
  `usbMidi`, `usbLocks` — HID, MIDI and mass-storage builds work as there). `esp32s2McuFactory`
  gives each board a MAC from its part id
  (7C:DF:A1 and a hash) and folds Problems per code. The board, `esp32-s2-devkitm-1`
  (packages/parts, our own pin table from the user guide: J1 3V3, 0–17, 5V, G; J3 G, RST, 46, 45,
  RX, TX, 42–33, 26, 21–18; 21 pins each, 0.9" apart), decodes its WS2812 on GPIO18 into
  `pixels[0]` as the C3's and S3's boards do, and puts USB's 5 V on its 5V pin; its drawing is
  apps/web's views/esp32-s2-devkitm-1.ts. The bench's tables have its 3.3 V logic, 45 kΩ pulls,
  40 mA a pin, 3.6 V maximum input (`esp32-overvoltage`). The worker fetches the ROM from
  /esp32s2-rom/ (scripts/downloads.ts: the dev server and the bridge serve it), the CLI and the MCP
  server read `.cache/esp32s2-rom` (`cachedRoms`); the compile bridge allows
  `esp32:esp32:esp32s2`, where a `// benchtop: usb-otg` line adds `CDCOnBoot=cdc`; the Inspector's
  USB and Storage sections, test specs' USB steps and assertions, `sim_usb`/`sim_files` and the
  Wokwi importer (`board-esp32-s2-devkitm-1`) take S2 boards as they take S3 ones. Gallery
  (category ESP32-S2): the RGB LED, serial hello, a potentiometer dimmer, an OLED clock — specs in
  fixtures/specs/examples, `examples-run-esp32s2.test.ts`; the MCP debug tools run on the S2's
  debug-demo (`build-debug.test.ts`).

  **WiFi** is the S3's: `useSymbols` hands the adapter the firmware's symbols, and
  `@benchtop/esp32`'s `WifiDriver` answers the WiFi driver's API by name through its Xtensa `Hle`
  on the S2's core, rebuilt on every SoC a reset builds; `joinWifi` gives it the bench's radio.
  The HLE's resume and return ops and the driver task's entry are 0x4001_C400/04/08, in the S2
  ROM's gap between .text (ends 0x4001_BED4) and .rodata (0x4001_C600) — zeros, outside every
  section, in RETW's 1 GB region (`wifi.test.ts` checks). The S2's toolchain lays out every WiFi
  struct as the ESP32's (`esp32s2/wifi-layout`), `wifi_sta_list_t` too, so the driver runs on its
  defaults. Without symbols the closed driver reaches the radio's registers
  (`S2PeripheralMap.onRadio`): `esp32s2-wifi-no-symbols`, once a boot. Found on the way: the S2's
  RNG is WDEV_RND_REG at 0x6003_5110, not the S3's +0x7C — reading 0 there, lwIP's DNS looped
  forever choosing a source port ≥ 1024. Fixtures `wifi-scan`, `wifi-http-get`, `wifi-webserver`
  (the ESP32's), `wifi-rgb-server` (the C3's as "s2-web", the LED on GPIO18) and `wifi-softap`
  (the ESP32's) run on the bench in `packages/parts/src/integration/esp32s2-wifi.test.ts`.

  **Sleep** is the S3's: the S2's RTC_CNTL is now `@benchtop/esp32s3`'s
  `S3RtcCntl` with an `RtcChip` (`S2_RTC_CHIP`: base 0x3F40_8000, the S2's reset values and slow
  clocks — RC_SLOW 90 kHz, XTAL32K, RC_FAST/256 31.25 kHz — and the five offsets that differ:
  DIG_PWC 0x8C, EXT_WAKEUP1 0xDC, its STATUS 0xE0, SLP_WAKEUP_CAUSE 0x12C, STORE4–7 0xBC–0xC8; RTC_IO
  is the S3's exactly). STATE0.SLEEP_EN stops the core until the timer, ext0, ext1 or (light) a
  GPIO level wakes it (`soc.ts`: `sleeping`, `enterSleep`, `checkPinWake`, `wake`; the run loop
  leaves the core still and skip-ahead jumps the time asleep without its CCOMPARE timer); deep
  sleep clears the events and wakes as a DEEPSLEEP reset — the adapter keeps the RTC domain and RTC
  memory, the direct boot leaves RTC segments alone, the reboot guard ignores it —; light sleep
  gates the timer groups. `sleepState()` is the bench's `Sleeper`. Two timer-group fixes the S2
  needed (the ESP32's `Timg`): its calibration measures the chip's own slow clocks (`slowClocks`,
  so IDF's calibrated period matches the RTC timer — sleeps were 150/90 too long), and the cycling
  calibration light sleep uses (`rtc_clk_cal_internal_cycling`: START_CYCLING, then
  CYCLING_DATA_VLD in RTCCALICFG1 bit 0 — before, the interrupt watchdog fired while IDF waited).
  Fixtures `deep-sleep-timer`, `deep-sleep-pins` (ext0 GPIO4, ext1 GPIO5), `light-sleep`,
  `deep-sleep-counter` — the S3's — on `fixtures/projects/esp32s2-sleep.json` and
  `esp32s2-deep-sleep-pins.json` (`packages/parts/src/integration/sleep.test.ts`, QUIET).

  **End to end:** the gallery's S2 RGB web server (`esp32s2-wifi-rgb-server`, category
  WiFi: the C3's sketch as "s2-web") and S2 deep-sleep counter (`esp32s2-deep-sleep`: the timer every
  5 s and the button on GPIO4 by ext0), each with a spec in fixtures/specs/examples and a check in
  `examples-run-esp32s2.test.ts`; the app gives the web server its symbols through the examples
  manifest's SYMS glob, and the hosts pass symbols, the radio and sleep to the S2 as to any Mcu
  that takes them (`usesSymbols`, `usesWifi`, the bench's `Sleeper` seam). MCP's `sim_wifi` takes
  S2 boards (`WIFI_MCUS`), `sim_state` shows one asleep (`sessions.test.ts`).

  **PSRAM** is the ESP32's and S3's: soc.ts puts `@benchtop/esp32`'s `QuadPsram` on SPI1's
  CS1 (`SpiMem.cs1`: a user command with MISC's CS0_DIS set and CS1_DIS clear, as IDF 4.4's esp32s2
  spiram_psram.c sends them), with a 16 Mbit ID (MFID 0x0D, KGD 0x5D, EID 0): 2 MB, an
  ESP32-S2FN4R2's or a WROVER's. MMU entries with ACCESS_SPIRAM (bit 16) map its 64 KB pages; the
  bus (`bus.ts`) arms them on the data side (below 0x4000_0000) as `K_PSRAM` pages, read and
  written like SRAM — IDF maps the chip at the top of DBUS0, 0x3FD8_0000–0x3FF7_FFFF (entries
  216–247). An ACCESS_SPIRAM entry nothing answers (no chip, a page past it) is unmapped with
  `esp32s2-psram`; fetching from PSRAM isn't modeled. The bytes are allocated on first use, and
  every reset or deep-sleep wake builds a fresh chip (the adapter boots a new SoC), so PSRAM is lost
  there, as on the board. The board's `module` prop (`S2_MODULES`: `auto`, `N4` — no PSRAM, the
  S2FH4 —, `N4R2`) reaches the factory through `BenchEnv.createMcu`'s props; GPIO26 (SPICS1, on the
  DevKitM-1's header) is the PSRAM's chip select: `pinClaims()` holds it for an N4R2 always and on
  `auto` once a build has read the chip's ID, and the IO_MUX model reports the firmware taking it
  from a running PSRAM (`GpioChip.psramCsPad`, `S3IoMux.psramCs`; `pin-reserved`). The compile
  step: `// benchtop: psram` → `PSRAM=enabled`; `N4R2` → `PSRAM=enabled`, `N4` → none
  (`SKETCH_OPTIONS`, `MODULE_OPTIONS`). Fixture `esp32s2/psram` (`soc/psram.test.ts`,
  `module-pins.test.ts`).

  **Touch** — `soc/touch.ts` (`S2Touch`; the model is @benchtop/esp32s3's `TouchV2`, shared with
  the S3, and this file the S2's layout, `S2_TOUCH_CHIP`), written from IDF 4.4's register interface
  (touch_sensor_ll.h and the RTC_CNTL, SENS and RTC_IO headers): TOUCH1–14 on GPIO1–14 and the
  internal denoise channel 0. Its controls are RTC_CNTL's TOUCH_CTRL1/CTRL2/SCAN_CTRL/FILTER_CTRL/
  TIMEOUT_CTRL (the shared `S3RtcCntl` tells it about writes: `onWrite`) and RTC_IO's TOUCH_PADn
  slope; its data are SENS's SAR_TOUCH_CONF … STATUS14 (0x5C–0x118 in SENS: the S2's SENS block
  hands those offsets to it, the rest to the ADC). The FSM scans the channels in SCAN_PAD_MAP — in
  timer mode SLEEP_CYCLES slow-clock cycles after each scan while SLP_TIMER_EN is set, or once per
  START_EN edge in software mode —, the denoise channel first with DENOISE_EN. A measurement takes
  XPD_WAIT + MEAS_NUM charge-discharge cycles of the RTC fast clock (8 MHz), each 2·C·ΔV / I: C is
  `PAD_PF` (10 pF, the chip's pad and trace) plus what the bench's touch source gives (a touch pad,
  a finger), ΔV the reference voltages' swing (DREFH less DRANGE, minus DREFL) and I the slope ×
  `SLOPE_UA` (1 µA) — so the reading is the measurement's length in ticks and a touch raises it, as
  on the chip; slope 0 reads 0. Denoise subtracts channel 0's reading of REFC (5 + 1.4·code pF),
  clipped to DENOISE_RES's bits. The benchmark is a channel's first reading after a clear
  (CHANNEL_CLR, RESET); with FILTER_EN the smoothed value follows by SMOOTH_LVL's IIR and the
  benchmark follows it while inactive (FILTER_MODE's IIR or JITTER_STEP), DEBOUNCE delaying a
  change. A channel with OUTEN goes active while smooth − benchmark exceeds its threshold. Each
  reading raises DONE (SAR_TOUCH_STATUS0's SCAN_CURR names the channel just read), a change ACTIVE
  or INACTIVE, a scan's end SCAN_DONE, a reading over TIMEOUT_NUM TIMEOUT (dropped); RTC_CNTL's
  INT_ST is now INT_RAW & INT_ENA, and its line drives ETS_RTC_CORE_INTR_SOURCE (49), where IDF's
  rtc_isr dispatches to the touch handler. A touch channel in the scan map reads as an analog pad
  (`S3Pads.analogPad`), so the bench doesn't call it a floating input. With Arduino's settings
  (500 cycles, 2.7 V / 0.5 V less 0.5 V, slope 7, 4-bit denoise at 10.6 pF) a bare pin reads
  ≈ 19,400, a touch pad's electrode ≈ 23,300 and a finger on it ≈ 42,700 — model constants, chosen
  to land in the tens of thousands an S2 reads, not measurements. The Mcu is the bench's
  `TouchSensing` (`touchPins()`: GPIO1–14). Not modeled: noise, the waterproof shield, proximity
  mode. Fixtures `touch-read` (touchRead on T1 and T5) and
  `touch-interrupt` (touchAttachInterrupt on T5, threshold 1500): `soc/touch.test.ts`,
  `packages/parts/src/integration/esp32s2-touch.test.ts`.

  **Touch wake** on the S2 and S3: with WAKEUP_STATE's TOUCH (bit 8, `S2_WAKE.TOUCH`,
  `S3_WAKE.TOUCH`), deep sleep re-arms the touch FSM after clearing the SoC's events (`resume`) —
  IDF's touch_wakeup_prepare has left it measuring the sleep pad alone — and the sleep pad (RTC_CNTL
  TOUCH_SLP_THRES: pad 31:27, threshold 21:0) read over its benchmark by more than that threshold
  (`onSleepPad`) wakes the chip with cause TOUCH. TOUCH_SLP_THRES joined the RTC domain the
  DEEPSLEEP reset keeps (`RtcChip.touchSlpThres`), since `esp_sleep_get_touchpad_wakeup_status`
  reads its pad there; `sleepState` lists "touch T3 (GPIO3)". Fixture `touch-wake` (T3, threshold
  5000): `packages/parts/src/integration/touch-wake.test.ts`.

  **Touch and PSRAM in the gallery:** the gallery's S2 touch lamp (`esp32s2-touch-lamp`: a touch pad on T5
  switches the RGB LED warm white and off, touchRead printed) and S2 PSRAM frame buffer
  (`esp32s2-psram-frame`: the ESP32's sketch on FSPI — SCK 36, MOSI 35, CS 34, D/C 33, RST 38 — on
  an N4R2 board), each with a spec and a check in `examples-run-esp32s2.test.ts`; MCP's
  `describe_part` lists the touch pad's inputs and `sim_input` touches it (`sessions.test.ts`). In
  the app the touch pad is our own drawing (`views/touch-pad.ts`): while running, holding the
  pointer on it is a finger (press, release), the Inspector's Contact slider a partial touch (the
  part's `contact` prop while stopped); the registry's `isInteractive` covers it beside the element
  library's parts. The frame buffer found a bus gap: the S2's core does unaligned loads and stores
  in hardware (core-isa.h's XCHAL_UNALIGNED_LOAD_HW/STORE_HW, as the ESP32's and S3's), and Arduino's
  `spiWriteNL` reads its bytes as words from wherever they lie; the S2 bus's slow path now reads and
  writes any armed page byte by byte (SRAM, ROM, flash, PSRAM), where it had only RTC memory and the
  windows.

## Worker protocol

`apps/web/src/sim/protocol.ts` defines `ToSim` (UI → worker) and `FromSim` (worker → UI)
messages, versioned by `PROTOCOL_VERSION` (21: a recording's `memory`; `usbSend`/`usbSent`; recorded file steps and cards; `usb`; `memory` and the saved memory beside `load`/`edit`; the debug ELF beside a load's images and the MCU
kind and register names in `debugInfo`, then `edit`/`edited`, then `busWatch` and a frame's `bus`
chunk, then `storage`, then `debugSyms`: a board's symbol table as `nm` text beside `load`, `edit`
and `setFirmware` when it has no ELF — a gallery example's `.syms.tsv`, which the ESP32's WiFi
needs; the session parses it with `SymbolTable.fromNm`, symbols only). UI → worker: `busWatch` (on/off: the Bus tab is open — while on, every frame carries the
bus transactions decoded since the previous one, see "Bus tab"), `storage`
(`id`, a part, and `list`, `read`, `write` (bytes transferred) or `remove` of its files —
`bench.storage()`, a microSD card's; answered by a `storage` message with the same id: `ok`, the
storage's `version`, the files or the bytes, or an `error`; `sim.storage()` returns a promise),
`memory` (`id`, a board and `read` or `erase` of its EEPROM or flash data —
`Bench.nonVolatileOf`; answered by a `memory` message with the same id: `ok`, kind, size, sector
size, the data sectors that aren't erased (transferred, to save) and what they hold, to show — an
EEPROM's written bytes as [address, value], each NVS partition's entries (values as text, a blob's
first 32 bytes in hex, 64-bit numbers as decimal) and problems — or an `error`; `sim.memory()`),
`usb` (`id` and a board — `Bench.usbOf`; answered by a `usb` message with the same id: `ok` and
the board's USB host view — phase, device, functions, typed text, events timed in bench ns — or
null when its firmware never started USB, or an `error`; `sim.usb()`),
`hello`, `load` (a
project plus firmware images per board; `memory`, saved sectors per board, put back before the
boards run, and `keepMemory` — the same project as the bench it replaces: a board there keeps
what it holds now, over the saved copy), `edit` (the loaded bench's new document; the worker
rebuilds it with carry-over, keeps the serial history, breakpoints and symbols of the boards that
carried over, re-probes the probes without restarting their history — the UI appends — and
posts a new `frameRing` only when the part list changed; the images reach only boards that
start afresh; answered by `edited` with the problems, or with `reloaded: true` when carrying
over failed and it loaded afresh), `setFirmware` (one board's new image on the loaded bench: that
MCU loads and resets, its clock restarts at the current bench time, everything else carries
on), `run` (speed; Infinity = max), `pause`, `reset`, `step` (ns),
`input` (part, PartInput), `audioIn` (a microphone part's 16 kHz samples, each fed to
it as a `value` input), `serialSend`, `addProbe` (key, pin), `removeProbe` (key), and the
debugger's `debugPause`, `debugStep`, `debugStepOver` (board), `debugSetBreakpoints` (board, the
specs as typed), `debugReadMemory` (board, space, address, length ≤ 4 KB), and
`recordStart` (reset, then log every `input` and `serialSend` with its simulated time) and
`recordStop`.
Worker → UI: `ready`, `loaded` (problems), `frameRing` (a SharedArrayBuffer and the part
ids of its slots, once per load when the worker is cross-origin isolated — see below), `frame`
(simulated time, the visual states that changed and didn't go through the frame ring, stats
{ratio, MHz per board}, running, and each probe's new edges as a `ProbeChunk`),
`debugInfo` (a board's packed symbols and line table, once per firmware), `debugStopped`
(board, reason breakpoint/step/pause, PC, registers), `debugMemory`,
`serial` (bytes per board, with the simulated time they were flushed), `problems` (the full
list, when it changes), `recorded` (a finished test recording), `error`. Uint8Array and probe-chunk
payloads travel in the transfer list.

`SimSession` (`apps/web/src/sim/session.ts`) is the worker's logic, DOM-free and with `post`,
`now` and `schedule` injected, so it is tested in Node on a manual clock. A tick runs the bench
toward the `RealtimePacer` target in 1 ms slices within an 8 ms wall budget (at most 250 ms of
simulated time per tick), posts serial bytes once per board per tick, and posts a frame when
≥ 16 ms of wall time passed (always on pause, step and reset). It reports a board's UART
traffic to the board part as input `serial-tx`/`serial-rx`, which the Uno's model shows on its
TX/RX LEDs. Errors become `error` messages and pause the run. `worker.ts` adapts it to the
worker scope, scheduling ticks through a MessageChannel (nested setTimeout clamps to 4 ms);
`env.ts` is the BenchEnv (catalog + the AVR, ESP32, RP2040 and RP2350 factories, given the
downloaded files as `BenchRoms`) and records each MCU to measure MHz. The worker fetches the
ESP32 ROM once at startup from `/esp32-rom/esp32_rev0_rom.elf`
— served in development by a Vite plugin straight from `.cache/esp32-rom`, never copied
into the build — and holds incoming messages until that fetch settles, so a project restored at
startup sees the ROM; without it ESP32 boards report `esp32-rom-missing` and don't run. The
RP2350 bootrom comes the same way from `/rp2350-rom/` (`rp2350-rom-missing`).
`host.ts` is the UI client: commands, signals (`simStatus`, `simLoaded`, `simRunning`,
`simTime`, `simStats`, `simProblems`, `simError`) and listeners — `onVisuals` (part states, for
the views and the buzzers' audio), `onFrame` (time, stats, probes), `onSerial` — that reach the
views without going through Preact state.

Frame ring (`sim/frame-ring.ts`). The dev server, `vite preview` and the bridge's static
serving send COOP `same-origin` + COEP `require-corp`, so the page and its worker are
cross-origin isolated and may share memory. The worker then posts `frameRing` right after a
load (before anything is written to it): one fixed-size slot per part of the document (4 KB,
room for an SSD1306 framebuffer's ≈ 2.8 KB of JSON) in a SharedArrayBuffer, and each frame
writes the changed parts' states there instead of into the message. A slot is a sequence lock:
the writer makes its `seq` word odd, copies the JSON in, stores the length, makes `seq` even;
the reader (the UI, once per `requestAnimationFrame`) skips a slot whose `seq` it has already
seen, copies the bytes out between two loads of `seq` and keeps them only when both loads match
and are even — a torn read is retried (a few times, then left for the next animation frame).
`seq` wraps at 2³² keeping its parity. A state that doesn't fit, or holds a NaN/±Infinity JSON
would turn into null, goes in the `frame` message instead and marks its slot empty, so an older
ring state never overwrites the newer one. A UI that falls behind skips straight to the newest
state, with nothing queued. Without isolation (or in Node tests that pass `sharedMemory: false`)
every state stays in `frame` messages; `onVisuals` listeners can't tell the difference. Tested:
round trips, wraparound, an interleaved write during the copy, a two-thread stress test
(worker_threads writing flat out while the test reads: every state read is self-consistent,
and the test fails with the sequence check removed), and the session on both paths giving the
same LED states at the same times.

Perf budget (`sim/perf.test.ts`): `fixtures/projects/perf-100-leds.json` — blink with 100
LEDs, each behind its own 220 Ω resistor, on six breadboards, all on D13 — runs through the
whole session (frame ring included) at speed Max for 2 s of simulated time and must keep
≥ 100 % real time on the CPU time it used (≈ 190 %; ≈ 215 % of wall time on an idle Apple M1 —
CPU time also counts the GC threads). It runs in a spawned plain `node` (`perf.test-helper.ts`):
Vitest's module transform turns each imported call into a property lookup, which halves the CPU
core's speed, while the bundled worker — like plain Node — calls directly. It is in the `QUIET`
test group (`vitest.config.ts`) with the other wall-clock comparisons (debugger and probe MHz,
SoC bus speed, ESP32 skip-ahead): those files run after every other file, one at a time — run
alongside the rest of the suite they flaked. That bench is one resistive network of 101 nets
(D13 is a 25 Ω source, so the 100 branches load it): solved, D13 sags to ≈ 2.07 V and each red
LED carries ≈ 1.2 mA (dim, as on a real pin asked for 120 mA); ≈ 190 % of wall time.

## Project document

A project is one JSON document, `ProjectDoc` in `packages/core/src/contracts/project.ts`:
`format: 1`, a name, parts (`id`, `type`, `x`/`y` in mm of the unrotated top-left corner,
`rotation` 0/90/180/270 clockwise about the center, `props`), wires (two `PinRef` endpoints,
waypoints in mm, a CSS color) and per-board `FirmwareRef`s (a dropped file, whose bytes the app
keeps outside the document, a sketch folder plus FQBN for the compile bridge, or — an
additive contract change — an inline sketch: `{ kind: 'inline', fqbn, files,
main }`, the source itself, at most 32 files and 256 KB of UTF-8, names
`[A-Za-z0-9_][A-Za-z0-9_.-]*.(ino|h|hpp|c|cpp)`, `main` a .ino among them; parseProject
enforces it. An fqbn starting `micropython:` — `micropython:rp2:pico` — makes it a
MicroPython sketch: `.py` names, `main` a .py, nothing compiles it). The editor snaps to the 0.1" (2.54 mm) grid, but the document stores mm.

Documents from outside are untrusted. `parseProject` (`packages/core/src/project/validate.ts`)
checks structure only — it knows no part types or pin names, since core never imports the
catalog — collects up to 100 errors with JSON Pointer paths (`/parts/3/rotation`), enforces
size limits (2,000 parts, 10,000 wires, 256 waypoints per wire, 64 props per part, 256-character
strings), and returns a freshly built document holding only known keys. Unknown part types and
pins become bench Problems instead. `emptyProject(name)` makes a new one.

Undo/redo snapshots the document and autosave goes to browser storage; Open/Export read
and write the document as a file, and Open also imports Wokwi's `diagram.json`.

## Rendering and editing

`apps/web/src/editor/Canvas.tsx` renders the bench: one world container under a single CSS
transform (translate + scale, no `will-change`, so SVG re-rasterizes crisply after a zoom);
each part is a wrapper div at mm × 3.7795 px with its rotation, holding the part's view. The
camera (`editor/camera.ts`: zoom 1 = 96 dpi, default 2, clamped 0.25–8) lives in a ref; panning
and zooming only rewrite the transform and the dot grid's CSS variables (every fifth dot below
8 px). Dragging parts sets their `translate` style; the document changes once, on drop. Preact
re-renders the part list only when the document or selection changes. Snapping puts a part's
first pin on the 0.1" grid (`editor/geometry.ts`), so legs line up with breadboard holes; Alt
skips it.

Views (`apps/web/src/views/`): `registry.ts` maps a part type to a `ViewFactory` (create, set
props, apply visual state). `wokwi.ts` is one adapter over `@wokwi/elements`, importing each
element by deep path on first use (lazy chunks; lit is shared); `breadboard.ts` draws our own
breadboards from the definition's holes; `fallback.ts` boxes anything else. Elements have
`pointer-events: none` while editing; the wrapper takes the clicks.

State (`editor/store.ts`): the document and selection as signals, every edit a command
(addPart, moveParts, rotateParts, deleteSelection, setProp, replaceDoc) building a new document;
undo/redo keep up to 200 structuredClone snapshots. Ids are `<prefix><n>` (`uno1`, `r2`, `led3`).
`editor/persistence.ts` autosaves to localStorage (`benchtop:project:v1`) 500 ms after the last
edit and on page hide, and restores it through `parseProject` at startup (a corrupt save is
ignored with a warning); Open/Export use the same validation.

Wires (`editor/Wires.tsx`, `routing.ts`, `wiring.ts`, `pins.ts`) are an SVG layer in mm under
the same transform: an orthogonal route through the endpoints and waypoints (each step bends
the way that adds fewer corners given how the wire arrived; ties go horizontal-first), drawn
with 1 mm rounded corners, an outline and a solder dot per end, and an invisible wide stroke
for clicks. Wire tool: click (or drag from) a pin, click empty space for bends (snapped), click
a pin to finish; Esc cancels, Backspace drops the last bend. Pins are grabbable within 5 screen
px (0.45–1 mm), so a breadboard can still be dragged between its holes. A selected wire shows
square handles for its bends and ten colors in the inspector; a new wire is black if its net
has a ground pin, red for a supply pin, green otherwise. Hovering a pin shows a ring and a
tooltip (part, pin, role); hovering a pin or wire highlights its whole net, from a netlist the
editor builds on the UI thread with the bench's own rule (cheap, DOM-free). Legs in contact
show green dots; while a part is dragged, green rings mark where its legs would land in holes.
### Running

`apps/web/src/sim/controller.ts` loads the document plus each board's stored firmware into the
worker when either changed, then runs at the chosen speed (0.1×, 1×, 10×, Max). An edit that
changes the circuit while a bench is loaded — running or paused — goes to the worker as `edit`
(debounced 150 ms): it rebuilds the bench with carry-over, so time goes on, the boards keep
running their firmware and unchanged parts keep their state (a display keeps what the sketch
drew); a run keeps running, a pause stays paused, a board stopped at a breakpoint stays there.
New firmware bytes under the same document (a re-dropped file) still load afresh, and a Run or
Reset first sends an edit still waiting in the debounce. Which edits count is `benchSignature`
(core `bench/signature.ts`): the parts' ids, types and props, the nets as which pins share one
(contacts included, part order and net numbering ignored), the firmware refs (an inline sketch
by its FQBN) and — only with an environment part — the positions of the parts the environment
uses. Recoloring a wire, moving its waypoints or moving a part whose pins touch nothing new
leaves the bench alone; the editor's netlist and the signature are computed once per document
object (≈ 4 ms for the largest fixture, perf-100-leds, netlist included). Firmware bytes
live in IndexedDB by board id (`editor/firmware-store.ts`, session-only fallback, files over
4 MB refused); the document keeps only the `FirmwareRef`. So do the boards' EEPROM and flash data
(`editor/memory-store.ts`: its own database, `benchtop-memory`, by board id; what comes back is
checked), saved by the controller when a run pauses, every 5 s while it runs and when the page is
hidden (`saveMemory`: each board's `memory` read), sent with every `load` and `edit`, and cleared
when another project opens (`editor.replaceDoc` — a file, New, an example, a shared link), with an
epoch so a read still in flight then can't write the old project's data back. A board that an edit
starts afresh gets the old bench's data, not the store's (fresher). So a counter in EEPROM or
Preferences is where the board left it after a reload of the page. A `.hex`/`.elf` dropped onto a board,
or chosen with the inspector's "Load firmware…", attaches it. Part states (from frames or the
frame ring) go through `sim/frame-dispatch.ts`: each updates only the views it names (a view
drawn later gets its part's latest state), straight onto the elements — never through Preact. While running, interactive
elements (pushbutton, potentiometer, slide switch) take the pointer and their own events
become part input. The serial monitor (`ui/SerialMonitor.tsx`) keeps the newest ~1 MB per
board (`ui/serial-buffer.ts`: lines split across chunks, UTF-8 streamed, simulated-time stamps)
and appends DOM nodes rather than re-rendering; autoscroll pauses while you read further up.
A full load of the bench (a new project or example, a rebuild from t = 0) empties every board's
output, as the plotter's (the boards of every example share ids like `uno`, so an opened example
showed the previous one's lines); Reset and hot-swap edits keep it.
Examples: **Examples…** opens a gallery (`ui/ExamplesGallery.tsx`, a
modal dialog) of the entries in `fixtures/examples.json` (`examples/manifest.ts` reads and
checks it — the MCP server reads it too) — 80 circuits in thirteen categories (Basics,
Displays, Sensors, Motors, Environment, Sound, Power, Storage, ESP32, Raspberry Pi Pico, Raspberry
Pi Pico 2, Mega, Two boards; Environment has four: a gas alarm whose fan clears the room, a PIR hallway light, a
parking sensor with a car driving in, a thermostat; the Pico has nine: blink, a potentiometer,
PWM steps, an OLED, a color TFT, NeoPixels through PIO, a PIO square wave, and MicroPython blink
and NeoPixel, whose firmware is the sketch itself; the Pico 2 has eight: the Pico's first five,
NeoPixels through PIO, a button interrupt and MicroPython blink). Each names a committed fixture project and,
per board, the firmware its tests run and the sketch folder it was built from; the files load
through `import.meta.glob` patterns that list exactly the examples' files (projects, sketches and
.hex as text, ESP32 .bin and Pico and Pico 2 .uf2 as `?url` assets fetched on open), so nothing loads until asked and
nothing else is bundled. Opening one puts each board's sketch in the document as its inline
sketch and stores the precompiled firmware tagged with that sketch's source hash — so it
runs without the bridge, and the Code tab knows the build is current; **Reset example** (Code
tab) opens it again, undoably. Every example is held to its files and its behavior by tests:
`examples.test.ts` (the project parses; loaders return the committed bytes; the sketch is its
fixture folder byte for byte; the fixtures manifest's `source` for its firmware equals the
folder's hash now — `sketchSourceSha256`, written by the fixture build) and
`examples-run-uno.test.ts` / `examples-run-esp32.test.ts` (each runs 2 s of simulated time in
Node on the worker's environment and asserts what its card says: LED patterns, LCD text, pixels,
angles, serial lines, button and keypad presses, a microphone tone). A card is a live preview: the part views
themselves, scaled to fit the card and inert, with wires as plain orthogonal paths; nothing
runs. Opening one replaces the bench (undoable), stores the firmware for the project's first
board, points the document's firmware reference at it, and frames the parts. Opening a
project, an example or an import frames the canvas on everything (`editor/frame.ts`; parts
placed at negative coordinates used to start off-screen). The worker posts a full frame right
after a load, so no view keeps a previous bench's state.

Wokwi import (`packages/parts/src/import/wokwi.ts`): **Open…** recognizes a Wokwi
`diagram.json` (a `parts` array and no `format`) and imports it rather than refusing it: part
types map to catalog types (some by attrs: an LCD's `pins: "i2c"`, a 7-segment's `digits`, a
NeoPixel matrix's rows × cols), `left`/`top` px → mm, `rotate` snapped to 90°, known attrs →
props; connections become wires whose waypoints are the route's explicit moves (before `*` from
the source pin, after it from the target in reverse — our router fills the gap orthogonally,
as Wokwi does). Wokwi records parts plugged into a breadboard as `["$bb"]` connections; our
breadboard has its own geometry and touching pins connect, so such a part moves by the mean of
its pins' offsets to their holes, provided every pin then lies within `CONTACT_MM` of its hole
(otherwise wires, and a note). Everything not imported — unknown types, attrs, pins, bad
routes, hidden wires — is a note under "Import" in the Problems tab; the file is untrusted input
(a malformed one is one error, never a throw) and the result goes through `parseProject`.
The firmware isn't in a diagram.json: you drop it on the board as usual. Wokwi's
`board-esp32-c3-devkitm-1` and `board-esp32-s3-devkitc-1` map to our DevKitM-1 and DevKitC-1,
whose pin tables are our own: a mapping's `pin` renames a GPIO given by number (`4`, `GPIO4`) to
our `IO4`, and a numbered ground or supply our board doesn't have (`GND.7`) goes to its bus's first
(one net). Wokwi publishes no pin table for those boards, so the rename is a rule, not a copied
list: a pin it still can't place is a note as any other. Connections to Wokwi's `$serialMonitor`
are dropped silently — our serial monitor needs no wires.

A board can instead name a sketch folder (inspector: "Sketch folder", the FQBN from the board's
MCU, Compile, Watch, a status badge; the last five folders are remembered in localStorage).
`editor/sketch-actions.ts` compiles it through the compile bridge (below) once, or keeps a
watch open; a good build is stored like a dropped file (IndexedDB, as `<name>.ino.hex`) and
handed to the worker with `setFirmware` when the worker holds the current document — a hot
swap of that board only — or by the usual reload otherwise; the serial tab gets a
"— reloaded —" line. A failed build leaves the old firmware running and puts its diagnostics
in the Problems tab (`sim/compile-problems.ts`: severity, `file:line:col` relative to the
sketch folder; clicking copies the full `file:line`). When a sketch feature can't reach the
bridge, a dismissible banner says to start it with `npm run bridge`; dropping files keeps
working.

### Shortcuts, image export and offline

Shortcuts: one table, `editor/shortcuts.ts` — keys for Mac and other platforms, a label, a
group, and for keys the canvas handles an id and a matcher. The canvas's keydown handler is a
`switch (matchShortcut(event))` over the ids, and the `?` sheet (`ui/ShortcutsSheet.tsx`, also
the toolbar's `?` button) lists the table, gestures included, so the two can't disagree (a test
checks the canvas has a case per id and the README's table matches). F frames the circuit
(`frameDoc`).

Image export (`editor/export-image.ts`, toolbar **Export ▾**): an SVG built from what the
canvas shows — each part's own SVG (a wokwi element's shadow-DOM SVG, our breadboard's SVG)
cloned at the part's position, natural size and rotation, the shadow roots' stylesheets
inlined; a canvas the element draws on (the SSD1306's pixels, laid over its SVG) becomes an
`<image>` of its current pixels at its offset; wires drawn from the document with the wire
layer's widths and colors; the bench background behind. PNG: that SVG drawn on a canvas at 2×
(data URLs only, so the canvas isn't tainted). No dependency. Not carried over: CSS box shadows
of our own views and HTML in foreignObjects other than canvases.

Offline (`public/sw.js`, hand-written; production builds only, `offline/register.ts`): install
precaches the app shell — the build lists it in `/sw-precache.js`, which a Vite plugin
(`appShell` in `vite.config.ts`, using `offline/shell.ts`) writes from the final bundle: the
page, entry chunks with their static imports and CSS, the simulation worker, icon and web app
manifest — into a cache named by a hash of that list; activate drops older builds' caches.
Navigations go to the network first and fall back to the cached page; files under `/assets/`
(content-hashed) come from the cache or are fetched and cached on first use, so part views,
examples and firmware used once work offline; `/api/` (the compile bridge) is never cached.
Cached responses keep their COOP/COEP headers, so an offline page is still isolated. Tested in
Node by running `sw.js` in a VM context with fake caches and network.

### Serial plotter and share links

**Plotter** tab (`ui/plotter/`): every board's serial output is parsed as it arrives
(`plot-store.ts`, fed by `onAnySerial` whether or not the tab is open) by the Arduino IDE 2
plotter's rules (`parse.ts`: values separated by spaces, tabs or commas, `label:value` or
positional "value n", non-numbers ignored — 1,000 lines in well under 2 ms) into per-label rings
(4,096 points, the last 10 s of simulated time; a serial batch's lines are spread between the
previous batch's time and its own). `SerialPlotter.tsx` draws them on a devicePixelRatio-aware
canvas on animation frames when points arrive: auto-scaled values, seconds along the bottom, a
legend, Pause; a new run starts the plot over.

**Share links** (`editor/share.ts`, `share-actions.ts`; Export ▾ → Copy share link): the bench as
`#project=` + base64url of its JSON deflated with CompressionStream('deflate-raw'), or
`#example=<id>` for an example opened and not changed since. Firmware that can't travel (dropped
files, local sketch folders) is left out; inline sketches go along. Links over 8 KB are refused
with a message (export the file instead). Opening — at startup after the firmware store loads,
and on hashchange — is untrusted input: the hash length is checked, inflation is capped (4 MB),
the JSON goes through parseProject; a broken link opens nothing and says why in the Problems tab;
a non-empty bench asks first; the shared boards' stored firmware is dropped (their sketches
compile with Compile & Run); the hash is cleared afterwards.

### Code tab and inline sketches

The bottom panel's **Code** tab (`ui/code/CodePanel.tsx`; the panel grows to ~46 % of the window
while it's open) edits the selected board's inline sketch (else the first board's). A board
without firmware shows a template — blink on the Uno, a serial hello on the ESP32
(`editor/inline-compile.ts`) — that becomes its sketch at the first edit; a board running a
dropped file or a sketch folder offers "Write a sketch here" (the old bytes keep running until
the first Compile & Run). Files are tabs (+ adds a .h/.hpp/.cpp/.c/.ino, × deletes one; the main
.ino stays).

The editor (`ui/code/CodeEditor.tsx`) is a transparent textarea over a `<pre>` holding
`highlight(text)` — our own one-pass tokenizer (`ui/code/tokenize.ts`: keywords, types,
Arduino names, strings and chars, comments across lines, numbers, preprocessor lines with
continuations; a 2,000-line sketch in a few ms) — both in one scroll container beside a sticky
line-number gutter, so they can't drift. Keys (`ui/code/edit-ops.ts`, pure and tested): Tab /
Shift-Tab indent and unindent the selected lines, Enter keeps the indentation (+1 level after
`{`, a following `}` to its own line), ⌘/Ctrl-F find, ⌘/Ctrl-S save, ⌘/Ctrl-Enter Compile & Run;
edits go through `insertText`, so the browser's undo history holds them.

Typing goes to a draft that reaches the document 400 ms after the last key (and on save, file
switch, leaving the tab or the page) through `editor.editSketch`, which coalesces consecutive
code edits of a board into one undo step. A code edit is not a bench edit: the controller's
`sameBench` ignores inline sources, so a running bench is neither reloaded nor marked stale by
typing. **Compile & Run** (`editor/sketch-actions.ts` → `inline-compile.ts`'s `compileInline`,
tested in Node with a fake bridge and a real SimSession) posts the files to
`/api/compile-inline`; a good build is stored like any compiled firmware, tagged with the
source's hash (`sourceHash` — the status says "Not compiled since the last edit" when they
differ), handed to the bench (a hot swap of that board when the worker holds this bench, else
a reload) and the bench runs; a failed one leaves the old firmware running, its errors in the
Problems tab and on the editor's lines (gutter dot, tinted line, the first error under the
editor — a click selects its line). Without the bridge the editor still edits and saves;
Compile says to start it with `npm run bridge`. The document's autosave keeps the code across
reloads, and Export / Open carry it. The CLI refuses an inline board without `--firmware`.

**MicroPython.** On boards MicroPython runs on (`editor/fqbn.ts` `micropythonFqbnOf`:
the RP2040 → `micropython:rp2:pico`, the RP2350 → `micropython:rp2:pico2`), the Inspector's **Language** switch (Arduino C++ /
MicroPython) replaces the board's sketch with the other language's template (undoable; a
started sketch asks first). A MicroPython sketch's files are .py modules (+ adds one), colored
by `tokenizePython` (keywords, builtins and MicroPython's hardware names, `#` comments, strings
with prefixes and triple quotes, numbers, decorators) and indented four spaces (Enter adds a
level after a `:`). **Run** (⌘/Ctrl-Enter) skips the bridge: `compileInline` stores the sketch
itself as the board's firmware (format `micropython`, the UTF-8 JSON `{ files, main }`, tagged
with its source hash) and delivers it like a build. A dropped `.py` becomes the board's main.py.
The worker gets the interpreter UF2s (the Pico's and the Pico 2's) from the dev server's
`/micropython/` (like the ESP32 ROM; never bundled). The CLI runs an inline MicroPython sketch with no `--firmware`, and takes
`--firmware pico=<file>.py` as a one-file sketch.

### microSD card in the Inspector

Selecting a `microsd-card` part shows its own section (`apps/web/src/ui/card/`, lazy-loaded;
the generic prop fields skip `files` and `inserted`): **Card in the socket** (the `inserted`
prop while nothing is loaded, a `value` input to the running card otherwise); **On the card
now**, while a bench is loaded — the files from `sim.storage(part, { op: 'list' })`, listed again
(at most every 300 ms) when the card's visual `writes` count moves; a name opens a preview (UTF-8
text up to 4 KB, else a hex dump), ⤓ downloads, ✕ deletes; **Upload…** writes files onto the
card, **Download all** zips them (`@benchtop/pcb`'s `zip`), **Keep as power-up files** copies
them into the `files` prop (256 KB at most — the edit restarts the card with them); **At
power-up** — the `files` prop's files with ✕, a new text file (name and contents) and
**Upload…** (`card-files.ts`: `withFiles`, `withoutFile`, `previewOf`, Node-tested).

### A board's storage in the Inspector

Selecting a board shows a **Storage** section under its firmware (`ui/storage/BoardStorage.tsx`,
lazy-loaded): while a bench is loaded, what `sim.memory(board, 'read')` returns — EEPROM or flash
data in use, then an EEPROM's written bytes (address: value) or the ESP32s' NVS entries
(`namespace.key` and the value; the type and a blob's size as a tooltip), at most 40 rows —
refreshed every 2 s while running and by **Refresh**; **Erase** erases it in the worker (the
firmware sees it at its next reset) and drops the saved copy. With nothing loaded it says what is
saved for the board and erases that.

An ESP32-S3 board also shows a **USB** section (`ui/usb/BoardUsb.tsx`, lazy-loaded): the
computer's side of the board's own USB port as `sim.usb(board)` returns it — nothing on the port
(a sketch built for USB-OTG appears there), enumerating, failed, or the device's product string
and what the host uses ("serial (CDC-ACM)", "keyboard", "mouse", "media keys", "MIDI"), the text a
keyboard typed (the last 2,000 characters, wrapped) and the newest 30 events with their bench
times; refreshed every 500 ms while running and by **Refresh**. A USB drive the host mounted
shows under it — vendor, product and revision, its size, file system and label (or why it isn't
mounted: probing, no medium, being read, unreadable) — and, while mounted, its files through
`sim.storage(board)` (the board's storage, `Bench.storage`): open one (a preview), download,
delete, upload, or write a text file (a name and its text) onto the drive. The microSD card's
`download` and `readPicked` helpers are shared (`ui/card/CardControls.tsx`).
The host talks back from here. For a device with a keyboard that takes lock LEDs
(`keyboardLeds`) the section shows the computer's Num, Caps and Scroll Lock as toggle buttons,
lit when on; a click sends `usbSend { locks }` (`Bench.setUsbLocks`). For a device that takes MIDI
(`midiIn`) it shows a one-octave keyboard (C to B, octave − and +, channel 1–16, velocity 1–127):
pressing a key (pointer or Space/Enter) sends a note on, letting go (or losing focus, or the
section closing) its note off, as `usbSend { midi }` (`Bench.usbMidi`); the worker answers
`usbSent` with why not when it can't (no device yet, no MIDI port). Both are recorded by Record
test as `midi` (hex bytes) and `locks` steps with the board's id.

### Bus tab

The Bus tab (`apps/web/src/ui/bus/`; lazy-loaded) shows the I2C, SPI and UART traffic of
the bench's bus log as transactions. Decoding happens in the worker (it knows each UART's
baud now) and only while the tab is open (`busWatch`): turning it on reads the log from its oldest
record (the last 65,536), and each frame then carries `bus: { rows, pending, lost, restart }` —
transactions completed since the previous frame with their source's label, board and part,
those still open (replacing the previous frame's), the records the log overwrote first, and
`restart` after a load or reset (time started over). An edit's rebuilt bench brings a new log; the
decoder starts over on it and the tab keeps what it has. The store (`bus-store.ts`) keeps the
newest 2,000 rows (the rest counted), filters by kind (I2C, SPI, UART) and source, and the panel
draws the newest 400: time, kind, source and a summary ("W 0x27  08 0c", "MOSI 2a 00 … / MISO
…", "→ \"hello\r\n\""), a click opening a hex and ASCII dump; it follows the newest unless you
scroll up, and Copy puts the shown rows on the clipboard as tab-separated text.

### Logic analyzer

Probes record net edges in the worker. `Bench.addProbe(pin)` probes the pin's net (a
second pin on the same net shares the probe; at most 16, `MAX_PROBES`) and records the state
then, followed by every level change at the exact simulated time (`bench.now()`, which inside
an MCU run is that MCU's own cycle time). Levels are 0, 1, 2 = floating (z), 3 = conflict (x).
Each probe owns a `ProbeRing` (`packages/core/src/probe/ring.ts`): 2^17 edges in a preallocated
Float64Array of times and a Uint8Array of levels (~1.2 MB), overwriting the oldest and counting
drops. The net-update path checks one preallocated `Int32Array` of probe ids per net (−1 =
none), so an unprobed bench pays one array read per net change (Blink: 16.82 simulated MHz
with no probes, 16.88 with 4 — noise). `bench.reset()` restarts every ring at t = 0. A probe
is flagged `peripheral` while an MCU pin on its net is in mode `peripheral` (the Uno's TX while
the USART transmitter is on): avr8js's USART/SPI/TWI don't drive pins, so those rows say
"peripheral — waveform not simulated".

`SimSession` keeps probes by key (`part:pin`) across loads and resets; each frame it reads each
probe's edges since the last frame (`readProbe(id, since, 65_536)`, the newest when more; the
rest counted as lost) and transfers them as a `ProbeChunk { key, from, times, levels, lost,
peripheral, restart }` — `restart` after a load or reset tells the UI to drop what it had.

UI (`apps/web/src/ui/logic/`): `probes.ts` holds the probe list (a signal saved to
localStorage as `benchtop:probes:v1`, next to the autosave — probes are UI state, not part of
`ProjectDoc`), keeps the worker's set equal to it, and appends each chunk to a client
`ProbeRing` per probe. The Probe tool (toolbar, or the analyzer's chip; Esc leaves it) makes a
pin click add or remove a probe instead of starting a wire; probed pins carry a small flag in
the probe's color (`editor/Wires.tsx`). `LogicAnalyzer.tsx` draws every row on one
devicePixelRatio-aware canvas, redrawn on requestAnimationFrame only after new data or a view
change: high/low lines, z as a dashed mid line, x as a red hatch, and a solid bar where a pixel
column holds several edges. `decimate.ts` turns a probe's edges in the visible window into at
most two segments per device-pixel column, finding each column's last edge by binary search,
so drawing follows pixels, not edges. Wheel zooms around the pointer (while following, it
changes the span with the newest data pinned to the right edge), horizontal wheel and drag pan,
double-click fits everything, Follow keeps the newest data in view; click sets cursor A,
shift-click cursor B (each snaps to an edge within 6 px on the row clicked), and the readout
shows Δt and 1/Δt in SI units (`units.ts`). Export VCD (`probe/vcd.ts`, IEEE 1364 four-state,
`$timescale 1ns`, ids from ASCII 33–126, names like `uno_13`) covers the window every probe
still holds and downloads `benchtop-<project>-<sim time>.vcd`.

### Debugger tab

`apps/web/src/ui/debug/`: the worker parses each board's ELF once per firmware (keyed by a hash
of its bytes, so a reload with the same firmware sends nothing) and keeps the tables; it
resolves the breakpoint texts the UI sends against them at every load, so they are armed before
the first instruction (the controller loads lazily on Run, so resolving in the UI would race).
`store.ts` keeps the breakpoint list (saved to localStorage as `benchtop:breakpoints:v1`), each
board's tables (to show what a breakpoint resolved to and to name a PC), the last stop per board
and the last memory read. `Debugger.tsx`: Continue/Pause (F8), Step over (F10), Step (F11) —
keys act only while the tab has focus —, the location line ("breakpoint · pc 0x0322 addSlow —
debug-demo.ino:11"), the registers grid (SREG as ITHSVNZC), a 256-byte hex view of
data/flash/EEPROM from an address or symbol, and the breakpoint list. Step over a call runs at
max speed until it returns, then restores the chosen speed; a user breakpoint inside it stops
there. Every pause, step, reset and load while paused posts `debugStopped`, so the tab always
shows where each board is. No source text: the compile bridge serves no sketch source (a
known limitation), so the location names file:line only.

Every board: `debugInfo` carries the MCU's kind and its registers in debugger order, so
the grid is built from them (each as wide as the register) with the architecture's status line
under it (`resolve.ts` `flagsLine`: the AVR's SREG as ITHSVNZC, the RP2040's xPSR as NZCV and
its exception number, the ESP32's PS fields and which CPU, the RP2350's mstatus MIE/MPIE), and
the memory view starts in the board's RAM (`memoryStart`: 0x100, 0x20000000, 0x3FFB0000). A
compile through the bridge keeps the ELF it was built from beside the image it runs (the .hex,
.uf2 or .bin: `StoredFirmware.debugElf`, saved with it), and `load`/`setFirmware` send it to the
worker, which reads the symbols and lines from it — so a compiled sketch has functions and
file:line on every board. A dropped .hex, .uf2 or .bin has no symbols: addresses still work. The
GDB stub stays the AVR's.

### The bridge's network proxy

`apps/bridge/src/network.ts`. Started with `--network host:port[,…]` (the simulator's list
rules, repeated — the bridge shares no code with the app; a test keeps them equal), the bridge
opens TCP connections to those hosts for the app's simulated WiFi: `POST /api/net/open {host,
port}` answers with an event stream (`open` {id} once connected, `data` base64, `close`
{error}); `POST /api/net/send {id, data}`, `/api/net/end {id}`, `/api/net/close {id}` act on it,
and the stream's request closing destroys the socket. POSTs only, so a browser always sends an
Origin, checked as for compiling (the bridge's own page or the Vite dev server); the Host guard
applies as everywhere. Without `--network` every open is 403 ("nothing leaves this machine"); a
host:port not on the list 403; at most 16 connections (429); a socket idle 60 s closes.
`/api/health` lists the hosts (`network`). In the worker, `sim/uplink.ts` (`BridgeUplink`) is
the bench's uplink over it — fetch with a streamed body read through `SseParser`; sends, half
closes and closes chained one after another so the bytes stay in order, the ones before the id
queued; an unreachable bridge, an older one (404) or a proxy error reads "the compile bridge
isn't running with --network". In the CLI, `uplink.ts` (`NodeUplink`) keeps the sockets on a
worker thread (`uplink-worker.ts`): the bench runs synchronously, so its pump takes the
worker's replies with `receiveMessageOnPort` and then sleeps (`Atomics.wait`, ≤ 50 ms at a time)
while simulated time is ahead of the wall clock since the first connection opened — a
firmware's timeouts meet real latencies; `--network` reaches the suite's worker threads through
`workerData` and the MCP server's sessions through the sandboxed io. Tested against local
servers: the bridge's proxy with an echo server; the CLI with an ESP32 running
`wifi-http-get` whose access point allows `api.bench:80`, redirected (tests only:
`CliIo.networkRedirect`) to an HTTP server on its own thread — the GET carries `Host:
api.bench`.

## Headless runner

`apps/cli` runs a circuit without a browser, for CI:
`npm run bench -- run <project.json> --firmware <board>=<file> [--script steps.json]
[--expect '<assertion>']… [--duration 3s] [--report out.json]` (plain `node
apps/cli/src/main.ts`, type stripping, no build). `runHeadless(options, io)` (`run.ts`) takes
every file read and the wall clock through `io`, so tests run it in-process; a spawned-node test
proves the real entry point. The project goes through `parseProject`, and
`assembleBench` (`packages/core/src/bench/assemble.ts`, shared with the worker) builds and
resets the bench from the catalog, the AVR factory and the analog specs; the CLI imports
nothing from `apps/web`.

- Firmware: `--firmware <board>=<path>` per board, format from the extension (.hex, .elf,
  .bin). A board whose project entry names a sketch or a dropped file and gets no
  `--firmware` is an error (the CLI doesn't compile sketches).
- Times are `<number><ns|us|ms|s>`; a bare number is an error.
- Script: an array of steps or `{ steps, expect }`. A step is `{ at, part, input }` (a PartInput;
  part ids and input shapes checked), `{ at, part, set: { <channel>: number | boolean } }`
  — one channel input `set:<channel>=<v>` per key, in key order, booleans as 1/0, at most 32 —
  or `{ at, serial, board? }`: text sent to the
  board's UART 0 as the serial monitor would (`board` optional with one board; ≤ 64 Ki
  characters), or `{ at, reset: <board> }`: that board reset (`Bench.resetBoard` — a power cycle;
  its EEPROM or flash keeps what it stored, and the rest of the bench runs on). Runs start with
  erased memory, or with a spec's `memory`. `{ at, part, write: <path>, text | base64 }` creates or replaces a file on a
  part's storage (`Bench.storage`: a microSD card, or an ESP32-S3 board's USB drive), making
  directories on the way — at most 256 KB a step — and `{ at, part, remove: <path> }` deletes a
  file or a directory with what is in it; a file step that can't apply then (no volume, the drive
  not mounted yet, a bad name, full, write-protected, nothing to remove) ends the run with an
  error naming the step and why (exit 2). `{ at, midi: "<hex bytes>", board? }` sends whole MIDI
  1.0 messages from a board's USB host to the device's MIDI port (`Bench.usbMidi`; malformed bytes
  are a usage error, a device without a MIDI port then a run error) and `{ at, locks: ["num" |
  "caps" | "scroll", …], board? }` sets the host's lock keys (`[]` none); `board` may be left out
  with one board whose USB port the bench hosts. Steps apply at exactly their time, in file order;
  `file` assertions due then see them.
- Assertions (`--expect`, repeatable, plus the script's): `serial contains "<text>" by <time>`
  (`serial[<board>]` with several boards; escapes `\"`, `\\`, `\n`) passes at the first
  match at or before that time — matched as the bytes stream in, so output past the report's
  1 MB still counts; `pin <part>:<pin> is <0|1|z|x> at <time>` reads the pin's net then (z floating, x
  conflict; on boards 13 ↔ D13). Inputs at a time apply before the pin checks at that time.
- More expectations:

  | Form | Passes when | Detail when it fails |
  |---|---|---|
  | `serial matches /<re>/<imsu> by <t>` | the first match in the kept serial text (1 MB) ends by `t` (the time its last chunk arrived); ≤ 1024-character pattern, no `g`/`y` | `no match by …`, or the match and when |
  | `pin <p>:<pin> frequency is <hz> [Hz] ±<pct>% between <t1> and <t2>` | (rising edges − 1) / (last − first rise) within ±pct % | `measured 489.80 Hz`, or how few rising edges |
  | `pin <p>:<pin> duty is <pct>% ±<points> between <t1> and <t2>` | time high / window within ±points | `measured 53.13 %` |
  | `pin <p>:<pin> volts is <v> [V] ±<v> [V] at <t>` | the net's volts then within the tolerance — an analog net's solved volts (a capacitor's charge, a transistor's drop) | `0.221 V`, or `no net` |
  | `led <p> is lit\|dark at <t>` | brightness ≥ 0.3 (lit) / ≤ 0.05 (dark); never reported = dark; also a Pico, Pico 2 or Pico W part by its onboard LED (its visual's `led`) | `brightness 0.91` |
  | `servo <p> angle is <deg> ±<deg> at <t>` | the horn's angle within the tolerance | `angle 45.2°` |
  | `motor <p> rpm is <rpm> ±<rpm> at <t>` | a DC motor's signed speed (forward while + is the higher) within the tolerance; never reported = stopped | `-113 rpm` |
  | `lcd <p> row <n> is "<text>" at <t>` | row n (from 0) equals the text, trailing spaces ignored; display off = blank | `row 1 is "t=1"` |
  | `pixel <p>[<i>] is #rrggbb at <t>` | the pixel's 0xRRGGBB | `#38b748`, or the pixel count |
  | `digits <p> show "<text>" at <t>` | the digits (`displayText` from @benchtop/parts: 0–9, '-', E H L P, '°' and C, ' ' dark, '?' other; the MAX7219's 8-digit and the TM1637's modules by their lit segments, so a dim digit reads) | `shows "1234"` |
  | `oled <p> pixel <x>,<y> is on\|off at <t>` | an OLED's pixel as shown (`oledPixel`: off while the display is; `invert`, `allOn`); never reported = dark | `pixel 64,32 is on` |
  | `matrix <p> row <r> shows "<#.…>" at <t>` | a MAX7219 matrix module's row r from the top, left to right (`matrixText`; '#' or 1 lit, '.' or 0 dark; 8 dots, or 32 on the FC-16) | `row 2 shows "#.#..#.#"` |
  | `env <gas\|temperature\|humidity\|light\|sound> at <p> is <v> ±<tol> at <t>` (or `>`, `<`, `>=`, `<=` `<v>`) | the room's value at a part placed in it (`bench.envSample`); a usage error without an environment part or on a part with no place in it | `gas 812.40 ppm` |
  | `bus i2c <p> wrote\|read <hex bytes> by <t>`, `bus spi <p> sent <hex bytes> by <t>` | some transaction with that part in the bus log — an I2C write or read, an SPI frame's MOSI — carried those bytes in a row by then (when the transaction ended); read every 50 ms so the log's ring can't wrap; a transaction still open at the end counts | `seen at 31.402 ms` |
  | `file <p> <path> contains "<text>" by <t>` | the part's file (a microSD card's, through `bench.storage` — or an ESP32-S3 board's USB drive; the path matched without case) held the text by then — read at every stop and every 50 ms while the card's version moved; failures say whether the file was missing or what it held | `seen at 50 ms` |
  | `wifi <board> connected by <t>` | the board's station got its address from an access point's DHCP server (`net.listen`'s `connected`) by then; a usage error without a `wifi-ap` part | `connected to ap as 192.168.4.2 at 1.61 s` |
  | `http <p> served <METHOD\|*> <path[?query]> by <t>` | an `http-server` part answered such a request by then (a query, when given, must match too) | `served GET /api/hello → 200 at 1.7 s` |
  | `http <p> got <status> [with "<text>"] by <t>` | an `http-client` part's request came back with that status (and a body holding the text) by then; a failure names the last response (`last: 200`, `last: error: …`) | `got 200 at 2.008 s` |
  | `usb[<board>] received "<text>" by <t>` | the board's USB host (`Bench.usbOf`: an ESP32-S3's USB-OTG port) received the text — in what a keyboard typed or an event's line (`mouse: left down`, `MIDI: note on ch 1 C4 (60) velocity 100`) — by then; read at every stop and every 10 ms, timed by the event (typed text by the read that saw it); `[<board>]` may be left out with one ESP32-S3 board; a usage error on a board without a host | `received at 612.3 ms` |

  Visual forms read the part's latest visual state at `t` (frames are collected at every stop)
  and check the part's type up front (an LED, a servo, an LCD and its row count, a NeoPixel, a
  7-segment display). Frequency and duty put a probe on the pin and fold its edges into the window
  at every stop and every 50 ms inside it, so the 131,072-edge ring never overflows below ~1.3
  MHz; a window that still drops edges fails saying so. ± may be written `+-` or `+/-`.
- The run lasts `--duration`, else the latest scripted or asserted time; neither, or a duration
  shorter than an assertion, is a usage error. It runs flat out, stopping at each distinct
  input/check time.
- Report: `{ ok, exitCode, simulatedNs, wallMs, simulatedMHz, assertions: [{ text, ok, atNs,
  detail }], serial: { <board>: text (first 1 MB) }, problems, error }` on stdout (or
  `--report`), a one-line summary on stderr. Exit 0 all passed, 1 an assertion failed, 2 usage,
  load or run error. Identical inputs give identical reports apart from `wallMs` and
  `simulatedMHz` (cli-demo runs at ~39 simulated MHz under plain Node).

### Test suites

`npm run bench -- test <spec|folder>… [--jobs N] [--junit f] [--markdown f] [--report f]`.
A spec (`*.bench.json`, `apps/cli/src/spec.ts`) is a `run` as a file: `{ name?, project,
firmware?, duration?, steps?, expect? }`, paths relative to the spec; parsed defensively (1 MB
cap, unknown fields refused, every field type-checked; grammar errors surface in the run, naming
the spec). `suite.ts` discovers specs (folders searched in name order, `node_modules` and dot
folders skipped), runs them on `node:worker_threads` (`suite-worker.ts`; default jobs = cores −
1; `--jobs 1` in-process) and returns results in discovery order. Exit code: 2 if any spec
couldn't run, else 1 if any expectation failed, else 0. Reports (`reports.ts`): JUnit XML — a
`<testsuite>` per spec (property `simulated`), a `<testcase>` per expectation with a `<failure>`
saying what was seen, a spec that couldn't run as one `run` testcase with an `<error>`, serial in
`<system-out>` (64 KiB per board, CRLF as LF), problems in `<system-err>`, characters XML forbids
as U+FFFD; times are wall seconds. Markdown — a table per spec plus each failure, no wall times,
HTML-escaped outside code spans. `fixtures/specs/` holds five specs (blink, serial echo with a
serial step, button, DHT22, Uno ↔ ESP32) with golden reports in `fixtures/specs/golden/`.

### Recording a test

The toolbar's **Record test** reloads if needed, sends `recordStart` (a bench reset: the test
starts at t = 0, as the CLI's run does) and runs. In the worker, `TestRecording`
(`apps/web/src/sim/recording.ts`) logs each `input` (button presses, knob and slider values,
keypad keys) and each `serialSend` (text typed into a serial monitor) at `bench.now()` — exact to
the nanosecond, so a replay applies them at the same instants however the worker sliced its run
(microphone samples are a stream and aren't recorded; at most 10,000 steps). It also follows each
board's serial output by line, with the simulated time each line arrived. **Stop** sends
`recordStop`: the session pauses, runs on to the next whole millisecond and posts `recorded` —
the steps, the duration and proposed expectations from what holds then: each board's most recent
distinct serial lines (`serial contains "…" by` the whole millisecond after the line first
arrived), lit LEDs, non-blank LCD rows (printable ASCII only) and servo angles (±2°). A reset or
a new load ends a recording. The dialog (`ui/RecordDialog.tsx`) lists the proposals ticked, a
name and each board's firmware path (relative to where the spec will be saved; the browser
can't know where builds live), and downloads `<name>.bench.json` built by
`editor/test-spec.ts`: the circuit inline (a spec's `project` may be the document itself; the
CLI validates it like a file), the steps at exact times (`1500us`, `123456789ns` when not whole
ms), the duration and the chosen expectations. `apps/web/src/sim/recording.test.ts` records in
real time on the session's manual clock and replays the spec through `runHeadless`: identical
serial output, every proposal passing.

The Inspector's file writes and removes (a card's, a USB drive's — the worker's `storage`
requests that succeed) are recorded as `write` steps (`text` when the bytes are UTF-8, else
`base64`; a write over 256 KB isn't kept and the dialog says so) and `remove` steps. A bench
reset keeps a microSD card's files, so `recordStart` snapshots each card's files and, when they
differ from the project's power-up files, the spec's inline circuit gives the card them as its
`files` prop (a card holding more than that prop takes, 256 KB, starts from the project's files
and the dialog says the replay may differ).

a bench reset keeps each board's EEPROM or flash data too, so `recordStart` snapshots it
(`Bench.nonVolatileOf(board).snapshot()`: data sectors only — the program's are the firmware's)
and `finish` keeps each board's sectors with their trailing erased bytes (0xFF) trimmed, in base64
(`RecordedTest.memory`; more than `MAX_RECORDED_MEMORY`, 256 KB, of a board's data → `memoryNotKept`,
and the dialog says the replay starts that board erased). The spec carries it as
`"memory": { "<board>": [{ "offset": "0x9000", "base64": "…" }] }`; the CLI (`parseSpecMemory`)
checks every field, and `runHeadless` pads each sector back to its size and restores it right after
building the bench — where the worker restores saved data, before the firmware runs a step
(`restoreSpecMemory`: a board the project lacks, one without memory, a sector off its memory,
misaligned, too long or on the program's sectors is a usage error, exit 2). A stored counter
records and replays the same (`recording.test.ts`); `fixtures/specs/memory/` starts the Uno's EEPROM
counter at 41 and the ESP32's Preferences LED on.

### The examples as a regression suite

`fixtures/specs/examples/<id>.bench.json` runs every gallery example headless with
expectations from its card, written once from the examples' Vitest checks where the grammar
says the same thing (Simon's "press the LED that lit" and a microphone's tone need code: those
specs check what they can, the Vitest checks keep the rest). `npm run verify` runs
`npm run bench -- test fixtures/specs` (54 specs, ~30 s on 7 workers); examples.test.ts checks
every example has its spec on the same project and firmware, and no spec outlives its example.
Two values there are measured, not designed: the rainbow ring's first pixel (#004e07 at 1.2 s,
#000e47 at 2 s) and PCM's average duty (50.1 %) — its rising-edge rate reads ~57 kHz, not the
62.5 kHz carrier, because pulses shorter than one emulator step have no edges (see the Uno's timer fix).

### Firmware the published repository leaves out

The Pico W and Pico 2 W fixtures (`fixtures/firmware/picow/`, `pico2w/`) link the cyw43-driver
and Infineon's CYW43439 firmware, whose licenses don't allow redistributing them
(THIRD_PARTY_NOTICES.md). The fixtures manifest marks them `"redistributable": false`
(`redistributable` per board folder in `scripts/fixture-boards.ts`); this repository leaves
those outputs out, and `fixtures/withheld-firmware.json` gives the reason and the files. A file listed there and missing is
*withheld*: the tests that need it skip (`withheldFirmware()` in `fixtures.test-helper.ts` with
`describe.skipIf`), the spec suite reports its specs as skipped, not passed (`withheldReason` in
`suite.ts`: a JUnit `<skipped>`, a ⏭️ Markdown row, "N skipped" in the summary line), and the
gallery and the MCP server's `list_examples` leave out examples whose firmware isn't there
(examples.test.ts checks only withheld files are missing). Built (`npm run fixtures -- --only picow`, `--only pico2w`), a
listed file runs again; without the list, every fixture must be there and a missing one fails.

### GDB remote stub

`npm run bench -- gdb [--port 3333] [--speed realtime|max] [--board <id>] <project.json>
--firmware uno=<file.elf>` serves one board to avr-gdb or any RSP client. The protocol is
DOM-free in `packages/avr/src/gdb/` on the debugger's `McuDebug` (no contract change): `rsp.ts` (a
streaming decoder fed arbitrary chunks — `+`/`-` acks, `$data#xx` packets with a mod-256
checksum, the 0x03 interrupt byte between packets, `}` escapes — and the encoder),
`target.ts` (GDB's avr-tdep view: `g`/`G` are 39 bytes, R0–R31, SREG, SP little-endian, PC as
a 4-byte little-endian byte address; memory addresses put flash at 0x000000, the data space at
0x800000 and EEPROM at 0x810000, anything else or past the end of a space → `E01`) and
`server.ts` (`GdbSession`: qSupported → `PacketSize=1000;QStartNoAckMode+`, `?`, g/G, m/M,
c/s [addr], C/S, vCont?/vCont;c/s, Z0/z0 through `setBreakpoint` — never BREAK in flash —,
qAttached, qC, thread queries, Hg/Hc, `k` resets and closes, `D` says OK and closes leaving the
bench paused, everything else an empty reply; stop replies S05 breakpoint or step, S02
interrupt, S04 fault; no-ack mode; a `-` resends the last reply). `apps/cli/src/gdb.ts`
(`startGdbServer`) listens on 127.0.0.1 only, one client at a time (a second is closed
within 50 ms; a client's breakpoints go with it). `k` and `D` free the slot at once, not when
the socket's close event arrives, so gdb reconnecting right after `kill` is served (a race found
2026-10-20: the test's reconnect lost it under load). The 50 ms grace covers the other order:
Linux can accept the new connection before the old one's `k` is read (GitHub's CI hit this
2026-11-03), so a newcomer waits that long for the slot to free before it's refused. While continuing it runs the bench in 1 ms
simulated slices, paced in real time unless `--speed max`, yielding with `setImmediate`
between slices, so a 0x03 is answered within milliseconds (1.3 ms in the test). No avr-gdb
exists on the dev machine; a scripted RSP client over `node:net` is the test. Watchpoints,
target descriptions and multi-MCU threads aren't supported.

### MCP server

`npm run bench -- mcp [--root <folder>] [--max-sim <time>] [--max-wall <seconds>]` (or `node
apps/cli/src/main.ts mcp …`, which MCP clients run) serves Benchtop to an AI assistant over the
Model Context Protocol on stdio — one more front end over the headless runner, in
`apps/cli/src/mcp/`, with no dependency:

- `jsonrpc.ts` frames JSON-RPC 2.0 one message per line (parse errors, invalid requests,
  notifications unanswered, client responses ignored, batches answered element by element).
- `server.ts` (`McpServer`) speaks the protocol: `initialize` takes the client's version when it
  is 2025-11-25, 2025-06-18, 2025-03-26 or 2024-11-05, else answers with the newest, and
  declares `tools` and `resources`; `tools/list`; `tools/call` validates the arguments against
  the tool's schema (`schema.ts`, a JSON Schema subset a test holds every tool to) and returns
  the tool's JSON as one text block — and as `structuredContent` from 2025-06-18. A tool's own
  failure (bad arguments, a path outside the root, an invalid project, a missing ROM, a limit)
  is an `isError` result carrying the CLI's message, so the assistant can correct itself; an
  unknown tool or method is a JSON-RPC error. No prompts, sampling, elicitation or tasks.
- `sandbox.ts` confines files: every path is relative to `--root` (default: the working folder)
  and must resolve — symlinks followed — inside it; `Sandbox.io()` is the CLI's `CliIo` with
  that check on every read, so a project or spec can't point outside whatever it says. The
  downloaded ROMs and interpreters come from the CLI's own cache, never from a tool's path.
- `command.ts` parses the flags, routes `console.*` to stderr (stdout carries protocol lines
  only) and serves stdin until it closes.
- Tools (`tools/`): `list_parts` and `describe_part` (pins with roles and supplies, props and
  defaults, a board's MCU and pin map, and `PART_INPUTS` — what each part takes while running,
  a table in `@benchtop/parts` checked on a bench by its test); `validate_project`
  (`parseProject`'s errors with their paths, then the wired bench's problems without firmware);
  `run_simulation` (`runHeadless` with the project by path or inline, firmware paths, inline
  MicroPython sketches for the Picos put into the project's firmware table as the Code tab
  stores them, steps, assertions, a duration — the report with serial cut to 64 KB a board);
  `run_tests` (specs from files or folders, one after another).
- Live sessions (`sessions.ts`, `tools/sim.ts`): `sim_open` builds a bench like
  `run_simulation` and keeps it (ids `s1`, `s2`, …; at most `maxSessions`, default 8 — opening
  one more closes the one used longest ago); `sim_run` advances it by a duration in 10 ms
  slices, stopping early at a serial text (`untilSerial`), at the wall-clock budget or at a
  breakpoint, and returns the serial text since the last call (the newest 64 KB a board, with
  what was dropped), problems not reported before, and per watched pin ("part:pin") its edges,
  frequency (from rising edges), duty and final level over that run; `sim_input` checks the part
  and input through the spec parser (`parseScript`) and sends it at the current time;
  `sim_serial`; `sim_state` returns every part's latest visual state (arrays over 32 entries —
  framebuffers — summarized unless `full`) and pin levels and volts (and per ESP32-S3 board whose
  firmware started USB, `usb` — the host's phase, device, functions, the last 2,000 characters
  typed and the last 50 events, timed); `sim_bus` (the I2C,
  SPI and UART transactions decoded since the last call — I2C address, R/W, bytes, NACKs; SPI
  frames' MOSI and MISO; UART bursts as text — the newest `max` after a bus-kind or part filter,
  open ones marked, with how many more and what the log lost); `sim_storage` (a board's
  EEPROM or flash as the firmware left it — `Bench.nonVolatileOf(board)` — the sectors in use; an
  EEPROM's non-erased bytes by address (1024 at most, then a count); an ESP32's NVS entries, decoded
  by `@benchtop/esp32`'s `decodeNvs` from each `nvs` partition the table lists: namespace, key,
  type, value — 64-bit numbers as decimal strings, blobs as the first 64 bytes in hex with their
  size; `erase` erases the data, the program staying); `sim_files` (a card part's
  files as the sketch left them — list them; read one as text when it is UTF-8, else base64, 64 KB
  at most; write one from `write` text or `writeBase64`; `remove` one or a directory); `sim_usb`
  (for an ESP32-S3 whose sketch uses its own USB, the bench's host sends the device a `note` — by
  name, "C4" is 60, or number — with `velocity`, `channel` and `off`, or `midi` bytes in hex, or
  sets its `locks`; errors name a bad note, malformed bytes, a device without a MIDI port;
  `sim_state`'s `usb` adds `takesMidi`, `keyboardLeds` and the `locks` on); `sim_wifi`
  (the access points — SSID, on, channel, signal, security — with the boards joined to
  each, their addresses and hostnames, the server and client parts on its LAN, and each ESP32
  and ESP32-C3 board's state; `softAccessPoints`, the APs boards host — board, SSID, channel,
  security, station limit, the stations on each (a board, or a client part matched by MAC) with
  the address the board's own DHCP server gave and the hostname they sent, and the client parts on
  it — `waiting`, client parts whose network nobody hosts yet, and a hosting board's state as
  `hosting "<ssid>"`, after its station's in AP+STA; runs nothing); `sim_http` (one request from an AP's gateway to a URL on
  its LAN — a board's web server by hostname — running the session until the response or
  `timeout`, default 5 s, stopping at the 10 ms slice it arrived in: status, headers, the body as
  text up to 64 KB, or why it failed, plus the serial since the last call); `sim_update` (a new
  project document for a live session, rebuilt with carry-over like an edit in the app — boards
  keep running unless `firmware`/`micropython` names them, which re-flashes them; returns the
  boards kept, started and removed and the watched pins that went; if the rebuild fails the
  session is closed and the call says so); `sim_reset` (boards keep their EEPROM and flash, as
  after a power cycle, unless `erase`), `sim_close`, `sim_list`.
- Examples (`tools/examples.ts`): `list_examples` and `open_example` (a session on an
  example's own firmware, with its sketch sources) and the resources `benchtop://examples/<id>`
  (card, project document, sketches) come from `fixtures/examples.json` in the Benchtop
  repository — the files it names are read by id from that fixed list, never from a client's
  path, so they stay readable whatever `--root` is.
- Debugging (`tools/debug.ts`) on every board (each MCU's `McuDebug`; symbols
  from the .elf, or from an `.elf` or `.syms.tsv` beside a .hex/.uf2/.bin — `compile_sketch`
  writes the .elf beside its image, the fixtures keep the listings; gallery examples load theirs):
  `debug_registers`
  (with SREG's flags and where the PC is — function+offset and file:line from the session's
  tables, built from the board's .elf when it was given one), `debug_memory` (data, flash or
  EEPROM by address or symbol, ≤ 1024 bytes, side-effect free), `debug_breakpoints` (set,
  clear, list — `resolveBreakpoint`'s address, function and file:line forms) and `debug_step`
  (instructions, or over a call with `stepOver`); `sim_run` continues and stops at a breakpoint
  with where it is.
- Building (`tools/build.ts`): `compile_sketch` (a sketch folder under the root or inline
  files, for a board part type — the same FQBN per board as the web app, which a test checks —
  or an allowlisted FQBN; `scripts/compile.ts` runs the local arduino-cli) writes its outputs
  to `<root>/.benchtop/build/<name>/` and names the firmware to run (the .elf for AVR, so the
  debug tools see symbols); `pcb_check` returns DRC's violations, the unrouted connections and
  the counts for a project's layout or a seeded one (`projectPcb`, shared with `bench pcb`);
  `pcb_export` writes the fabrication files (or one ZIP) to `<root>/.benchtop/pcb/<name>/`.
  `.benchtop/` is the only place the server writes (`writeOutputs`, every path checked against
  the root again).
- Bounds: `runHeadless` takes `maxDurationNs` (a longer run is a usage error) and `maxWallMs`
  (with a budget it runs in 10 ms simulated slices and stops with an error when the budget is
  spent); the server passes `--max-sim` (default 60 s) and `--max-wall` (default 30 s).

## PCB

`@benchtop/pcb` (`packages/pcb/src/`, DOM-free, on core and parts) lays a bench project out as a
two-layer through-hole board. The bench project stays the circuit's one truth: a PCB document
(`doc.ts`, `*.pcb.json`, `format: 1`) holds only what a person draws — the outline, where each
footprint sits (`{ part, ref, x, y, rotation }`, the origin at the part's centre), traces (`{ id,
layer: 'F' | 'B', width, points }`), vias (`{ id, x, y, drill, diameter }`) and the rules — and
footprints, pads and nets are always derived from the project and the catalog, so the two can't
disagree. `parsePcb` treats documents as untrusted, as `parseProject` does (types, ranges,
unique ids and refs, size limits: 2,000 footprints, 20,000 traces of ≤ 1,000 points, 20,000
vias; errors with JSON Pointer paths).

- **Footprints** (`footprints.ts`): a part reaches a PCB as what it plugs into, so its footprint
  is its own pins (the drawings are at real size) with every run of pins about 0.1″ apart —
  along a row or a column — snapped to an exact 2.54 mm pitch from its first pin (the drawings'
  2.52/2.64 mm rounding wouldn't fit a header); 1.7 mm pads on 1.0 mm holes, pad 1 square, the
  part's outline as silkscreen. The Uno and the Mega are shields (their headers, the 0.16″ step
  kept from the drawing), the Nano and the DevKit their two rows. Standard footprints for the
  basic components: a 10.16 mm axial resistor, a 5 mm LED (pad 1 = cathode), a 5 mm RGB LED in a
  row, a 6 mm pushbutton (6.5 × 4.5 mm). Pins a part shorts inside (a board's GND pins, a
  button's two legs per side) share a pad number, as KiCad numbers them, and count as connected.
  Off the board: breadboards, the IR remote, the environment parts, anything without pins.
  References by type (R, D, SW, RV, BZ, LS, MK, K, M, J, DS for displays, A for boards, else
  U); values: a resistor's ohms (4.7k), an LED's colour, else the part's title.
- **Nets** (`board.ts`, `PcbBoard`): the bench's own `buildNetlist` (contacts included), so
  breadboard strips and jumper wires become nets and nothing else does. A net is named after a
  board pin on it — supplies first (GND, 5V, 3V3), numbered pins as D13 — else KiCad's
  `Net-(R1-Pad2)` after its first pad; names are unique (`GND_1` for a second board's separate
  ground).
- **Seeding and reconciling** (`seed.ts`): `seedPcb` puts every footprint where its part sits
  on the bench (centre, rotation), references numbered per prefix in part-id order (r2 before
  r10), and an outline 3 mm around the courtyards on whole millimetres; `reconcilePcb` follows
  an edited bench — gone parts' footprints dropped, new ones stacked right of the outline,
  references, positions, traces and the outline kept.
- **Connectivity and ratsnest** (`connectivity.ts`, `ratsnest.ts`): copper items — pads and
  vias on both layers, each trace segment on its own — as capsules (a segment swept by a
  radius) and rectangles (square pads); items whose copper touches on a shared layer join an
  island (union-find; broad phase by sweeping bounding boxes sorted by their left edges). The
  ratsnest is, per net, a minimum spanning tree over its islands (Prim), each line between the
  closest pads of the islands it joins.
- **DRC** (`drc.ts`): errors for copper of different nets on a shared layer closer than the
  clearance (a floating trace counts as its own net), copper joining two nets (a short), a
  trace below the minimum width, a via's drill or annular ring below the minimum, copper nearer
  the edge than the edge clearance or outside the outline, a footprint outside the board, no
  outline, and unrouted nets (with the number of missing connections); a warning for
  overlapping courtyards. Each names its items in a fixed order and a point to look at; at most
  50 per code are listed (the last says how many more). Default rules (a hobby fab's 2-layer
  limits with room to spare): clearance 0.2 mm, width 0.25 mm (new traces 0.4), drill 0.3 mm,
  annular ring 0.15 mm, 0.5 mm to the edge, vias 0.4/0.8 mm. Measured: 500 footprints and 5,000
  segments in ≈ 16–28 ms.
- **Exports** (`export/`): Gerber RS-274X (`gerber.ts`) — F.Cu, B.Cu, F.Mask, B.Mask,
  F.Silkscreen, Edge.Cuts, with X2 file attributes (file function, polarity), `%FSLAX46Y46*%` mm
  (10⁻⁶ mm units), linear interpolation, y negated (the bench's y grows down); pads flash their
  aperture (C circle, R rectangle, O obround), vias flash circles and are tented (not in the
  mask), traces, silkscreen and the outline draw with round apertures; mask openings are the
  pads grown 0.05 mm per side (negative polarity, as KiCad writes them); the silkscreen carries
  each footprint's outline and its reference in our own stroke font (`font.ts`, 1 mm capitals).
  Excellon (`excellon.ts`): every plated hole, tools by diameter, metric decimal coordinates.
  BOM (`bom.ts`): CSV per RFC 4180, a row per part type and value. KiCad (`kicad.ts`): the
  netlist s-expression `(export (version "E") …)` with footprints in a `Benchtop` library, and
  that library as `Benchtop.pretty/<name>.kicad_mod` (KiCad 6+ syntax) for every footprint used,
  so an import finds each footprint with the pad numbers the netlist uses. A bus's pads (a
  board's GNDs) are one node. `fab.ts` names the files after the board (KiCad's suffixes, which
  fabs recognize: `-F_Cu.gtl`, `-B_Cu.gbl`, `-F_Mask.gts`, `-B_Mask.gbs`, `-F_Silkscreen.gto`,
  `-Edge_Cuts.gm1`, `-PTH.drl`, `-bom.csv`, `.net`, plus the layout `.pcb.json`) and `zip.ts`
  bundles them (stored, CRC-32, fixed timestamps: byte-identical runs). Everything is
  deterministic text, checked against golden files of a hand-routed fixture board
  (`fixtures/pcb/blink.pcb.json`), and read back by our own Gerber/Excellon readers in the tests
  (`export/gerber.test-helper.ts`: every pad, via and trace is copper where the board has it, a
  1 mm grid elsewhere is not, mask openings, the closed outline, the holes).
- **CLI** (`apps/cli/src/pcb.ts`): `npm run bench -- pcb <project.json> [--pcb
  layout.pcb.json] --out <folder> [--zip] [--drc]` — the given layout reconciled with the
  project, or a seeded one; DRC findings and a summary on the terminal; the files into the
  folder (or one ZIP); exit 1 with `--drc` when DRC finds an error, 2 on a usage error.
- **The PCB view** (`apps/web/src/pcb/`): **Bench | PCB** in the toolbar puts the PCB view
  (`PcbView.tsx`) over the bench in the same grid area; the bench stays mounted underneath (its
  views keep receiving frames) and ignores keys while the PCB is shown. One SVG under the same
  camera math as the bench (`editor/camera.ts`: wheel pans, ⌘/Ctrl + wheel zooms): the board,
  the back then the front copper (the active layer on top and brighter), pads with their holes,
  vias, the silkscreen (`footprintSilk` from @benchtop/pcb, so the view and the Gerber agree),
  the ratsnest, red rings at DRC findings, and the route being drawn. Select tool: click or drag
  footprints (25 mil snapping, Alt free), click traces and vias; R rotates, Delete removes
  traces and vias (footprints follow the bench). Trace tool (X; `route.ts`, DOM-free): click a
  pad, click bends — each reached straight then at 45° — V (or L) ends the piece at a via and
  goes on on the other layer, a click on a pad (or a double-click) finishes; Backspace drops the
  last point. Handlers read the route through a ref set synchronously, not the last render's
  value (a fast key after a click used to act on the stale route — found in the browser).
  State (`store.ts`, DOM-free): the PCB document as a signal, the selection (`fp:`/`tr:`/`via:`
  keys), tool, layer and width, commands with 200-step undo, and `sync(project)` — seeded the
  first time, reconciled after bench edits, reseeded for another project; autosaved to
  localStorage (`benchtop:pcb:v1`, `{ project, doc }`) 500 ms after an edit and on page hide,
  restored through `parsePcb`. The PCB code is a chunk of its own, loaded the first time PCB is
  chosen (`ui/lazy.tsx`'s `lazyComponent` for the view, its Inspector and the DRC rows; the
  toolbar's PCB actions by dynamic import): the main bundle stays 317 KB (it was 364 KB with the
  PCB in it). `mode.ts` is what loads eagerly — `viewMode`, `pcbFocus`, the DRC count for the
  Problems badge and `resetPcb()` (drops the autosave; New, Open and examples call it).
  `app-pcb.ts` holds the app's store and the PcbBoard
  and its ratsnest + DRC as computed signals the view, the Inspector (`PcbInspector.tsx`: a
  footprint, a trace's width, or the board's size, Fit outline and its rules) and the Problems
  tab share — DRC rows lead the Problems list while the PCB is shown, and a click centres the
  view on the spot. Files (`actions.ts`): Export ▾ → PCB fabrication files (the ZIP) or the
  layout (`.pcb.json`); Open… recognizes a layout (format 1 with an outline and footprints) and
  opens it for the bench on screen. New, Open and an example reset the PCB; the Blink example
  brings its own (`fixtures/pcb/blink.pcb.json`, manifest field `pcb`). Shortcuts: X, L, V and
  double-click in `PCB_SHORTCUTS` (editor/shortcuts.ts; the `?` sheet's PCB group and the
  README list them; a test checks the view handles each).

## Compile bridge

The one thing a browser can't do is run `arduino-cli`, so `apps/bridge` (zero dependencies,
its compile code — the run, diagnostics, inline sketches, the FQBN allowlist and the inline
sketch rules — in `scripts/compile.ts`, shared with the CLI's MCP server;
plain Node type stripping) does it on the same machine: `npm run bridge` listens on
127.0.0.1:5175 and the Vite dev server proxies `/api` to it; `npm start` builds the app and
serves it from the bridge on one origin (with the same cross-origin isolation headers). The
downloads the simulation worker fetches — the ESP32, ESP32-C3, ESP32-S3 and ESP32-S2 ROMs, the RP2350
bootrom, the Pico's and Pico 2's MicroPython UF2s — are one table, `scripts/downloads.ts` (URL path
→ the file in the git-ignored .cache, and its fetch command). The dev server's one `downloads()`
plugin and the bridge (when it serves the app) both answer from it: GET (and HEAD on the bridge)
of those exact names, `Cross-Origin-Resource-Policy: same-origin`, the bridge's Host and Origin
rules; another name in those folders is a 404, a missing file a 404 naming its fetch command
("ESP32-S3 ROM not installed: run npm run fetch:esp32-rom"). So every board runs under `npm start`,
not only in development. Nothing is copied into dist; the service worker doesn't precache them.

- `GET /api/health` → the CLI's version and installed cores (`null` when no CLI was found —
  discovery is `scripts/arduino-cli.ts`, shared with the fixture build).
- `POST /api/compile { sketch, fqbn }` → `{ ok, durationMs, diagnostics, stdout, stderr,
  artifacts }`, binary artifacts base64. `arduino-cli compile --json` runs with an argument
  array (never a shell), a 120 s timeout, a per-sketch build cache under
  `<tmp>/benchtop-build/<sha1 of the path>` (incremental rebuilds of blink take ~1 s) and a
  temp output folder that is removed afterwards — the bridge writes nowhere else. Diagnostics
  come from the CLI's structured `builder_result.diagnostics` (file, line, column, severity,
  first line of the message).
- `GET /api/watch?sketch=…&fqbn=…` → Server-Sent Events `compile-start` / `compile-result`:
  one compile on connect, then one per saved `.ino`/`.h`/`.hpp`/`.c`/`.cpp` change (fs.watch,
  300 ms debounce). Clients watching the same sketch share one watcher; a change during a
  compile queues exactly one more, and all compiles of one sketch (watch or POST) run one at a
  time because they share the build cache.

Safety, since it runs a compiler on paths it is given (`apps/bridge/src/safety.ts`, every rule
tested): it binds loopback only; the Host header must be `127.0.0.1:<port>` or
`localhost:<port>` (a DNS-rebinding guard — the dev proxy sets `changeOrigin` so it passes);
any request carrying an Origin must come from the bridge's own origin or the Vite dev server
(5173), and POST must carry one; FQBNs are allowlisted (`arduino:avr:uno`,
`esp32:esp32:esp32`); a sketch is an absolute existing folder `<dir>/<name>` holding
`<name>.ino`, with no `..` segment, not under `node_modules`, `/System`, `/usr` or `/bin`
(checked again after resolving symlinks); request bodies are capped at 64 KB and responses at
16 MB; static serving never lists folders or leaves the served folder.

- `POST /api/compile-inline { fqbn, files, main }` → the same result. The sketch is
  checked like parseProject checks a document (`validateInlineSketch`: the FQBN allowlist,
  1–32 files, safe names with no folders, ≤ 256 KB of UTF-8 source, `main` a .ino among them;
  the limits are repeated in safety.ts — the apps share no code — and a test keeps them equal);
  the body cap is 1 MB for this endpoint. The files are written to a fresh
  `<tmp>/benchtop-inline-*/<main's name>/` folder, compiled, and the folder is removed
  afterwards; the build cache is one per board + sketch name (`buildKey`), so a recompile is
  incremental (blink: ~4 s cold in a new cache, ~2 s after). Diagnostics and output name the
  files as given (the temp path, also under macOS's `/private`, is stripped).

A bridge started without a terminal (for example by an editor's launch configuration) can leave
arduino-cli hanging idle; `npm run bridge` from a terminal compiles normally.

The app's client is `apps/web/src/sim/bridge-client.ts`: health, compile, and the watch as SSE
read over `fetch` (EventSource can't say why it failed), parsed by `sim/bridge-sse.ts`. A
dropped watch reconnects with backoff (1 s doubling to 30 s, reset by a good connection); the
bridge sends a keep-alive comment every 5 s and the client treats 15 s of silence as a drop.
The dev server's proxy cuts the browser's stream when the bridge's response closes, so a
stopped bridge shows up within a second or two.
