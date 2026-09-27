/* Rehearsal — character library for the UI mockups.
 *
 *  pipSvg()    — "Pip", the silent coach. His expression *is* the state
 *                indicator (idle / listen / think / write / cheer), which is how
 *                the product satisfies "never ambiguous silence" without words.
 *  avatarSvg() — the in-scene character (Dana the clerk, etc.).
 *
 *  Geometry note: Pip is laid out on a 128x128 grid. Body spans y33..99 so the
 *  feet (cy104) clear the silhouette; eyes sit at cy54 so every fringe style
 *  (which stops at y48) stays clear of them.
 */

function pipSvg(size = 120, mood = "idle") {
  const e = {
    idle: { ry: 10, look: 0 },
    listen: { ry: 12, look: 0 },
    think: { ry: 9, look: -3 },
    write: { ry: 7, look: 3 },
    cheer: { ry: 10, look: 0 },
  }[mood] || { ry: 10, look: 0 };

  const closed = mood === "cheer";
  const eye = (cx) =>
    closed
      ? `<path d="M${cx - 7} 56 q7 -9 14 0" stroke="#1B1633" stroke-width="4"
           fill="none" stroke-linecap="round"/>`
      : `<ellipse cx="${cx + e.look}" cy="54" rx="5.6" ry="${(e.ry * 0.6).toFixed(1)}"
           fill="#1B1633"/>
         <circle cx="${cx + e.look + 2}" cy="${(50 - e.ry * 0.15).toFixed(1)}" r="2.1" fill="#fff"/>`;

  const mouth = {
    idle: `<path d="M56 78 q8 7 16 0" stroke="#1B1633" stroke-width="3.4"
             fill="none" stroke-linecap="round"/>`,
    listen: `<path d="M55 77 q9 10 18 0" stroke="#1B1633" stroke-width="3.4"
             fill="none" stroke-linecap="round"/>`,
    think: `<circle cx="58" cy="80" r="2.8" fill="#1B1633"/>
            <circle cx="66" cy="80" r="2.8" fill="#1B1633" opacity=".5"/>`,
    write: `<path d="M56 80 q7 4 14 -1" stroke="#1B1633" stroke-width="3.2"
             fill="none" stroke-linecap="round"/>`,
    cheer: `<path d="M53 76 q11 15 22 0 z" fill="#1B1633"/>`,
  }[mood] || "";

  const extras = {
    listen: `<g stroke="#12C8A0" stroke-width="3.4" fill="none" stroke-linecap="round">
        <path d="M106 50 q9 12 0 24"/><path d="M115 43 q14 19 0 38"/></g>`,
    think: `<g fill="#7C5CFF">
        <circle cx="98" cy="46" r="4"/><circle cx="107" cy="38" r="5"/>
        <circle cx="118" cy="28" r="6.5"/></g>`,
    write: `<g transform="rotate(-20 104 78)">
        <rect x="100" y="58" width="9" height="42" rx="3" fill="#FFC93C"/>
        <rect x="100" y="58" width="9" height="11" rx="3" fill="#FF7AC6"/>
        <path d="M100 100 l4.5 10 4.5 -10 z" fill="#1B1633"/></g>`,
    cheer: `<g fill="#FFC93C">
        <path d="M20 30 l3.5 8 8 3.5 -8 3.5 -3.5 8 -3.5 -8 -8 -3.5 8 -3.5 z"/>
        <path d="M106 22 l2.6 6 6 2.6 -6 2.6 -2.6 6 -2.6 -6 -6 -2.6 6 -2.6 z"/></g>`,
  }[mood] || "";

  // Several Pips share a page, so every gradient/filter id needs a suffix —
  // duplicate ids are invalid and would make later instances inherit the first.
  const uid = `p${mood}${size}`;

  return `<svg width="${size}" height="${size}" viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pip the coach">
    <defs>
      <linearGradient id="pipBody${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5EE3C0"/><stop offset="1" stop-color="#12C8A0"/>
      </linearGradient>
      <linearGradient id="pipWing${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#9BF0DA"/><stop offset="1" stop-color="#4FDCC0"/>
      </linearGradient>
      <filter id="pipShadow${uid}" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="6" stdDeviation="6"
          flood-color="#12C8A0" flood-opacity=".3"/>
      </filter>
    </defs>

    <g filter="url(#pipShadow${uid})">
      <!-- antenna -->
      <path d="M64 34 q0 -13 8 -17" stroke="#12C8A0" stroke-width="4"
        fill="none" stroke-linecap="round"/>
      <circle cx="74" cy="14" r="6.5" fill="#FFC93C"/>
      <circle cx="72" cy="12" r="2" fill="#fff" opacity=".8"/>

      <!-- ears -->
      <path d="M36 46 q-6 -20 8 -22 q6 8 8 16 z" fill="url(#pipWing${uid})"/>
      <path d="M92 46 q6 -20 -8 -22 q-6 8 -8 16 z" fill="url(#pipWing${uid})"/>

      <!-- body -->
      <ellipse cx="64" cy="66" rx="36" ry="33" fill="url(#pipBody${uid})"/>
      <ellipse cx="64" cy="80" rx="21" ry="16" fill="#E8FFF9" opacity=".6"/>

      <!-- wings -->
      <ellipse cx="27" cy="70" rx="8" ry="14" fill="url(#pipWing${uid})"
        transform="rotate(14 27 70)"/>
      <ellipse cx="101" cy="70" rx="8" ry="14" fill="url(#pipWing${uid})"
        transform="rotate(-14 101 70)"/>

      <!-- face -->
      <ellipse cx="49" cy="54" rx="12" ry="${e.ry + 2}" fill="#fff"/>
      <ellipse cx="79" cy="54" rx="12" ry="${e.ry + 2}" fill="#fff"/>
      ${eye(49)}${eye(79)}
      <ellipse cx="36" cy="68" rx="7" ry="4.5" fill="#FF9DBE" opacity=".6"/>
      <ellipse cx="92" cy="68" rx="7" ry="4.5" fill="#FF9DBE" opacity=".6"/>
      <path d="M64 66 l5 4.5 -5 4 -5 -4 z" fill="#FFA84A"/>
      ${mouth}

      <!-- feet -->
      <ellipse cx="52" cy="104" rx="8" ry="5" fill="#FFA84A"/>
      <ellipse cx="76" cy="104" rx="8" ry="5" fill="#FFA84A"/>
    </g>
    ${extras}
  </svg>`;
}

/* The person the learner actually talks to. Parameterised so each scene gets a
   recognisable face without shipping artwork.
 *
 * `hairBack` renders behind the head (long hair falls behind the face);
 * `hairFront` is the fringe, which stops at y48 so eyes (cy59) stay visible.
 */
function avatarSvg(opts = {}) {
  const {
    size = 72,
    skin = "#FFD3B0",
    hair = "#3D3659",
    accent = "#7C5CFF",
    style = "bob", // bob | short | bun | cap | glasses | long
    mood = "neutral", // neutral | warm | stern
  } = opts;

  const FRINGE = {
    bob: `<path d="M22 48 q0 -30 28 -30 q28 0 28 30 q-6 -16 -28 -16 q-22 0 -28 16z" fill="${hair}"/>`,
    short: `<path d="M24 46 q2 -26 26 -26 q24 0 26 26 q-9 -14 -26 -14 q-17 0 -26 14z" fill="${hair}"/>`,
    bun: `<circle cx="50" cy="17" r="9" fill="${hair}"/>
      <path d="M24 46 q2 -26 26 -26 q24 0 26 26 q-9 -14 -26 -14 q-17 0 -26 14z" fill="${hair}"/>`,
    long: `<path d="M22 48 q0 -30 28 -30 q28 0 28 30 q-6 -16 -28 -16 q-22 0 -28 16z" fill="${hair}"/>`,
    cap: `<path d="M22 44 q4 -24 28 -24 q24 0 28 24 z" fill="${accent}"/>
      <path d="M17 44 q33 -7 66 0 q-4 9 -33 9 q-29 0 -33 -9z" fill="${accent}"/>
      <rect x="17" y="42" width="66" height="6" rx="3" fill="#fff" opacity=".38"/>`,
    glasses: `<path d="M24 46 q2 -26 26 -26 q24 0 26 26 q-9 -14 -26 -14 q-17 0 -26 14z" fill="${hair}"/>`,
  }[style] || "";

  const BACK =
    style === "long"
      ? `<path d="M16 48 q0 -32 34 -32 q34 0 34 32 l0 46 q-12 3 -14 -9 l0 -32
           q-6 -16 -20 -16 q-14 0 -20 16 l0 32 q-2 12 -14 9z" fill="${hair}"/>`
      : style === "bun"
        ? `<circle cx="50" cy="17" r="9" fill="${hair}"/>`
        : "";

  const eyes =
    mood === "warm"
      ? `<path d="M36 60 q5 -7 10 0" stroke="#1B1633" stroke-width="3"
           fill="none" stroke-linecap="round"/>
         <path d="M56 60 q5 -7 10 0" stroke="#1B1633" stroke-width="3"
           fill="none" stroke-linecap="round"/>`
      : `<circle cx="41" cy="59" r="4.4" fill="#1B1633"/>
         <circle cx="61" cy="59" r="4.4" fill="#1B1633"/>
         <circle cx="42.6" cy="57.4" r="1.5" fill="#fff"/>
         <circle cx="62.6" cy="57.4" r="1.5" fill="#fff"/>`;

  const mouth =
    mood === "stern"
      ? `<path d="M43 73 q8 -4 15 0" stroke="#1B1633" stroke-width="2.8"
           fill="none" stroke-linecap="round"/>`
      : mood === "warm"
        ? `<path d="M42 70 q9 10 17 0" stroke="#1B1633" stroke-width="2.8"
             fill="none" stroke-linecap="round"/>`
        : `<path d="M44 71 q7 5 13 0" stroke="#1B1633" stroke-width="2.8"
             fill="none" stroke-linecap="round"/>`;

  const glasses =
    style === "glasses"
      ? `<g stroke="#3D3659" stroke-width="2.4" fill="none">
           <circle cx="41" cy="59" r="9"/><circle cx="61" cy="59" r="9"/>
           <path d="M50 59 h2"/></g>`
      : "";

  const uid = `${style}${mood}${size}${accent.replace("#", "")}`;

  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg" role="img">
    <defs>
      <linearGradient id="avBg${uid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${accent}" stop-opacity=".20"/>
        <stop offset="1" stop-color="${accent}" stop-opacity=".45"/>
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="50" fill="url(#avBg${uid})"/>
    ${BACK}
    <ellipse cx="50" cy="56" rx="26" ry="28" fill="${skin}"/>
    ${FRINGE}
    <ellipse cx="32" cy="68" rx="6" ry="4" fill="#FF9DBE" opacity=".5"/>
    <ellipse cx="68" cy="68" rx="6" ry="4" fill="#FF9DBE" opacity=".5"/>
    ${eyes}${glasses}${mouth}
  </svg>`;
}
