/**
 * The Inspector's Storage section for a board (BT120): what it keeps across resets — an Arduino
 * AVR board's EEPROM, an ESP32's, ESP32-C3's, ESP32-S3's, ESP32-S2's or Pico's flash data — as the worker reads it
 * (`sim.memory`): how much is in use, the ESP32s' NVS entries (Preferences: namespace, key, value),
 * an EEPROM's written bytes; and Erase. Refreshed every 2 s while running. Without a loaded bench
 * it shows what is saved for the board (the memory store) and erases that.
 */

import { useEffect, useState } from 'preact/hooks';
import { memoryStore } from '../../editor/memory-store.ts';
import type { MemoryReply } from '../../sim/protocol.ts';
import { sim, simLoaded, simRunning } from '../../sim/host.ts';
import { formatSize } from '../card/card-files.ts';

/** Rows the section lists at most (the rest as a count). */
const MAX_ROWS = 40;

function usedBytes(reply: MemoryReply): number {
  return (reply.sectors ?? []).reduce((sum, s) => sum + s.bytes.length, 0);
}

function Entries({ reply }: { reply: MemoryReply }) {
  if (reply.kind === 'eeprom') {
    const bytes = reply.eeprom ?? [];
    if (bytes.length === 0) return <p class="muted panel-note">Nothing written: every byte reads 0xFF.</p>;
    return (
      <>
        <p class="muted panel-note">
          {bytes.length} of {reply.size?.toLocaleString('en-US')} bytes written (address: value).
        </p>
        <pre class="storage-bytes">
          {bytes
            .slice(0, MAX_ROWS * 8)
            .map(([address, value]) => `${address}: ${value} (0x${value.toString(16).padStart(2, '0')})`)
            .join('\n')}
          {bytes.length > MAX_ROWS * 8 ? `\n… and ${bytes.length - MAX_ROWS * 8} more` : ''}
        </pre>
      </>
    );
  }
  const partitions = reply.nvs ?? [];
  const entries = partitions.flatMap((p) => p.entries);
  const problems = partitions.flatMap((p) => p.problems);
  return (
    <>
      {entries.length === 0 ? (
        <p class="muted panel-note">{partitions.length === 0 ? 'No NVS partition in its table.' : 'No NVS entries (Preferences) stored.'}</p>
      ) : (
        <ul class="storage-entries">
          {entries.slice(0, MAX_ROWS).map((e) => (
            <li key={`${e.namespace}.${e.key}`} title={`${e.type}${e.size === undefined ? '' : `, ${e.size} bytes`}`}>
              <span class="storage-key">
                {e.namespace}.{e.key}
              </span>
              <span class="storage-value">{e.type === 'string' ? JSON.stringify(e.value) : e.value}</span>
            </li>
          ))}
        </ul>
      )}
      {entries.length > MAX_ROWS && <p class="muted panel-note">… and {entries.length - MAX_ROWS} more</p>}
      {problems.length > 0 && <p class="muted panel-note">Not read: {problems.slice(0, 3).join('; ')}</p>}
    </>
  );
}

export function BoardStorage({ board }: { board: string }) {
  const loaded = simLoaded.value;
  const running = simRunning.value;
  const [reply, setReply] = useState<MemoryReply | null>(null);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const refresh = (): void => setTick((n) => n + 1);

  useEffect(() => {
    if (!loaded) {
      setReply(null);
      return;
    }
    let live = true;
    void sim.memory(board, 'read').then((r) => {
      if (live) setReply(r);
    });
    return () => {
      live = false;
    };
  }, [board, loaded, running, tick]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [running]);

  const erase = async (): Promise<void> => {
    if (loaded) await sim.memory(board, 'erase');
    await memoryStore.delete(board);
    setNote(loaded ? 'Erased: the board sees it at its next reset.' : 'Erased.');
    refresh();
  };

  const saved = memoryStore.get(board);
  const savedBytes = (saved ?? []).reduce((sum, s) => sum + s.bytes.length, 0);
  return (
    <div class="firmware-box storage-box">
      <div class="field-label">Storage</div>
      {!loaded ? (
        <p class="muted panel-note">
          {savedBytes > 0 ? `${formatSize(savedBytes)} saved from the last run (EEPROM or flash data). Run to see what it holds.` : 'Run to see what the board keeps across resets (EEPROM, Preferences).'}
        </p>
      ) : reply === null ? (
        <p class="muted panel-note">Reading…</p>
      ) : !reply.ok ? (
        <p class="muted panel-note">{reply.error ?? 'Nothing to show.'}</p>
      ) : (
        <>
          <p class="muted panel-note">
            {reply.kind === 'eeprom' ? 'EEPROM' : 'Flash data'}: {formatSize(usedBytes(reply))} in use, kept across resets and uploads.
          </p>
          <Entries reply={reply} />
        </>
      )}
      {note !== null && <p class="muted panel-note">{note}</p>}
      <div class="card-actions">
        {loaded && (
          <button type="button" class="tool-button" onClick={refresh}>
            Refresh
          </button>
        )}
        <button type="button" class="tool-button" disabled={!loaded && savedBytes === 0} title="Erase what the firmware stored (the program stays)" onClick={() => void erase()}>
          Erase
        </button>
      </div>
    </div>
  );
}
