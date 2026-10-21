import { editor } from './editor/app-store.ts';
import { Canvas } from './editor/Canvas.tsx';
import { BottomPanel, codeTabOpen } from './ui/BottomPanel.tsx';
import { BridgeBanner } from './ui/BridgeBanner.tsx';
import { ExamplesGallery } from './ui/ExamplesGallery.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { Palette } from './ui/Palette.tsx';
import { RecordDialog } from './ui/RecordDialog.tsx';
import { ShortcutsSheet } from './ui/ShortcutsSheet.tsx';
import { StatusBar } from './ui/StatusBar.tsx';
import { Toolbar } from './ui/Toolbar.tsx';

/** Application frame: toolbar, parts palette, the bench canvas, inspector, output panel. */
export function App() {
  return (
    <div class={`shell${codeTabOpen.value ? ' code-open' : ''}`}>
      <Toolbar />
      <Palette />
      <Canvas store={editor} />
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
