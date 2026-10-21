import { render } from 'preact';
import { App } from './App.tsx';
import { firmwareStore } from './editor/firmware-store.ts';
import { registerServiceWorker } from './offline/register.ts';
import { openSharedLink } from './editor/share-actions.ts';
import { startSimHost } from './sim/host.ts';
import './sim/live-views.ts';
import './ui/serial-state.ts';
import './ui/audio/speakers.ts';
import './ui/plotter/plot-store.ts';
import './styles.css';

startSimHost();

const root = document.getElementById('app');
if (!root) throw new Error('#app root element missing from index.html');
render(<App />, root);
registerServiceWorker();
// After the restored project and the firmware store are in: a shared link replaces them.
void firmwareStore.loadAll().then(() => openSharedLink());
