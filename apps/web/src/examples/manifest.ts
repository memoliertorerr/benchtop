/**
 * The examples gallery (BT38, editable since BT43): ready-to-run circuits built from the
 * committed fixtures, listed in fixtures/examples.json (BT69: one list for the gallery and the
 * CLI's MCP server). Each example names its project (fixtures/projects/) and, per board, the
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
import examplesJson from '../../../../fixtures/examples.json';

export const CATEGORIES = ['Basics', 'Displays', 'Sensors', 'Motors', 'Sound', 'Power', 'Environment', 'ESP32', 'Raspberry Pi Pico', 'Raspberry Pi Pico 2', 'Mega', 'Two boards'] as const;
export type Category = (typeof CATEGORIES)[number];

export type ExampleBoard =
  | {
      /** Under fixtures/firmware/: uno/<name>.hex, nano/<name>.hex, mega/<name>.hex, esp32/<name>.bin, pico/<name>.uf2 or pico2/<name>.uf2. */
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
  const label: Record<string, string> = { uno: 'Uno', nano: 'Nano', mega: 'Mega', esp32: 'ESP32', pico: 'Pico', pico2: 'Pico 2' };
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

/** An entry of fixtures/examples.json, checked (the file is the list; the CLI's MCP server reads it too, BT69). */
function parseExample(raw: unknown, i: number): Example {
  const e = raw as Record<string, unknown>;
  const where = `fixtures/examples.json[${i}]`;
  const text = (key: string): string => {
    if (typeof e[key] !== 'string' || e[key] === '') throw new Error(`${where}.${key} must be a non-empty string`);
    return e[key];
  };
  const category = text('category') as Category;
  if (!CATEGORIES.includes(category)) throw new Error(`${where}.category ${category} is not a gallery category`);
  const boards: Record<string, ExampleBoard> = {};
  for (const [board, value] of Object.entries((e.boards ?? {}) as Record<string, Record<string, unknown>>)) {
    if (typeof value.micropython === 'string') boards[board] = { micropython: value.micropython };
    else if (typeof value.firmware === 'string' && typeof value.sketch === 'string') boards[board] = { firmware: value.firmware, sketch: value.sketch };
    else throw new Error(`${where}.boards.${board} needs firmware and sketch, or micropython`);
  }
  return { id: text('id'), title: text('title'), description: text('description'), category, project: text('project'), boards, ...(typeof e.pcb === 'string' ? { pcb: e.pcb } : {}) };
}

export const EXAMPLES: readonly Example[] = (examplesJson as unknown[]).map(parseExample);

// The examples' files, by repo-relative path. Literal patterns (the bundler needs them):
// projects and sketches as text, AVR firmware (Uno, Nano, Mega) as text, ESP32 images and Pico
// and Pico 2 UF2s as asset URLs.
const PROJECTS = import.meta.glob(
  '../../../../fixtures/projects/{regulator-meter,blink-led,button-pullup,pwm-fade,traffic-light,simon,debug-demo,analog-pot,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22,hcsr04,distance-meter,ds1307,mpu6050,keypad,encoder,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,esp32-blink,esp32-serial,esp32-button,esp32-pwm-fader,esp32-neopixel,esp32-rainbow-ring,esp32-oled-clock,esp32-dac-sine,esp32-mic-level,esp32-i2c,uart-chat,uno-esp32-uart-divider,nano-analog,mega-chaser,mega-serial-ports,mega-analog,tft-demo,esp32-tft-demo,ir-remote,scale,flame-alarm,gas-meter,a4988-stepper,env-gas-fan,env-pir-hallway,env-parking,env-thermostat,pico-blink,pico-analog-read,pico-pwm-fade,pico-i2c-oled,pico-spi-tft,pico-neopixel,pico-pio-square,pico-multicore,pico2-blink,pico2-analog-read,pico2-pwm-fade,pico2-i2c-oled,pico2-spi-tft,pico2-neopixel,pico2-button-irq}.json',
  { import: 'default' },
) as Record<string, () => Promise<unknown>>;
const HEX = import.meta.glob(
  [
    '../../../../fixtures/firmware/uno/{regulator-meter,blink,button-pullup,pwm-fade,traffic-light,simon,serial-echo,analog-read,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22-adafruit,hcsr04,distance-meter,ds1307,mpu6050,keypad-scan,encoder-count,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,uart-chat,uart-ping,tft-demo,ir-decode,scale,flame-alarm,gas-meter,a4988-stepper,gas-fan,pir-hallway,parking,thermostat}.hex',
    '../../../../fixtures/firmware/nano/analog-a6.hex',
    '../../../../fixtures/firmware/mega/{chaser,serial-ports,analog-hi}.hex',
  ],
  { query: '?raw', import: 'default' },
) as Record<string, () => Promise<string>>;
const BIN = import.meta.glob(
  [
    '../../../../fixtures/firmware/esp32/{blink,serial-hello,gpio-input,pwm-fader,neopixel,rainbow-ring,oled-clock,dac-sine,mic-level,i2c-scan,uart-chat,uart-relay,tft-demo}.bin',
    '../../../../fixtures/firmware/pico/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,pio-square,multicore}.uf2',
    '../../../../fixtures/firmware/pico2/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,button-irq}.uf2',
  ],
  { query: '?url', import: 'default' },
) as Record<string, () => Promise<string>>;
const SKETCHES = import.meta.glob(
  [
    '../../../../fixtures/sketches/uno/{regulator-meter,blink,button-pullup,pwm-fade,traffic-light,simon,serial-echo,analog-read,logic-demo,lcd-4bit,lcd-i2c,lcd-thermometer,ssd1306-adafruit,oled-clock,seven-seg-mux,bargraph,neopixel,dht22-adafruit,hcsr04,distance-meter,ds1307,mpu6050,keypad-scan,encoder-count,servo-sweep,servo-knob,keypad-lock,stepper-28byj48,relay,buzzer,speaker-melody,pcm-playback,mic-level,vu-meter,uart-chat,uart-ping,tft-demo,ir-decode,scale,flame-alarm,gas-meter,a4988-stepper,gas-fan,pir-hallway,parking,thermostat}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/nano/analog-a6/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/mega/{chaser,serial-ports,analog-hi}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/esp32/{blink,serial-hello,gpio-input,pwm-fader,neopixel,rainbow-ring,oled-clock,dac-sine,mic-level,i2c-scan,uart-chat,uart-relay,tft-demo}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/pico/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,pio-square,multicore}/*.{ino,h,hpp,c,cpp}',
    '../../../../fixtures/sketches/pico2/{blink,analog-read,pwm-fade,i2c-oled,spi-tft,neopixel,button-irq}/*.{ino,h,hpp,c,cpp}',
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
