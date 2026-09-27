/**
 * `@rehearsal/contracts` — the only dependency shared by `web`,
 * `control-plane` and `agent-worker` (`ARCHITECTURE.md` §3).
 *
 * Two halves, both importable from here:
 *  - the **types and validators** in `./zod`, used at runtime by all three modules;
 *  - the **course loader** in `./load`, used by the control-plane and by the
 *    offline `pnpm check:courses` script — the same function, so a file that
 *    passes offline cannot fail on load.
 *
 * The HTTP surface is `openapi.yaml` at the package root; `./generated` holds the
 * orval client built from it and is never edited by hand.
 */
export * from "./zod/index.js";
export * from "./load.js";
export * from "./card.js";
