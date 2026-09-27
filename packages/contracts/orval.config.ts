import { defineConfig } from "orval";

/**
 * Generates the typed React Query client from `openapi.yaml` — required by
 * `CODE_INSTRUCTION.md` ("MUST use the orval-generated client").
 *
 * The output is committed and never hand-edited: it is a build artifact of the
 * spec, and the spec is itself drift-checked against the zod validators by
 * `pnpm check:schema`. So there is exactly one place to change a shape — the zod
 * schema — and every other copy is either generated or verified.
 *
 * `clean` wipes `src/generated/` on every run, so the `fetcher` mutator lives in
 * `src/` alongside that directory rather than inside it.
 */
export default defineConfig({
  rehearsal: {
    input: {
      target: "./openapi.yaml",
      // The component schemas live in `schema/` (generated from zod) and are
      // referenced, not restated. Orval resolves external refs only from an
      // explicit allow-list, so every one of them is named here — which also
      // means a ref that silently stops resolving is a loud failure.
      parserOptions: {
        externalRefs: {
          allow: [
            "./schema/course.schema.json",
            "./schema/http/Profile.schema.json",
            "./schema/http/ProfilePatch.schema.json",
            "./schema/http/CourseCard.schema.json",
            "./schema/http/SessionStart.schema.json",
            "./schema/http/Debrief.schema.json",
          ],
        },
      },
    },
    output: {
      target: "./src/generated/api.ts",
      client: "react-query",
      mode: "single",
      mock: false,
      clean: true,
      prettier: false,
      override: {
        mutator: {
          path: "./src/fetcher.ts",
          name: "fetcher",
        },
        query: {
          useQuery: true,
          useMutation: true,
          // Pinned: `web` installs React Query v5, and orval cannot detect it
          // from this package. Without this the hooks get v4 option types.
          version: 5,
        },
      },
    },
  },
});
