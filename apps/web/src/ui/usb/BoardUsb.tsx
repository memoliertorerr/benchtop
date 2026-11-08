/**
 * The Inspector's USB section for an ESP32-S3 board (BT139): the computer's side of the board's
 * own USB port (USB-OTG), as the bench's USB host sees it (`sim.usb`, Bench.usbOf) — the device
 * it enumerated and what it uses, the text a keyboard typed, and the last events (mouse, media
 * keys, MIDI messages) with their times. Refreshed every 500 ms while running.
 */

import { useEffect, useState } from 'preact/hooks';
import type { UsbReply } from '../../sim/protocol.ts';
import { sim, simLoaded, simRunning } from '../../sim/host.ts';

/** Events the section lists (the newest), and typed characters it shows (the last). */
const SHOWN_EVENTS = 30;
const SHOWN_TYPED = 2000;

const seconds = (ns: number): string => `${(ns / 1e9).toFixed(3)} s`;

export function BoardUsb({ board }: { board: string }) {
  const loaded = simLoaded.value;
  const running = simRunning.value;
  const [reply, setReply] = useState<UsbReply | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!loaded) {
      setReply(null);
      return;
    }
    let live = true;
    void sim.usb(board).then((r) => {
      if (live) setReply(r);
    });
    return () => {
      live = false;
    };
  }, [board, loaded, running, tick]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, [running]);

  const usb = reply?.ok === true ? (reply.usb ?? null) : null;
  let body;
  if (!loaded) body = <p class="muted panel-note">Run to see what a sketch built for USB-OTG (TinyUSB) sends the computer: a keyboard's typing, a mouse, media keys, MIDI.</p>;
  else if (reply === null) body = <p class="muted panel-note">Reading…</p>;
  else if (!reply.ok) body = <p class="muted panel-note">{reply.error ?? 'Nothing to show.'}</p>;
  else if (usb === null || usb.phase === 'waiting')
    body = (
      <p class="muted panel-note">
        Nothing on the board's USB port. A sketch built for USB-OTG (TinyUSB) — a <code>// benchtop: usb-otg</code> line — shows up here.
      </p>
    );
  else if (usb.phase === 'enumerating') body = <p class="muted panel-note">The bench's USB host is enumerating the device…</p>;
  else if (usb.phase === 'failed') body = <p class="muted panel-note">The device didn't enumerate: Problems says why.</p>;
  else {
    const total = usb.events.length + usb.dropped;
    body = (
      <>
        <p class="muted panel-note">
          {usb.device === '' ? 'A USB device' : `"${usb.device}"`}: {usb.functions.length === 0 ? 'nothing the host reads' : usb.functions.join(', ')}.
        </p>
        {usb.typed !== '' && (
          <>
            <div class="field-label">Typed</div>
            <pre class="storage-bytes usb-typed">{usb.typed.length > SHOWN_TYPED ? `…${usb.typed.slice(-SHOWN_TYPED)}` : usb.typed}</pre>
          </>
        )}
        {usb.events.length > 0 && (
          <ul class="storage-entries usb-events">
            {usb.events.slice(-SHOWN_EVENTS).map((e, i) => (
              <li key={`${total}-${i}`} title={e.text}>
                <span class="storage-key">{e.text}</span>
                <span class="storage-value">{seconds(e.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {total > SHOWN_EVENTS && <p class="muted panel-note">The last {SHOWN_EVENTS} of {total} events.</p>}
        {usb.typed === '' && usb.events.length === 0 && <p class="muted panel-note">Nothing received yet.</p>}
      </>
    );
  }
  return (
    <div class="firmware-box storage-box">
      <div class="field-label">USB</div>
      {body}
      {loaded && (
        <div class="card-actions">
          <button type="button" class="tool-button" onClick={() => setTick((n) => n + 1)}>
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
