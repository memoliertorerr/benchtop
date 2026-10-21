import { effect, signal } from '@preact/signals';
import { type BridgeState, bridgeState } from '../sim/bridge-client.ts';

/** The state the banner was dismissed in; it comes back once the bridge answered again. */
const dismissed = signal<BridgeState | null>(null);
effect(() => {
  if (bridgeState.value === 'up') dismissed.value = null;
});

/** Says how to start the compile bridge when a sketch feature couldn't reach it. */
export function BridgeBanner() {
  const state = bridgeState.value;
  if ((state !== 'down' && state !== 'no-cli') || dismissed.value === state) return null;
  return (
    <div class="bridge-banner" role="status">
      <span>
        {state === 'down' ? (
          <>
            Compile bridge not running — start it with <code>npm run bridge</code>
          </>
        ) : (
          <>
            The compile bridge found no arduino-cli — install Arduino IDE 2 or arduino-cli, then restart <code>npm run bridge</code>
          </>
        )}
        <span class="muted"> · dropping a .hex or .elf on a board still works</span>
      </span>
      <button type="button" class="banner-close" aria-label="Dismiss" onClick={() => (dismissed.value = state)}>
        ×
      </button>
    </div>
  );
}
