import { z } from "zod";
import { ACCENT_NAMES } from "./palette.js";

/**
 * The learner's CEFR band. The three values are the ones the onboarding picker
 * actually offers (`docs/design/mockups/01-onboarding.html`); there is no point
 * shipping an enum value no screen can produce.
 */
export const Level = z.enum(["A2", "B1", "B2"]);
export type Level = z.infer<typeof Level>;

/** Closed palette — see `./palette.ts` for why a course may not pick a hex. */
export const Accent = z.enum(ACCENT_NAMES);
export type Accent = z.infer<typeof Accent>;

/** `bob | short | bun | cap | glasses | long`, per `UI.md` §8. */
export const AvatarStyle = z.enum(["bob", "short", "bun", "cap", "glasses", "long"]);
export type AvatarStyle = z.infer<typeof AvatarStyle>;

/** `UI.md` §8: six styles × three moods. */
export const AvatarMood = z.enum(["stern", "neutral", "warm"]);
export type AvatarMood = z.infer<typeof AvatarMood>;

const hex = (label: string) =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, `${label} must be a 6-digit hex colour, e.g. #FFD3B0`);

export const Avatar = z.strictObject({
  style: AvatarStyle,
  mood: AvatarMood,
  hair: hex("hair"),
  skin: hex("skin"),
});
export type Avatar = z.infer<typeof Avatar>;

/**
 * `ARCHITECTURE.md` §5.7 makes the soft budget a product guarantee, so the cap
 * is enforced here rather than trusted to the author. §8's error path is a
 * rejection that names the file — silently rewriting 200 to 20 would leave the
 * author believing a number that is not in effect.
 */
export const MAX_LEARNER_TURNS = 20;
export const DEFAULT_LEARNER_TURNS = 12;

export const Budget = z.strictObject({
  learnerTurns: z
    .number()
    .int()
    .min(1)
    .max(MAX_LEARNER_TURNS, `learnerTurns may not exceed ${MAX_LEARNER_TURNS}`),
});
export type Budget = z.infer<typeof Budget>;

/**
 * `Stakes` is an object rather than one prose blob so the scene card can render
 * "what's at stake" as three separate fields; §4.4 keeps the course document's
 * top level to keys a screen actually reads.
 */
export const Stakes = z.strictObject({
  you: z.string().min(1),
  setting: z.string().min(1),
  edge: z.string().min(1),
});
export type Stakes = z.infer<typeof Stakes>;

export const Counterpart = z.strictObject({
  name: z.string().min(1),
  role: z.string().min(1),
  goal: z.string().min(1),
});
export type Counterpart = z.infer<typeof Counterpart>;

/**
 * The course — **this object is the contract, not the file** (`ARCHITECTURE.md`
 * §6.4). One schema, validated at runtime by zod, offline by
 * `pnpm check:courses`, and in the author's editor by the JSON Schema generated
 * from it — so the file format never needs a second description of itself.
 */
export const Course = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "id must be lowercase kebab-case, e.g. refund"),
  version: z.number().int().positive(),
  title: z.string().min(1),
  levels: z.array(Level).min(1),
  accent: Accent,
  budget: Budget.optional(),
  avatar: Avatar,

  stakes: Stakes,
  goal: z.string().min(1),
  counterpart: Counterpart,
  opener: z.string().min(1),
  coachHints: z.array(z.string().min(1)),
  prompts: z.strictObject({
    character: z.string().min(1),
    coach: z.string().min(1),
  }),
});
export type Course = z.infer<typeof Course>;
