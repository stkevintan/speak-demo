# Mockups

The HTML here is the **source of truth for the UI**. The PNGs in
`../assets/` are rendered from it, so `UI.md` cannot describe a screen that
doesn't exist.

```
./build.sh            # validate every screen, then render PNGs at 2× (2880×1800)
./build.sh --check    # validate only — no output files
./build.sh 03         # validate + render just the screens matching "03"
```

## What the check enforces

Every screen is loaded at exactly **1440×900** (a MacBook viewport) and checked
for:

| Check | Why |
|---|---|
| **Overflow** | Nothing may extend past 1440×900 — a screenshot that clips is a lie |
| **Clipping** | Text whose scroll size exceeds its box, or that overflows its parent |
| **Duplicate IDs** | SVG gradient/filter IDs are global; two Pip instances on one page silently share the first one's gradient |
| **Contrast** | Full WCAG AA audit of every text element — see below |

The contrast audit walks ancestor layers, composites `rgba()` and gradient stops
against the **worst-case** stop, folds in element *and* ancestor `opacity`, and
applies the right threshold (3:1 at ≥24px or ≥18.66px bold, else 4.5:1). It
prints the measured ratio and both colours on failure:

```
FAIL  02-scenes  LOW CONTRAST: b. 3.76<4.5 #7c5cff/#f1ecff "3 times"
```

A non-zero `unverified` count in the `OK` line means some text could not be
resolved against a background — treat that as a failure too.

## Two rules that will bite you

1. **`icon(name, size, color, stroke)` takes a literal hex, not `var()`.**
   The colour is interpolated into an SVG `stroke` *attribute*, where `var()`
   does not resolve. Inside `<style>` blocks `var()` works normally.
2. **Bright tones are fills, not text.** `white` on `--coral` is 2.82:1 and
   `white` on `--sun` is 1.54:1 — both fail. Use `--ink` on bright fills, and a
   hue's `*-ink` token when the hue must be text on a light surface. Violet is
   the exception: its bright tone fails both ways, so it uses `--violet-deep`.
   Numbers and the rule are in [`../UI.md` §6](../UI.md#6-accessibility-and-states).
