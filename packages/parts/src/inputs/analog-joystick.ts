/**
 * Analog joystick: two 10 kΩ pots as resistive links, so unloaded HORZ = V·(x+1)/2 and
 * VERT = V·(y+1)/2 (decided: right and up read high; joystickVolts in shared/transfer.ts);
 * channels x and y in −1..1 through the channel-input convention; SEL is a switch to GND while
 * pressed (the sketch needs INPUT_PULLUP). Pins from @wokwi/elements 1.9.2
 * analog-joystick-element.
 */

import { definePart } from '../define.ts';
import { readChannelInput } from '../shared/channel-input.ts';
import { Divider } from '../shared/divider.ts';

const AXIS_OHMS = 10_000;

const clampAxis = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

export const analogJoystick = definePart({
  type: 'analog-joystick',
  title: 'Analog joystick',
  category: 'input',
  size: { w: 27.2, h: 31.8 },
  pins: [
    { name: 'VCC', x: 8.731, y: 30.639, role: 'power' },
    { name: 'VERT', x: 11.272, y: 30.639, role: 'analog' },
    { name: 'HORZ', x: 13.812, y: 30.639, role: 'analog' },
    { name: 'SEL', x: 16.352, y: 30.639, role: 'digital' },
    { name: 'GND', x: 18.893, y: 30.639, role: 'ground' },
  ],
  links: [
    { id: 'sel', a: 'SEL', b: 'GND', kind: 'switch', closed: false },
    { id: 'horz-top', a: 'VCC', b: 'HORZ', kind: 'resistive', ohms: AXIS_OHMS / 2 },
    { id: 'horz-bottom', a: 'HORZ', b: 'GND', kind: 'resistive', ohms: AXIS_OHMS / 2 },
    { id: 'vert-top', a: 'VCC', b: 'VERT', kind: 'resistive', ohms: AXIS_OHMS / 2 },
    { id: 'vert-bottom', a: 'VERT', b: 'GND', kind: 'resistive', ohms: AXIS_OHMS / 2 },
  ],
  defaults: { x: 0, y: 0 },
  createModel(ctx, props) {
    let x = clampAxis(props.x);
    let y = clampAxis(props.y);
    let pressed = false;
    const sel = ctx.link('sel');
    const horzDivider = new Divider(ctx, 'horz-top', 'horz-bottom');
    const vertDivider = new Divider(ctx, 'vert-top', 'vert-bottom');
    const horz = (): void => horzDivider.setPosition(AXIS_OHMS, (x + 1) / 2);
    const vert = (): void => vertDivider.setPosition(AXIS_OHMS, (y + 1) / 2);
    horz();
    vert();
    const press = (down: boolean): void => {
      if (down === pressed) return;
      pressed = down;
      sel.setClosed(down);
      ctx.invalidate();
    };
    return {
      input(event) {
        if (event.kind === 'press') press(true);
        else if (event.kind === 'release') press(false);
        const channel = readChannelInput(event);
        if (channel?.channel === 'x') {
          x = clampAxis(channel.value);
          horz();
          ctx.invalidate();
        } else if (channel?.channel === 'y') {
          y = clampAxis(channel.value);
          vert();
          ctx.invalidate();
        }
      },
      visual: () => ({ x, y, pressed }),
      reset() {
        x = clampAxis(props.x);
        y = clampAxis(props.y);
        horz();
        vert();
        press(false);
        ctx.invalidate();
      },
    };
  },
});
