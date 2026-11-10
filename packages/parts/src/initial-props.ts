/**
 * BT187: props a part gets when the editor places it, beyond its definition's defaults — what must
 * differ between two instances of the same type (a DS18B20's serial, so two sensors on one 1-Wire
 * line have different ROM codes; BT197: an RC522's card and fob UIDs). Projects written by hand set them themselves.
 */

import type { PartProps } from '@benchtop/core';
import { rc522Uids } from './rfid/rc522.ts';
import { ds18b20Serial } from './sensors/ds18b20.ts';

export function initialProps(type: string, id: string): PartProps {
  if (type === 'ds18b20') return { serial: ds18b20Serial(id) };
  if (type === 'rc522') return rc522Uids(id); // BT197: each reader's card and fob their own UIDs
  return {};
}
