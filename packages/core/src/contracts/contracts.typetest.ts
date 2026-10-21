/**
 * Compile-time checks of the contracts: nothing here runs. The root tsconfig typechecks this
 * file (it sits under src/ and is not a *.test.ts), so a contract change that breaks these
 * shapes fails `npm run typecheck`. Nothing imports it.
 */

import type { I2cDevice } from './bus.ts';
import type { PartContext, PartDefinition, PartModel, PinHandle } from './part.ts';
import type { ProjectDoc } from './project.ts';
import { Strength, type NetState } from './signal.ts';

// Props are a type alias: an interface would not satisfy PartProps (no implicit index signature).
type ResistorProps = { ohms: number };

/** A resistor: two passive leads joined by one resistive link whose value follows the prop. */
export const resistor: PartDefinition<ResistorProps> = {
  type: 'resistor',
  title: 'Resistor',
  category: 'basic',
  size: { w: 10.16, h: 2.54 },
  pins: [
    { name: '1', x: 0, y: 1.27, role: 'passive' },
    { name: '2', x: 10.16, y: 1.27, role: 'passive' },
  ],
  links: [{ id: 'r', a: '1', b: '2', kind: 'resistive', ohms: 220 }],
  defaults: { ohms: 220 },
  createModel(ctx: PartContext, props: ResistorProps): PartModel {
    const link = ctx.link('r');
    link.setOhms(props.ohms);
    return {
      reset() {
        link.setOhms(props.ohms);
      },
    };
  },
};

/** A catalog holds definitions with widened props; a specific definition must fit there. */
export const catalog: ReadonlyMap<string, PartDefinition> = new Map<string, PartDefinition>([
  [resistor.type, resistor],
]);

/** A board: supply pins carry volts, a bus joins its GND pins, the pin map names MCU pins. */
export const board: PartDefinition = {
  type: 'test-board',
  title: 'Test board',
  category: 'boards',
  size: { w: 50, h: 30 },
  pins: [
    { name: '13', x: 10, y: 0, role: 'digital' },
    { name: '5V', x: 20, y: 30, role: 'power', volts: 5 },
    { name: 'GND.1', x: 30, y: 30, role: 'ground', volts: 0 },
    { name: 'GND.2', x: 40, y: 30, role: 'ground', volts: 0 },
  ],
  buses: [['GND.1', 'GND.2']],
  defaults: {},
  board: { mcu: 'atmega328p', pinMap: { '13': 'PB5' } },
};

type SensorProps = { bounce: boolean };

/** A model that measures pulses from pin listeners and talks I2C, using every context member. */
export const sensor: PartDefinition<SensorProps> = {
  type: 'test-sensor',
  title: 'Test sensor',
  category: 'sensors',
  size: { w: 10, h: 10 },
  pins: [
    { name: 'SIG', x: 0, y: 0, role: 'digital' },
    { name: 'SDA', x: 2.54, y: 0, role: 'digital' },
    { name: 'SCL', x: 5.08, y: 0, role: 'digital' },
    { name: '1', x: 0, y: 10, role: 'passive' },
    { name: '2', x: 10, y: 10, role: 'passive' },
  ],
  links: [{ id: 'sw', a: '1', b: '2', kind: 'switch', closed: false }],
  defaults: { bounce: false },
  createModel(ctx, props) {
    const sig: PinHandle = ctx.pin('SIG');
    const contact = ctx.link('sw');
    let riseAt = 0;
    let width = 0;
    let timer = 0;
    const settle = (): void => {
      sig.release();
    };
    sig.onChange((state: NetState) => {
      if (state.level === 1 && !state.conflict) riseAt = ctx.now();
      else if (state.level === 0) {
        width = ctx.now() - riseAt;
        ctx.invalidate();
      }
    });
    const device: I2cDevice = {
      address: 0x3c,
      start: (read) => !read,
      write: () => true,
      read: () => 0xff,
      stop: () => {},
    };
    ctx.attachI2c('SDA', 'SCL', device);
    return {
      input(event) {
        if (event.kind === 'press') {
          contact.setClosed(true);
          sig.drive(1, Strength.weak);
          if (props.bounce) timer = ctx.schedule(5_000, settle);
        } else if (event.kind === 'release') {
          contact.setClosed(false);
          ctx.cancel(timer);
          sig.driveVolts(0.4);
        } else {
          ctx.report({ severity: 'info', code: 'test-input', message: 'unexpected input', parts: [] });
        }
      },
      visual: () => ({ width, levels: [0, 1] }),
    };
  },
};

/** The minimal document shape the validator returns. */
export const doc: ProjectDoc = {
  format: 1,
  name: 'typetest',
  parts: [
    { id: 'uno', type: 'arduino-uno', x: 0, y: 0, rotation: 0, props: {} },
    { id: 'r1', type: 'resistor', x: 80, y: 10, rotation: 270, props: { ohms: 1000 } },
  ],
  wires: [{ id: 'w1', from: { part: 'uno', pin: '13' }, to: { part: 'r1', pin: '1' }, waypoints: [], color: 'green' }],
  firmware: { uno: { kind: 'sketch', path: '/tmp/blink', fqbn: 'arduino:avr:uno' } },
};
