/** The app's frame dispatcher: every part state from the worker (frames or frame ring) goes to its view. */

import { FrameDispatcher } from './frame-dispatch.ts';
import { onVisuals } from './host.ts';

export const liveViews = new FrameDispatcher();

onVisuals((parts) => liveViews.dispatch(parts));
