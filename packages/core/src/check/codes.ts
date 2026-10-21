/**
 * Every problem code in use, with a short title and a hint for the Problems panel. Problems
 * themselves carry the specific message; this is the shared explanation.
 */

export interface ProblemCodeInfo {
  title: string;
  hint: string;
}

export const PROBLEM_CODES: Readonly<Record<string, ProblemCodeInfo>> = {
  short: { title: 'Short circuit', hint: 'Two outputs drive one net to opposite levels. Remove one of the connections.' },
  'drive-fight': {
    title: 'Output driven into a supply',
    hint: 'A pin set as OUTPUT is wired straight to 5V or GND; at the opposite level it would sink or source far too much current.',
  },
  oscillation: { title: 'Oscillation', hint: 'A zero-delay feedback loop between parts never settled.' },
  'floating-input': {
    title: 'Floating input',
    hint: 'An INPUT pin with nothing driving it reads noise on real hardware. Use INPUT_PULLUP or add a 10 kΩ pull-up/pull-down.',
  },
  'esp32-overvoltage': {
    title: '5 V on an ESP32 pin',
    hint: 'ESP32 GPIOs take at most 3.6 V. Use a level shifter or a voltage divider.',
  },
  'unpowered-part': { title: 'Part without power', hint: "Wire the part's power (VCC/VDD) and ground (GND/VSS) pins." },
  'unconnected-pins': { title: 'Unconnected pins', hint: 'Fine if the sketch never uses them.' },
  'unwired-part': { title: 'Unwired part', hint: 'The part has no connections yet.' },
  'led-overcurrent': {
    title: 'LED current too high',
    hint: 'An LED needs a series resistor (220 Ω–1 kΩ at 5 V); without one it would burn out the LED or the pin.',
  },
  'pin-overcurrent': {
    title: 'Pin current too high',
    hint: 'An MCU pin sources or sinks more than its 40 mA maximum. Add series resistors, or drive the load through a transistor or driver chip.',
  },
  'port-overcurrent': {
    title: 'Pin group current too high',
    hint: "AVR pins share supply pins in groups, and a group may source or sink less than the sum of its pins' 40 mA (Uno: 150 mA out, 100 mA in). Spread the loads over other groups, raise the resistors, or use a driver chip.",
  },
  'analog-island-too-large': { title: 'Network too large to solve', hint: 'A resistive network has more than 256 nets; it keeps digital (switch-level) values.' },
  'analog-no-convergence': { title: 'Diodes did not settle', hint: 'The LED states in a network kept flipping; voltages there may be off.' },
  'analog-undefined-level': {
    title: 'Input between 0 and 1',
    hint: 'A digital input sees a voltage between the thresholds (0.3–0.6 × Vcc); real chips read it unpredictably.',
  },
  'i2c-address-conflict': { title: 'I2C address conflict', hint: 'Two devices on one bus answer at the same address; change one (address pins or prop).' },
  'i2c-unattached': { title: 'I2C device not on a bus', hint: "Wire the device's SDA/SCL to the board's SDA/SCL (A4/A5 on an Uno)." },
  'uart-baud-mismatch': {
    title: 'UART baud rates differ',
    hint: 'The two boards on this serial line use different speeds; set both to the same baud rate (Serial.begin).',
  },
  'spi-unattached': { title: 'SPI device not on a bus', hint: "Wire SCK/MOSI/MISO to the board's SPI pins (13/11/12 on an Uno)." },
  'neopixel-timing': { title: 'NeoPixel timing errors', hint: 'Some WS2812 bits had high times outside 0.2–1.0 µs; check the driver code or library.' },
  'stepper-sequence': { title: 'Stepper coil order', hint: 'The coils are energized out of order; check the wiring order against the library.' },
  'unknown-part-type': { title: 'Unknown part', hint: 'This version of Benchtop has no part of that type.' },
  'unresolved-wire': { title: 'Wire to a missing pin', hint: 'Re-attach the wire or delete it.' },
  'bad-part-definition': { title: 'Broken part definition', hint: 'A bug in the part catalog; please report it.' },
  'part-model-error': { title: 'Part failed to start', hint: 'Usually an invalid property value; check the part in the Inspector.' },
  'mcu-unavailable': { title: 'Board not simulated', hint: 'This board type has no MCU emulator yet.' },
  'mcu-fault': { title: 'MCU crashed', hint: 'The firmware did something the emulator could not run.' },
  'mcu-halted': { title: 'MCU stopped', hint: 'The firmware halted (sleep forever, or nothing loaded).' },
  'mcu-breakpoint': { title: 'Breakpoint', hint: 'The debugger stopped the MCU.' },
  'timer-storm': { title: 'Timer storm', hint: 'Part timers kept firing without time advancing; the run was cut short.' },
  'environment-duplicate': { title: 'More than one environment', hint: 'A bench has one room: delete the extra environment parts (only the first is used).' },
};
