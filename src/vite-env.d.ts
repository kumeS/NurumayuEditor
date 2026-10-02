/// <reference types="vite/client" />

/** Build identifier injected by vite.config.ts / vitest.config.ts `define`
 *  (see src/buildInfo.ts): short git SHA [+ "-dirty"], BUILD_ID env, or "unknown". */
declare const __BUILD_ID__: string;
