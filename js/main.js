// Entry point. ui.js, core.js, doc.js and present.js carry everything a viewer needs; the
// editor (editor.js + print.js) is fetched by present.js's loadEditor only when the planner
// opens /editor or signs in. The core/doc/present import cycle is entered here through
// present.js, which makes the module bodies run doc → core → present → this boot code.
import { refreshScreen, bootCloud } from './present.js';
import { hydrateIcons } from './icons.js';

bootCloud();

// Offline support: cache the app shell so the rink works without internet (needs HTTPS or localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

hydrateIcons();
refreshScreen();
