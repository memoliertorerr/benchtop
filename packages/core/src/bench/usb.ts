/**
 * A board's USB host (BT138): the computer on the other end of a board's own USB port — the
 * ESP32-S3's USB-OTG, enumerated by the bench — and what it received from the device: the text a
 * keyboard typed and the other events (mouse, media keys, MIDI messages). For the hosts to show
 * (the Inspector's USB section, `sim_state`, a spec's `usb … received`). Not a contract: an MCU
 * with such a host opts in with `usbHost()`, found by `usesUsbHost`, as `usesSleep` finds
 * `sleepState`.
 */

export interface UsbHostEvent {
  /** When: the MCU's seconds (McuUsbHost) or bench nanoseconds (BoardUsb). */
  readonly at: number;
  readonly text: string;
}

/** The host as the MCU sees it, times in the MCU's seconds. */
export interface McuUsbHost {
  /** 'waiting': no device on the cable (the firmware hasn't started USB, or it detached). */
  readonly phase: 'waiting' | 'enumerating' | 'running' | 'failed';
  /** The device's product string ('' before it is read, or without one). */
  readonly device: string;
  /** What the host uses: "serial (CDC-ACM)", "keyboard", "mouse", "media keys", "MIDI", … */
  readonly functions: readonly string[];
  /** What keyboards typed (the last 4 KB). */
  readonly typed: string;
  /** The last events, oldest first. */
  readonly events: readonly UsbHostEvent[];
  /** Events dropped before those. */
  readonly dropped: number;
  /** The MCU's time now, seconds. */
  readonly now: number;
}

/** An MCU with a USB host; `usbHost()` is null when its firmware never touched the port. */
export interface UsbHosting {
  usbHost(): McuUsbHost | null;
}

export function usesUsbHost(mcu: object): mcu is UsbHosting {
  return typeof (mcu as Partial<UsbHosting>).usbHost === 'function';
}

/** A board's USB host as the bench reports it: event times in bench nanoseconds. */
export interface BoardUsb {
  readonly phase: McuUsbHost['phase'];
  readonly device: string;
  readonly functions: readonly string[];
  readonly typed: string;
  readonly events: readonly UsbHostEvent[];
  readonly dropped: number;
}

/** Whether a board's USB host received `needle`: in the typed text or an event's line. */
export function usbReceived(usb: BoardUsb, needle: string): boolean {
  return usb.typed.includes(needle) || usb.events.some((e) => e.text.includes(needle));
}
