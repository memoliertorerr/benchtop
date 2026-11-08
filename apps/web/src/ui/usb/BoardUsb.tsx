/**
 * The Inspector's USB section for an ESP32-S3 board (BT139): the computer's side of the board's
 * own USB port (USB-OTG), as the bench's USB host sees it (`sim.usb`, Bench.usbOf) — the device
 * it enumerated and what it uses, the text a keyboard typed, and the last events (mouse, media
 * keys, MIDI messages) with their times. Refreshed every 500 ms while running. BT142: a USB drive
 * the host mounted — its vendor, size and file system, and its files (the board's storage,
 * `sim.storage(board)`): open, download, delete, upload, or write a text file onto it. BT146: the
 * computer's side talks back — its lock keys (lit when on; a click toggles one, and a keyboard on
 * the port gets them as its LEDs) and a one-octave MIDI keyboard for a device that takes MIDI
 * (`sim.usbSend`), both recorded by Record test.
 */

import type { StoredFile, UsbDrive, UsbLocks } from '@benchtop/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { editorMessage } from '../../editor/app-store.ts';
import type { UsbReply } from '../../sim/protocol.ts';
import { sim, simLoaded, simRunning } from '../../sim/host.ts';
import { download, readPicked } from '../card/CardControls.tsx';
import { baseName, formatSize, previewOf } from '../card/card-files.ts';

/** Events the section lists (the newest), and typed characters it shows (the last). */
const SHOWN_EVENTS = 30;
const SHOWN_TYPED = 2000;

const seconds = (ns: number): string => `${(ns / 1e9).toFixed(3)} s`;

const DRIVE_STATES: Readonly<Record<UsbDrive['state'], string>> = {
  probing: 'Asking the drive what it is…',
  'no-medium': 'No medium in the drive (the sketch took it away, or hasn\'t put one in).',
  reading: 'Reading the drive…',
  mounted: '',
  unreadable: 'The bench\'s USB host can\'t read this drive',
  failed: 'The drive stopped answering',
};

const LOCK_KEYS = [
  ['num', 'Num Lock'],
  ['caps', 'Caps Lock'],
  ['scroll', 'Scroll Lock'],
] as const;

/** BT146: the computer's lock keys: lit when on; a click toggles one, and the device's keyboard gets its LEDs. */
function Locks({ board, locks, onSent }: { board: string; locks: UsbLocks; onSent: () => void }) {
  const toggle = async (lock: keyof UsbLocks): Promise<void> => {
    const reply = await sim.usbSend(board, { locks: { ...locks, [lock]: !locks[lock] } });
    if (!reply.ok) editorMessage.value = reply.error ?? "The lock keys didn't change";
    onSent();
  };
  return (
    <>
      <div class="field-label">Lock keys</div>
      <div class="usb-locks" role="group" aria-label="The computer's lock keys">
        {LOCK_KEYS.map(([key, label]) => (
          <button key={key} type="button" class={`tool-button usb-lock${locks[key] ? ' on' : ''}`} aria-pressed={locks[key]} onClick={() => void toggle(key)}>
            <span class="usb-lock-light" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

/** One octave, C to B: each key's semitone and, for the black ones, where it sits (in white-key widths). */
const PIANO: readonly { semitone: number; name: string; black: number | null }[] = [
  { semitone: 0, name: 'C', black: null },
  { semitone: 1, name: 'C#', black: 0.68 },
  { semitone: 2, name: 'D', black: null },
  { semitone: 3, name: 'D#', black: 1.72 },
  { semitone: 4, name: 'E', black: null },
  { semitone: 5, name: 'F', black: null },
  { semitone: 6, name: 'F#', black: 3.66 },
  { semitone: 7, name: 'G', black: null },
  { semitone: 8, name: 'G#', black: 4.7 },
  { semitone: 9, name: 'A', black: null },
  { semitone: 10, name: 'A#', black: 5.74 },
  { semitone: 11, name: 'B', black: null },
];

/** BT146: a one-octave MIDI keyboard for a device that takes MIDI: a note sounds while its key is held. */
function MidiKeys({ board }: { board: string }) {
  const [octave, setOctave] = useState(4);
  const [channel, setChannel] = useState(1);
  const [velocity, setVelocity] = useState(100);
  /** Notes on, and the channel each went out on. */
  const held = useRef(new Map<number, number>());
  const send = (bytes: number[]): void => {
    void sim.usbSend(board, { midi: new Uint8Array(bytes) }).then((reply) => {
      if (!reply.ok) editorMessage.value = reply.error ?? "The MIDI didn't go out";
    });
  };
  const noteOn = (note: number): void => {
    if (held.current.has(note)) return;
    held.current.set(note, channel);
    send([0x90 | (channel - 1), note, velocity]);
  };
  const noteOff = (note: number): void => {
    const ch = held.current.get(note);
    if (ch === undefined) return;
    held.current.delete(note);
    send([0x80 | (ch - 1), note, 0]);
  };
  useEffect(
    () => () => {
      for (const note of [...held.current.keys()]) noteOff(note);
    },
    [board],
  );
  const base = (octave + 1) * 12; // C4 = 60
  const key = (k: (typeof PIANO)[number]) => {
    const note = base + k.semitone;
    return (
      <button
        key={k.name}
        type="button"
        class={`usb-key${k.black === null ? '' : ' black'}`}
        style={k.black === null ? undefined : { left: `calc(100% / 7 * ${k.black})` }}
        aria-label={`${k.name}${octave} (${note})`}
        title={`${k.name}${octave} (${note})`}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          noteOn(note);
        }}
        onPointerUp={() => noteOff(note)}
        onPointerCancel={() => noteOff(note)}
        onKeyDown={(e) => {
          if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
            e.preventDefault();
            noteOn(note);
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') noteOff(note);
        }}
        onBlur={() => noteOff(note)}
      />
    );
  };
  return (
    <>
      <div class="field-label">MIDI keyboard</div>
      <div class="usb-piano" role="group" aria-label={`MIDI keyboard, C${octave} to B${octave}`}>
        {PIANO.filter((k) => k.black === null).map(key)}
        {PIANO.filter((k) => k.black !== null).map(key)}
      </div>
      <div class="usb-midi-controls">
        <button type="button" class="tool-button" aria-label="Octave down" disabled={octave <= -1} onClick={() => setOctave(octave - 1)}>
          −
        </button>
        <span class="muted">
          C{octave}–B{octave}
        </span>
        <button type="button" class="tool-button" aria-label="Octave up" disabled={octave >= 8} onClick={() => setOctave(octave + 1)}>
          +
        </button>
        <label>
          Channel{' '}
          <select value={channel} onChange={(e) => setChannel(Number((e.target as HTMLSelectElement).value))}>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </label>
        <label>
          Velocity{' '}
          <input type="range" min={1} max={127} value={velocity} onInput={(e) => setVelocity(Number((e.target as HTMLInputElement).value))} />
          <span class="muted">{velocity}</span>
        </label>
      </div>
    </>
  );
}

/** BT142: a USB drive the host mounted — what it is, and its files while mounted. */
function Drive({ board, drive, tick }: { board: string; drive: UsbDrive; tick: number }) {
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [changed, setChanged] = useState(0);
  const mounted = drive.state === 'mounted';

  useEffect(() => {
    if (!mounted) {
      setFiles(null);
      return;
    }
    let live = true;
    void sim.storage(board, { op: 'list' }).then((reply) => {
      if (live) setFiles(reply.ok ? (reply.files ?? []) : []);
    });
    return () => {
      live = false;
    };
  }, [board, mounted, tick, changed]);

  const read = async (path: string): Promise<Uint8Array | null> => {
    const reply = await sim.storage(board, { op: 'read', path });
    return reply.ok && reply.bytes !== undefined ? reply.bytes : null;
  };
  const view = async (path: string): Promise<void> => {
    if (open?.path === path) return setOpen(null);
    const bytes = await read(path);
    setOpen({ path, text: bytes === null ? 'Not read yet: the host is fetching it — open it again in a moment.' : previewOf(bytes) });
  };
  const save = async (path: string): Promise<void> => {
    const bytes = await read(path);
    if (bytes !== null) download(bytes, baseName(path));
  };
  const write = async (path: string, bytes: Uint8Array): Promise<void> => {
    const reply = await sim.storage(board, { op: 'write', path, bytes });
    if (!reply.ok) editorMessage.value = `${path} didn't go on the drive${drive.writeProtected ? ' (it is write-protected)' : ''}`;
    setChanged((n) => n + 1);
  };
  const remove = async (path: string): Promise<void> => {
    await sim.storage(board, { op: 'remove', path });
    if (open?.path === path) setOpen(null);
    setChanged((n) => n + 1);
  };
  const upload = async (input: HTMLInputElement): Promise<void> => {
    for (const [file, bytes] of await readPicked(input)) await write(file, bytes);
  };
  const addText = async (): Promise<void> => {
    if (name.trim() === '') return;
    await write(name.trim(), new TextEncoder().encode(text));
    setName('');
    setText('');
  };

  const what = [drive.vendor, drive.product, drive.revision].filter((s) => s !== '').join(' ') || 'A USB drive';
  return (
    <>
      <div class="field-label">Drive</div>
      <p class="muted panel-note">
        {what}: {formatSize(drive.bytes)}
        {mounted ? `, ${drive.fileSystem}${drive.label === '' ? '' : ` "${drive.label}"`}` : ''}
        {drive.writeProtected ? ', write-protected' : ''}.
      </p>
      {!mounted && (
        <p class="muted panel-note">
          {DRIVE_STATES[drive.state]}
          {drive.problem === '' ? '' : `: ${drive.problem}`}
        </p>
      )}
      {mounted && files !== null && (
        <>
          {files.length === 0 ? (
            <p class="muted panel-note">Empty.</p>
          ) : (
            <ul class="card-files">
              {files.map((f) => (
                <li key={f.path} class={f.dir ? 'card-dir' : ''}>
                  {f.dir ? (
                    <span class="card-name">{f.path}/</span>
                  ) : (
                    <button type="button" class="card-name link-button" title="Show its contents" onClick={() => void view(f.path)} aria-expanded={open?.path === f.path}>
                      {f.path}
                    </button>
                  )}
                  <span class="card-size muted">{f.dir ? '' : formatSize(f.size)}</span>
                  {!f.dir && (
                    <button type="button" class="icon-button" title="Download" aria-label={`Download ${f.path}`} onClick={() => void save(f.path)}>
                      ⤓
                    </button>
                  )}
                  <button type="button" class="icon-button" title="Delete from the drive" aria-label={`Delete ${f.path}`} onClick={() => void remove(f.path)}>
                    ✕
                  </button>
                  {open?.path === f.path && <pre class="card-preview">{open.text}</pre>}
                </li>
              ))}
            </ul>
          )}
          {drive.unread > 0 && <p class="muted panel-note">{drive.unread} file{drive.unread === 1 ? '' : 's'} not read yet (the host reads 1 MB when it mounts a drive): open one to read it.</p>}
          <div class="card-actions">
            <label class="tool-button">
              Upload…
              <input type="file" multiple hidden onChange={(e) => void upload(e.currentTarget)} />
            </label>
          </div>
          <label class="field">
            <span class="field-label">Write a text file</span>
            <input class="tool-input" placeholder="CONFIG.TXT" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <textarea class="tool-input" rows={3} placeholder="led=green" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="card-actions">
            <button type="button" class="tool-button" disabled={name.trim() === ''} onClick={() => void addText()}>
              Write to the drive
            </button>
          </div>
        </>
      )}
    </>
  );
}

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
        {usb.typed === '' && usb.events.length === 0 && usb.drive === null && <p class="muted panel-note">Nothing received yet.</p>}
        {usb.keyboardLeds && <Locks board={board} locks={usb.locks} onSent={() => setTick((n) => n + 1)} />}
        {usb.midiIn && <MidiKeys board={board} />}
        {usb.drive !== null && <Drive board={board} drive={usb.drive} tick={tick} />}
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
