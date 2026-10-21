/**
 * The examples gallery (BT38, editable since BT43): ready-to-run circuits built from the
 * committed fixtures. Each example names its project (fixtures/projects/) and, per board, the
 * firmware its tests run (fixtures/firmware/) and the sketch that firmware was built from
 * (fixtures/sketches/). Opening one loads the circuit, the precompiled firmware — it runs
 * without the compile bridge — and the sketch as the board's inline sketch (BT42), ready to edit
 * and Compile & Run. Everything loads on demand through the globs below, which list exactly the
 * examples' files (the bundler includes nothing else); `examples.test.ts` checks every entry
 * against them and the fixtures manifest, and `examples-run.test.ts` runs every example.
 * This module is the manifest alone (no app state); index.ts opens an example.
 */

import type { ProjectDoc } from '@benchtop/core';
import { CATALOG } from '@benchtop/parts';

export const CATEGORIES = ['Basics', 'Displays', 'Sensors', 'Motors', 'Sound', 'Environment', 'ESP32', 'Raspberry Pi Pico', 'Mega', 'Two boards'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ExampleBoard =
  | {
      /** Under fixtures/firmware/: uno/<name>.hex, nano/<name>.hex, mega/<name>.hex, esp32/<name>.bin or pico/<name>.uf2. */
      firmware: string;
      /** Under fixtures/sketches/: <board folder>/<name>, the firmware's source. */
      sketch: string;
    }
  | {
      /** BT63: fixtures/micropython/<name>/ — a MicroPython sketch (main.py and its modules), its own firmware. */
      micropython: string;
    };

/** The badge a board gets on its example's card: the board (from its firmware folder) or MicroPython. */
export function boardBadge(board: ExampleBoard): { label: string; kind: string } {
  if ('micropython' in board) return { label: 'MicroPython', kind: 'micropython' };
  const folder = board.firmware.split('/')[0];
  const label: Record<string, string> = { uno: 'Uno', nano: 'Nano', mega: 'Mega', esp32: 'ESP32', pico: 'Pico' };
  return { label: label[folder] ?? folder, kind: folder };
}

export interface Example {
  id: string;
  title: string;
  description: string;
  category: Category;
  /** fixtures/projects/<project>.json */
  project: string;
  /** Board part id → its firmware and sketch. */
  boards: Readonly<Record<string, ExampleBoard>>;
  /** BT59: fixtures/pcb/<pcb>.pcb.json, a PCB laid out for this example (opens with it). */
  pcb?: string;
}

const ex = (id: string, title: string, category: Category, project: string, boards: Record<string, ExampleBoard>, description: string): Example => ({
  id,
  title,
  description,
  category,
  project,
  boards,
});
/** One Uno running fixtures' uno/<name>. */
const uno = (name: string): Record<string, ExampleBoard> => ({ uno: { firmware: `uno/${name}.hex`, sketch: `uno/${name}` } });
/** One Mega (part id `mega`) running fixtures' mega/<name>. */
const mega = (name: string): Record<string, ExampleBoard> => ({ mega: { firmware: `mega/${name}.hex`, sketch: `mega/${name}` } });
/** One DevKit (part id `esp`) running fixtures' esp32/<name>. */
const esp = (name: string): Record<string, ExampleBoard> => ({ esp: { firmware: `esp32/${name}.bin`, sketch: `esp32/${name}` } });
/** One Raspberry Pi Pico (part id `pico`) running fixtures' pico/<name>. */
const pico = (name: string): Record<string, ExampleBoard> => ({ pico: { firmware: `pico/${name}.uf2`, sketch: `pico/${name}` } });

export const EXAMPLES: readonly Example[] = [
  { ...ex('blink', 'Blink', 'Basics', 'blink-led', uno('blink'), 'The classic: an LED on D13 (through 220 Ω on a breadboard) blinks once a second. It has a PCB too: an Uno shield — switch to PCB in the toolbar.'), pcb: 'blink' },
  ex('button', 'Button', 'Basics', 'button-pullup', uno('button-pullup'), 'A pushbutton from D2 to GND with the internal pull-up lights the LED on D13 while held.'),
  ex('fade', 'Fade', 'Basics', 'pwm-fade', uno('pwm-fade'), 'analogWrite on D9 ramps an LED up and down with PWM.'),
  ex('traffic-light', 'Traffic light', 'Basics', 'traffic-light', uno('traffic-light'), 'Red, red + yellow, green, yellow — a traffic light on D10, D9 and D8, cycling every 2 s.'),
  ex('simon', 'Simon game', 'Basics', 'simon', uno('simon'), 'Four buttons, four LEDs and a buzzer: repeat the growing sequence. Run it and press the buttons.'),
  ex('serial-echo', 'Serial echo', 'Basics', 'debug-demo', uno('serial-echo'), 'Type in the serial monitor (9600 baud): the Uno sends every byte straight back.'),
  ex('potentiometer', 'Potentiometer', 'Basics', 'analog-pot', uno('analog-read'), 'analogRead(A0) of a potentiometer printed ten times a second — turn the knob.'),
  ex(
    'nano-analog',
    'Nano on a breadboard',
    'Basics',
    'nano-analog',
    { nano: { firmware: 'nano/analog-a6.hex', sketch: 'nano/analog-a6' } },
    'An Arduino Nano straddles a breadboard and reads two potentiometers on A6 and A7 — analog-only pins the Uno lacks. Turn the knobs; watch Serial or the Plotter.',
  ),
  ex('logic-analyzer', 'Logic analyzer demo', 'Basics', 'logic-demo', uno('logic-demo'), 'SoftwareSerial on D3, PWM on D9 and a 1 kHz square wave on D7: probe them with the Probe tool.'),
  ex('lcd1602', 'LCD 16×2', 'Displays', 'lcd-4bit', uno('lcd-4bit'), 'LiquidCrystal in 4-bit mode: "Hello, Benchtop!" and a seconds counter.'),
  ex('lcd-i2c', 'LCD 16×2 over I2C', 'Displays', 'lcd-i2c', uno('lcd-i2c'), 'The same text through a PCF8574 backpack at 0x27; the backlight goes off at 1.5 s.'),
  ex('lcd-thermometer', 'LCD thermometer', 'Displays', 'lcd-thermometer', uno('lcd-thermometer'), 'A DHT22 read every 2 s, temperature and humidity on an I2C LCD — change them with its sliders.'),
  ex('oled', 'OLED (SSD1306)', 'Displays', 'ssd1306-adafruit', uno('ssd1306-adafruit'), 'Adafruit_SSD1306 draws a border, text and a circle on a 128×64 I2C OLED.'),
  ex('oled-clock', 'OLED clock', 'Displays', 'oled-clock', uno('oled-clock'), 'A DS1307 real-time clock shown large on an SSD1306 OLED, and printed every second.'),
  ex('tft', 'Color TFT (ILI9341)', 'Displays', 'tft-demo', uno('tft-demo'), 'A 240×320 ILI9341 on hardware SPI, driven by a small driver in the sketch itself: colored boxes, a title, and a counter that redraws only its digit.'),
  ex('seven-segment', '7-segment display', 'Displays', 'seven-seg-mux', uno('seven-seg-mux'), 'A 4-digit display multiplexed at ~120 Hz shows "1234".'),
  ex('bargraph', 'LED bar graph', 'Displays', 'bargraph', uno('bargraph'), 'Ten LEDs on D11…D2, six of them lit.'),
  ex('neopixel', 'NeoPixel strip and ring', 'Displays', 'neopixel', uno('neopixel'), '24 WS2812 pixels — a strip chained into a ring — bit-banged from D6.'),
  ex('dht22', 'Temperature and humidity (DHT22)', 'Sensors', 'dht22', uno('dht22-adafruit'), "Adafruit's DHT library reads a DHT22 every 2.1 s — change its sliders."),
  ex('hc-sr04', 'Ultrasonic distance (HC-SR04)', 'Sensors', 'hcsr04', uno('hcsr04'), 'pulseIn times the echo and prints the distance in cm, ten times a second.'),
  ex('distance-meter', 'Distance meter', 'Sensors', 'distance-meter', uno('distance-meter'), 'An HC-SR04 measured five times a second, the distance in cm on a 4-digit 7-segment display.'),
  ex('ds1307', 'Real-time clock (DS1307)', 'Sensors', 'ds1307', uno('ds1307'), 'Sets the clock to just before midnight and prints the time every second.'),
  ex('mpu6050', 'Accelerometer (MPU-6050)', 'Sensors', 'mpu6050', uno('mpu6050'), 'Raw I2C reads of acceleration, temperature and rotation.'),
  ex('ir-remote', 'IR remote', 'Sensors', 'ir-remote', uno('ir-decode'), 'Press the remote’s keys while it runs: an IR receiver on D2 turns them into NEC frames, and a small decoder in the sketch prints each key (and "repeat" while you hold one).'),
  ex('scale', 'Kitchen scale (HX711)', 'Sensors', 'scale', uno('scale'), 'A load cell through an HX711, read by a shift-in in the sketch: it tares at start, then prints grams twice a second — set the weight in the Inspector.'),
  ex('flame-alarm', 'Flame alarm', 'Sensors', 'flame-alarm', uno('flame-alarm'), 'A flame sensor module: raise the infrared in the Inspector past the trimmer’s threshold and the buzzer sounds; the sketch prints each change with the analog reading.'),
  ex('gas-meter', 'Gas meter (MQ-2)', 'Sensors', 'gas-meter', uno('gas-meter'), 'An MQ-2 module prints its analog reading four times a second and raises an alarm past the threshold — set the gas concentration in ppm in the Inspector.'),
  ex('keypad', 'Keypad 4×4', 'Sensors', 'keypad', uno('keypad-scan'), 'A matrix keypad scanned row by row; each key press is printed.'),
  ex('encoder', 'Rotary encoder (KY-040)', 'Sensors', 'encoder', uno('encoder-count'), 'Counts detents up and down and reports shaft presses.'),
  ex('servo', 'Servo sweep', 'Motors', 'servo-sweep', uno('servo-sweep'), 'Servo.h sweeps a servo from 0° to 180° and back in 5° steps.'),
  ex('servo-knob', 'Servo knob', 'Motors', 'servo-knob', uno('servo-knob'), 'A potentiometer steers a servo: turn the knob in the Inspector while it runs.'),
  ex('keypad-lock', 'Keypad lock', 'Motors', 'keypad-lock', uno('keypad-lock'), 'Type 1 2 3 4 # on the keypad: the servo latch opens for 3 s; a wrong code beeps.'),
  ex('stepper', 'Stepper (28BYJ-48)', 'Motors', 'stepper-28byj48', uno('stepper-28byj48'), 'Stepper.h turns a 28BYJ-48 on a ULN2003 driver a quarter turn at a time.'),
  ex('a4988-stepper', 'A4988 stepper driver', 'Motors', 'a4988-stepper', uno('a4988-stepper'), 'An A4988 on STEP/DIR turns a bipolar stepper one turn in full steps, then one turn back in sixteenth steps — watch the shaft move in fine increments.'),
  ex('relay', 'Relay', 'Motors', 'relay', uno('relay'), 'D7 switches a relay coil every 500 ms; its contact lights an LED.'),
  // BT56: the environment — a room around the bench whose sources the sensors read.
  ex('gas-fan', 'Gas alarm with a fan', 'Environment', 'env-gas-fan', uno('gas-fan'), 'A gas leak opens near an MQ-2: past the alarm level the buzzer sounds and an extractor fan on D7 runs until the air is clean again. Switch the leak in the Inspector; the heatmap shows the gas spreading.'),
  ex('pir-hallway', 'PIR hallway light', 'Environment', 'env-pir-hallway', uno('pir-hallway'), 'A person walks down a hallway past a PIR sensor: the lamp on D8 lights while they are in view and goes off a second after they leave.'),
  ex('parking-sensor', 'Parking sensor', 'Environment', 'env-parking', uno('parking'), 'A car drives toward an HC-SR04: the beeps come faster as it closes in, and a steady tone says STOP below 30 cm.'),
  ex('thermostat', 'Thermostat', 'Environment', 'env-thermostat', uno('thermostat'), 'An NTC reads the room and D7 switches a heater to hold 25 °C with half a degree of hysteresis; the heatmap shows the warm air.'),
  ex('buzzer', 'Buzzers', 'Sound', 'buzzer', uno('buzzer'), 'tone() plays 440 Hz then 880 Hz on a passive buzzer; an active one beeps after. Unmute to hear them.'),
  ex('speaker-melody', 'Speaker melody', 'Sound', 'speaker-melody', uno('speaker-melody'), 'tone() plays three notes on a speaker on D8 — through your computer’s speakers once you unmute.'),
  ex('pcm-playback', 'PCM through PWM', 'Sound', 'pcm-playback', uno('pcm-playback'), 'A 1 kHz sine as 8 kHz samples in Timer2’s 62.5 kHz PWM on D3; the speaker filters the carrier away.'),
  ex('mic-level', 'Microphone pitch', 'Sound', 'mic-level', uno('mic-level'), 'A microphone on A0; the sketch prints the pitch it hears every 500 ms. Run, select the mic, click “Use microphone” and whistle.'),
  ex('vu-meter', 'VU meter', 'Sound', 'vu-meter', uno('vu-meter'), 'A microphone and a 10-LED bar graph: the louder it hears, the more bars light. Try “Use microphone”.'),
  ex('esp32-blink', 'ESP32 blink', 'ESP32', 'esp32-blink', esp('blink'), 'An ESP32 DevKit V1 blinks an LED on D2 (and its onboard LED) through FreeRTOS.'),
  ex('esp32-serial-hello', 'ESP32 serial hello', 'ESP32', 'esp32-serial', esp('serial-hello'), 'A full dual-core boot on the real ROM, then "hello from esp32" at 115200 baud.'),
  ex('esp32-button', 'ESP32 button', 'ESP32', 'esp32-button', esp('gpio-input'), 'A button on D4 with INPUT_PULLUP lights the LED on D2 while held.'),
  ex('esp32-pwm-fader', 'ESP32 PWM fader', 'ESP32', 'esp32-pwm-fader', esp('pwm-fader'), 'A potentiometer on GPIO34 (ADC1) sets an LED’s brightness through LEDC PWM.'),
  ex('esp32-neopixel', 'ESP32 NeoPixel', 'ESP32', 'esp32-neopixel', esp('neopixel'), 'neopixelWrite through the RMT peripheral: red, green, blue, dim white.'),
  ex('esp32-rainbow-ring', 'ESP32 rainbow ring', 'ESP32', 'esp32-rainbow-ring', esp('rainbow-ring'), 'A turning rainbow on a 16-pixel NeoPixel ring, sent bit by bit through the RMT peripheral.'),
  ex('esp32-oled-clock', 'ESP32 OLED clock', 'ESP32', 'esp32-oled-clock', esp('oled-clock'), 'A DS1307 and an SSD1306 on the ESP32’s I2C: the time large on the OLED.'),
  ex('esp32-tft', 'ESP32 color TFT', 'ESP32', 'esp32-tft-demo', esp('tft-demo'), 'The same ILI9341 picture over the ESP32’s VSPI bus (SCK 18, MOSI 23), with CS on D5 and D/C on D4.'),
  ex('esp32-dac-sine', 'ESP32 DAC sine', 'ESP32', 'esp32-dac-sine', esp('dac-sine'), 'dacWrite on GPIO25 steps a 500 Hz sine into a speaker (unmute to hear it).'),
  ex('esp32-mic-level', 'ESP32 microphone pitch', 'ESP32', 'esp32-mic-level', esp('mic-level'), 'A microphone on GPIO34 (ADC1); the sketch prints the pitch it hears every 500 ms.'),
  ex('esp32-i2c-scan', 'ESP32 I2C scan', 'ESP32', 'esp32-i2c', esp('i2c-scan'), 'Wire scans the bus and finds the OLED (0x3C) and the clock (0x68).'),
  ex('pico-blink', 'Pico blink', 'Raspberry Pi Pico', 'pico-blink', pico('blink'), 'The Raspberry Pi Pico on its own: the onboard LED (GP25) blinks every half second.'),
  ex('pico-potentiometer', 'Pico potentiometer', 'Raspberry Pi Pico', 'pico-analog-read', pico('analog-read'), 'analogRead of a potentiometer on GP26 (ADC0) at 12 bits, printed ten times a second on USB serial — turn the knob.'),
  ex('pico-fade', 'Pico PWM steps', 'Raspberry Pi Pico', 'pico-pwm-fade', pico('pwm-fade'), 'analogWrite on GP15 at 1 kHz: an LED steps through 0, 25, 50, 75 and 100 % duty, 200 ms each.'),
  ex('pico-oled', 'Pico OLED', 'Raspberry Pi Pico', 'pico-i2c-oled', pico('i2c-oled'), 'Adafruit SSD1306 over Wire on GP4 (SDA) and GP5 (SCL): a box, "PICO" and a seconds counter.'),
  ex('pico-tft', 'Pico color TFT', 'Raspberry Pi Pico', 'pico-spi-tft', pico('spi-tft'), 'The ILI9341 picture over SPI0 (SCK GP18, MOSI GP19), with CS on GP17 and D/C on GP20, then a digit counter.'),
  ex('pico-neopixel', 'Pico NeoPixel', 'Raspberry Pi Pico', 'pico-neopixel', pico('neopixel'), 'Eight WS2812 pixels on GP2 driven by a PIO program, not bit-banging: pixel 0 steps red, green, blue every half second.'),
  ex('pico-micropython-blink', 'MicroPython blink', 'Raspberry Pi Pico', 'pico-blink', { pico: { micropython: 'blink' } }, 'MicroPython on the Pico: main.py toggles the LED every 250 ms and prints the count. Edit it in the Code tab and press Run — nothing to compile.'),
  ex('pico-micropython-neopixel', 'MicroPython NeoPixel', 'Raspberry Pi Pico', 'pico-neopixel', { pico: { micropython: 'neopixel' } }, "MicroPython's neopixel module drives the WS2812 strip on GP2: pixel 0 steps red, green, blue every half second."),
  ex('pico-pio-square', 'Pico PIO square wave', 'Raspberry Pi Pico', 'pico-pio-square', pico('pio-square'), 'A two-instruction PIO program toggles GP3 at exactly 10 kHz while the CPU sleeps: probe GP3 with the Probe tool.'),
  ex('mega-chaser', 'Mega LED chaser', 'Mega', 'mega-chaser', mega('chaser'), 'Ten LEDs on the Mega’s odd pins D23–D41 light one after another, there and back — one shared resistor, since one LED is lit at a time.'),
  ex('mega-serial-ports', 'Mega serial ports', 'Mega', 'mega-serial-ports', mega('serial-ports'), 'The Mega has four UARTs: Serial1–3 are each wired back to themselves (TX→RX), and Serial reports what every port heard.'),
  ex('mega-analog', 'Mega analog scanner', 'Mega', 'mega-analog', mega('analog-hi'), 'All 16 analog inputs read ten times a second; four potentiometers on A0, A5, A8 and A15 — turn them, or watch the Plotter.'),
  ex(
    'uart-chat',
    'Uno ↔ ESP32 chat',
    'Two boards',
    'uart-chat',
    { uno: { firmware: 'uno/uart-chat.hex', sketch: 'uno/uart-chat' }, esp: { firmware: 'esp32/uart-chat.bin', sketch: 'esp32/uart-chat' } },
    'The Uno sends "ping n" through a 5 V → 3.3 V divider; the ESP32 answers "pong n" on its TX2; both serial monitors show the chat.',
  ),
  ex(
    'uart-relay',
    'Uno → ESP32 relay',
    'Two boards',
    'uno-esp32-uart-divider',
    { uno: { firmware: 'uno/uart-ping.hex', sketch: 'uno/uart-ping' }, esp: { firmware: 'esp32/uart-relay.bin', sketch: 'esp32/uart-relay' } },
    'The Uno pings ten times a second; the ESP32 copies what its Serial2 hears to its own serial monitor.',
  ),
];

// The examples' files, by repo-relative path. Literal patterns (the bundler needs them):
// projects and sketches as text, AVR firmware (Uno, Nano, Mega) as text, ESP32 images and Pico
// UF2s as asset URLs.
const PROJECTS = import.meta.glob(
  '../../../../fixtures/projects/{blink-led,button-pullup,pwm-fade,traffic-light,simon,debug-demo,analog-pot,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22,hcsr04,distance-meter,ds1307,mpu6050,keypad,encoder,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,esp32-blink,esp32-serial,esp32-button,esp32-pwm-fader,esp32-neopixel,esp32-rainbow-ring,esp32-oled-clock,esp32-dac-sine,esp32-mic-level,esp32-i2c,uart-chat,uno-esp32-uart-divider,nano-analog,mega-chaser,mega-serial-ports,mega-analog,tft-demo,esp32-tft-demo,ir-remote,scale,flame-alarm,gas-meter,a4988-stepper,env-gas-fan,env-pir-hallway,env-parking,env-thermostat,pico-blink,pico-analog-read,pico-pwm-fade,pico-i2c-oled,pico-spi-tft,pico-neopixel,pico-pio-square}.json',
  { import: 'default' },
) as Record<string, () => Promise<unknown>>;
const HEX = import.meta.glob(
  [
    '../../../../fixtures/firmware/uno/{blink,button-pullup,pwm-fade,traffic-light,simon,serial-echo,analog-read,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22-adafruit,hcsr04,distance-meter,ds1307,mpu6050,keypad-scan,encoder-count,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,uart-chat,uart-ping,tft-demo,ir-decode,scale,flame-alarm,gas-meter,a4988-stepper,gas-fan,pir-hallway,parking,thermostat}.hex',
    '../../../../fixtures/firmware/nano/analog-a6.hex',
    '../../../../fixtures/firmware/mega/{chaser,serial-ports,analog-hi}.hex',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;
const BIN = import.meta.glob(
  [
    '../../../../fixtures/firmware/esp32/{blink,serial-hello,gpio-input,pwm-fader,neopixel,rainbow-ring,oled-clock,dac-sine,mic-level,i2c-scan,uart-chat,uart-relay,tft-demo}.bin',
    '../../../../fixtures/firmware/pico/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,pio-square}.uf2',
  ],
  { query: '?url', import: 'default' },
) as Record<string, () => Promise<string>>;
const SKETCHES = import.meta.glob(
  [
    '../../../../fixtures/sketches/uno/{blink,button-pullup,pwm-fade,traffic-light,simon,serial-echo,analog-read,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22-adafruit,hcsr04,distance-meter,ds1307,mpu6050,keypad-scan,encoder-count,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,uart-chat,uart-ping,tft-demo,ir-decode,scale,flame-alarm,gas-meter,a4988-stepper,gas-fan,pir-hallway,parking,thermostat}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/nano/analog-a6/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/mega/{chaser,serial-ports,analog-hi}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/esp32/{blink,serial-hello,gpio-input,pwm-fader,neopixel,rainbow-ring,oled-clock,dac-sine,mic-level,i2c-scan,uart-chat,uart-relay,tft-demo}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/pico/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,pio-square}/*.{ino,h,hpp,c,cpp}',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;

/** BT63: the MicroPython examples' sketches (each folder's .py files). */
const MICROPYTHON = import.meta.glob('../../../../fixtures/micropython/{blink,neopixel}/*.py', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const ROOT = '../../../../fixtures/';

/** The example's project document (unparsed). */
const PCBS = import.meta.glob('../../../../fixtures/pcb/blink.pcb.json', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

/** An example's PCB layout as text (BT59), or undefined when it has none. */
export function loadPcb(example: Example): Promise<string> | undefined {
  if (example.pcb === undefined) return undefined;
  const load = PCBS[`${ROOT}pcb/${example.pcb}.pcb.json`];
  return load === undefined ? Promise.reject(new Error(`no PCB ${example.pcb}`)) : load();
}

export function loadProject(example: Example): Promise<unknown> {
  const load = PROJECTS[`${ROOT}projects/${example.project}.json`];
  if (load === undefined) return Promise.reject(new Error(`no project ${example.project}`));
  return load();
}

/** A board's precompiled firmware bytes (a .hex as its text's bytes). */
export async function loadFirmware(board: { firmware: string }): Promise<Uint8Array> {
  const path = `${ROOT}firmware/${board.firmware}`;
  const hex = HEX[path];
  if (hex !== undefined) return new TextEncoder().encode(await hex());
  const bin = BIN[path];
  if (bin === undefined) throw new Error(`no firmware ${board.firmware}`);
  const response = await fetch(await bin());
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A MicroPython example's sketch (BT63): every .py of fixtures/micropython/<name>/, main.py first among them. */
export async function loadMicroPython(name: string): Promise<{ files: Record<string, string>; main: string }> {
  const prefix = `${ROOT}micropython/${name}/`;
  const entries = Object.entries(MICROPYTHON).filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'));
  const files: Record<string, string> = {};
  for (const [path, load] of entries) files[path.slice(prefix.length)] = await load();
  if (!Object.hasOwn(files, 'main.py')) throw new Error(`micropython/${name} has no main.py`);
  return { files, main: 'main.py' };
}

/** A board's sketch: every source file of its folder by name, and the main .ino. */
export async function loadSketch(board: { sketch: string }): Promise<{ files: Record<string, string>; main: string }> {
  const prefix = `${ROOT}sketches/${board.sketch}/`;
  const entries = Object.entries(SKETCHES).filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'));
  if (entries.length === 0) throw new Error(`no sketch ${board.sketch}`);
  const files: Record<string, string> = {};
  for (const [path, load] of entries) files[path.slice(prefix.length)] = await load();
  const main = `${board.sketch.split('/').pop()}.ino`;
  if (!Object.hasOwn(files, main)) throw new Error(`${board.sketch} has no ${main}`);
  return { files, main };
}

/** The document's first board (where a one-board example's firmware goes). */
export function boardOf(doc: ProjectDoc): string | undefined {
  return doc.parts.find((p) => CATALOG.get(p.type)?.board !== undefined)?.id;
}
