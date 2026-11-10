/**
 * BT187: props a part gets when the editor places it, beyond its definition's defaults — what must
 * differ between two instances of the same type (a DS18B20's serial, so two sensors on one 1-Wire
 * line have different ROM codes). Projects written by hand set them themselves.
 */

import type { PartProps } from '@benchtop/core';
import { ds18b20Serial } from './sensors/ds18b20.ts';

export function initialProps(type: string, id: string): PartProps {
  if (type === 'ds18b20') return { serial: ds18b20Serial(id) };
  return {};
}
