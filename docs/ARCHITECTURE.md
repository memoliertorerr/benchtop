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
| `@benchtop/core` | time units, scheduler, netlist, signal resolution, the analog layer, the environment world, the `PartDefinition` / `PartModel` / `Mcu` contracts, the project document schema | import any other `@benchtop/*` package; touch DOM or Node APIs |
| `@benchtop/avr` | the Uno `Mcu`: ATmega328P peripherals via avr8js, Uno pin map, Intel HEX and ELF loading | know about parts or the UI |
| `@benchtop/esp32` | the ESP32 `Mcu` (`createEsp32Mcu`, `esp32McuFactory`): Xtensa LX6 core, SoC (memory map, peripherals, two cores, pins), direct boot, boot debugging | know about parts or the UI |
| `@benchtop/parts` | the part catalog: pin layouts, internal buses (breadboards), metadata, behavior models | touch DOM — views live in `apps/web` |
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
contract. `runUntil(t)` repeats:
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
with 0x21/0x22 windows, and the decided display mapping (A1 + C8 is the identity; A0/C0 mirror;
start line and offset rotate rows; rows past the multiplex ratio are dark; lit only when on
and the charge pump is enabled). Scrolling commands are parsed but not performed. Its visual
`fb` packs the displayed image into 256 numbers (4 page-major bytes each) and is repacked only
when a written byte actually changed, so an identical `display()` costs no frame; `on`,
`invert`, `allOn` and `contrast` travel separately and the view (`views/ssd1306.ts`) applies
them while unpacking into one preallocated ImageData (contrast as canvas opacity
0.35 + 0.65 × contrast/255).

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
  `floating-input` (an INPUT pin, no pull, wired to another part, floating for two checks with
  no mode change between them), `esp32-overvoltage` (an ESP32 pin's net above 3.6 V),
  `pin-overcurrent` (a pin driving its net — output, peripheral or DAC — with more than its
  absolute maximum, 40 mA on all three MCUs, computed as (drive − net volts)/25 Ω on nets the
  analog layer solves; held for 1 s after the last check that saw it, so blinking and PWM pins
  stay reported), `port-overcurrent` (warning: the same per-pin currents summed per board by
  the AVR pin groups that share supply pins, sourcing and sinking apart, each MCU pin once per
  net, against the datasheet's group limit — `check/port-groups.ts`: ATmega328P 150 mA out /
  100 mA in, ATmega2560 200 or 100 mA; past it the datasheet only says V_OH/V_OL may leave
  spec, hence a warning; it names the pins carrying ≥ 1 mA and the group, held 1 s like a pin's;
  no ESP32 groups) and `unpowered-part` (a wired power or ground net with no driver).
- **Reported by parts** (`ctx.report`): sticky until reset or a topology change, except that a
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

### MCUs

The contract is `packages/core/src/contracts/mcu.ts`. An `Mcu` exposes its `clockHz` (the
constant rate its `cycles` counter advances at), firmware loading (`FirmwareImage`: HEX text,
ELF bytes or an ESP32 app image), `reset()`, `runUntil(targetCycles)`, its pins as `McuPin`s
(mode, output level, optionally `outputVolts()` — an analog output such as a DAC, which the bench
drives at strong strength — `setInput(NetState)`
from the bench, `onOutputChange` fired synchronously from inside the run) and its UART, I2C and
SPI peripherals. A board part's `BoardSpec` names the
MCU kind and maps header pins (`13`, `A0`, `GPIO2`) to MCU pin ids (`PB5`, `PC0`, `GPIO2`).

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
  the device whose `selected()` is true. `reset()` rebuilds the CPU and peripherals but keeps
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
  | 0x3F800000–0x3FBFFFFF | | PSRAM | not emulated: Problem, then the core faults |
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
  addresses become `esp32-unimplemented-register` warnings ("read 0x3FF5A0B0 (EFUSE+0x0B0) =
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
  | Cache masks | IRAM0 and DROM0 cleared in DPORT_PRO_CACHE_CTRL1 (0x3FF00044) and DPORT_APP_CACHE_CTRL1 (0x3FF0005C). IDF also clears DRAM1 (PSRAM — not emulated) | `set_cache_and_start_app`, the two `DPORT_REG_CLR_BIT(DPORT_x_CACHE_CTRL1_REG, …)` |
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
  reported once (`esp32-floating-input`); `load` takes `esp32-bin` and direct-boots it, `reset`
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
  write in the high phase doesn't cancel that fall); a timer write restarts its periods (Arduino-ESP32 2.0.17's
  `analogWrite` re-runs `ledcSetup` on every call, so its changes restart the period, as on
  hardware). Outputs reach pads as matrix signals 71–86. *ADC1* (`soc/sens.ts`): a conversion
  samples the pad's NetState voltage, finishes (SAR1_SAMPLE_CYCLE + bits + 2)·SAR1_CLK_DIV cycles
  of the 8 MHz RTC clock later (5.75 µs at reset values — a model choice) and returns
  round(V / FS · (2^bits − 1)) with FS 1.1 / 1.5 / 2.2 / 3.3 V for 0 / 2.5 / 6 / 11 dB: an
  idealized linear ADC, so a pot across 3V3 sweeps 0–4095 (the real 11 dB curve saturates near
  3.1 V). The hardware output is inverted unless SAR1_DATA_INV is set; IDF sets it. ADC2 isn't
  modeled: its conversions read 0 with an `esp32-adc2-unsupported` Problem.

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

## Worker protocol

`apps/web/src/sim/protocol.ts` defines `ToSim` (UI → worker) and `FromSim` (worker → UI)
messages, versioned by `PROTOCOL_VERSION` (10). UI → worker: `hello`, `load` (a project plus
firmware images per board), `setFirmware` (one board's new image on the loaded bench: that
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
`env.ts` is the BenchEnv (catalog + the AVR and ESP32 factories) and records each MCU to
measure MHz. The worker fetches the ESP32 ROM once at startup from `/esp32-rom/esp32_rev0_rom.elf`
— served in development by a Vite plugin straight from `.cache/esp32-rom`, never copied
into the build — and holds incoming messages until that fetch settles, so a project restored at
startup sees the ROM; without it ESP32 boards report `esp32-rom-missing` and don't run.
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
enforces it). The editor snaps to the 0.1" (2.54 mm) grid, but the document stores mm.

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
worker when either changed, then runs at the chosen speed (0.1×, 1×, 10×, Max); any edit while
running reloads the bench and resumes (debounced 150 ms; time restarts at 0). Firmware bytes
live in IndexedDB by board id (`editor/firmware-store.ts`, session-only fallback, files over
4 MB refused); the document keeps only the `FirmwareRef`. A `.hex`/`.elf` dropped onto a board,
or chosen with the inspector's "Load firmware…", attaches it. Part states (from frames or the
frame ring) go through `sim/frame-dispatch.ts`: each updates only the views it names (a view
drawn later gets its part's latest state), straight onto the elements — never through Preact. While running, interactive
elements (pushbutton, potentiometer, slide switch) take the pointer and their own events
become part input. The serial monitor (`ui/SerialMonitor.tsx`) keeps the newest ~1 MB per
board (`ui/serial-buffer.ts`: lines split across chunks, UTF-8 streamed, simulated-time stamps)
and appends DOM nodes rather than re-rendering; autoscroll pauses while you read further up.
Examples: **Examples…** opens a gallery (`ui/ExamplesGallery.tsx`, a
modal dialog) of the entries in `examples/manifest.ts` — 60 circuits in nine categories (Basics,
Displays, Sensors, Motors, Sound, Environment, ESP32, Mega, Two boards; Environment has four: a
gas alarm whose fan clears the room, a PIR hallway light, a parking sensor with a car driving in,
a thermostat). Each names a committed fixture project and,
per board, the firmware its tests run and the sketch folder it was built from; the files load
through `import.meta.glob` patterns that list exactly the examples' files (projects, sketches and
.hex as text, ESP32 .bin as `?url` assets fetched on open), so nothing loads until asked and
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
The firmware isn't in a diagram.json: you drop it on the board as usual.

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
known limitation), so the location names file:line only. A .hex has no symbols: addresses
still work.

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
  characters). Steps apply at exactly their time, in file order.
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
  | `led <p> is lit\|dark at <t>` | brightness ≥ 0.3 (lit) / ≤ 0.05 (dark); never reported = dark | `brightness 0.91` |
  | `servo <p> angle is <deg> ±<deg> at <t>` | the horn's angle within the tolerance | `angle 45.2°` |
  | `lcd <p> row <n> is "<text>" at <t>` | row n (from 0) equals the text, trailing spaces ignored; display off = blank | `row 1 is "t=1"` |
  | `pixel <p>[<i>] is #rrggbb at <t>` | the pixel's 0xRRGGBB | `#38b748`, or the pixel count |
  | `digits <p> show "<text>" at <t>` | the digits (`sevenSegmentText` from @benchtop/parts: 0–9, '-', ' ' dark, '?' other) | `shows "1234"` |
  | `env <gas\|temperature\|humidity\|light\|sound> at <p> is <v> ±<tol> at <t>` (or `>`, `<`, `>=`, `<=` `<v>`) | the room's value at a part placed in it (`bench.envSample`); a usage error without an environment part or on a part with no place in it | `gas 812.40 ppm` |

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
(`startGdbServer`) listens on 127.0.0.1 only, one client at a time (a second is closed at
once; a client's breakpoints go with it). `k` and `D` free the slot at once, not when the
socket's close event arrives, so gdb reconnecting right after `kill` is served (a race found
2026-10-20: the test's reconnect lost it under load). While continuing it runs the bench in 1 ms
simulated slices, paced in real time unless `--speed max`, yielding with `setImmediate`
between slices, so a 0x03 is answered within milliseconds (1.3 ms in the test). No avr-gdb
exists on the dev machine; a scripted RSP client over `node:net` is the test. Watchpoints,
target descriptions and multi-MCU threads aren't supported.

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
plain Node type stripping) does it on the same machine: `npm run bridge` listens on
127.0.0.1:5175 and the Vite dev server proxies `/api` to it; `npm start` builds the app and
serves it from the bridge on one origin (with the same cross-origin isolation headers).

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
