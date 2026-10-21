import { editor } from './editor/app-store.ts';
import { Canvas } from './editor/Canvas.tsx';
import { viewMode } from './pcb/mode.ts';
import { lazyComponent } from './ui/lazy.tsx';
import { BottomPanel, codeTabOpen } from './ui/BottomPanel.tsx';
import { BridgeBanner } from './ui/BridgeBanner.tsx';
import { ExamplesGallery } from './ui/ExamplesGallery.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { Palette } from './ui/Palette.tsx';
import { RecordDialog } from './ui/RecordDialog.tsx';
import { ShortcutsSheet } from './ui/ShortcutsSheet.tsx';
import { StatusBar } from './ui/StatusBar.tsx';
import { Toolbar } from './ui/Toolbar.tsx';

/** The PCB view (BT59): a chunk of its own, loaded the first time PCB is chosen. */
const PcbView = lazyComponent(
  () => import('./pcb/PcbView.tsx').then((m) => m.PcbView),
  () => <main class="pcb-view" />,
);

/** Application frame: toolbar, parts palette, the bench canvas (or its PCB, BT59), inspector, output panel. */
export function App() {
  return (
    <div class={`shell${codeTabOpen.value ? ' code-open' : ''}`}>
      <Toolbar />
      <Palette />
      <Canvas store={editor} />
      {viewMode.value === 'pcb' && <PcbView />}
      <BridgeBanner />
      <Inspector />
      <BottomPanel />
      <StatusBar />
      <ExamplesGallery />
      <ShortcutsSheet />
      <RecordDialog />
    </div>
  );
}
