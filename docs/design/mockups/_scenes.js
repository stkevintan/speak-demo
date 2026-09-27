/* The six launch scenes. Kept in one place so every mockup shows the same
   cast — the scene card is the product's core unit of "what's at stake". */

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const SCENES = [
  {
    id: "refund",
    title: "Returning a faulty item",
    them: "Dana",
    role: "Store clerk",
    edge: "would rather you went away",
    you: "a customer with a broken item and no receipt",
    goal: "Get a refund without escalating",
    setting: "A busy electronics store, Saturday afternoon",
    level: "B1",
    accent: "#7C5CFF",
    ink: "#5b3fd6",
    soft: "#EFEAFF",
    avatar: { style: "bob", hair: "#3D3659", skin: "#FFD3B0", mood: "stern" },
  },
  {
    id: "raise",
    title: "Asking for a raise",
    them: "Marcus",
    role: "Your manager",
    edge: "is having a busy quarter",
    you: "an employee who has quietly outgrown the role",
    goal: "Name a number and hold it",
    setting: "A 20-minute 1:1 in a glass meeting room",
    level: "B2",
    accent: "#FF6B4A",
    ink: "#b23a1a",
    soft: "#FFE9E2",
    avatar: { style: "cap", hair: "#2B2440", skin: "#E8B48C", mood: "neutral" },
  },
  {
    id: "flat",
    title: "Renting a flat",
    them: "Priya",
    role: "Landlord",
    edge: "has three other viewers today",
    you: "a tenant with questions and a budget",
    goal: "Ask about the deposit without sounding difficult",
    setting: "An empty flat with new paint smell",
    level: "B1",
    accent: "#12C8A0",
    ink: "#08735a",
    soft: "#DEF7F0",
    avatar: { style: "glasses", hair: "#5A3B2E", skin: "#FFD3B0", mood: "neutral" },
  },
  {
    id: "interview",
    title: "Job interview",
    them: "Elena",
    role: "Hiring manager",
    edge: "has heard the same answer all morning",
    you: "a candidate with one story worth telling",
    goal: "Tell one story that lands, in 90 seconds",
    setting: "A video call, ten minutes before lunch",
    level: "B2",
    accent: "#FF7AC6",
    ink: "#a8347f",
    soft: "#FFE6F5",
    avatar: { style: "bun", hair: "#1B1633", skin: "#C98A63", mood: "warm" },
  },
  {
    id: "party",
    title: "Small talk at a party",
    them: "Sam",
    role: "A friend of a friend",
    edge: "knows nobody here either",
    you: "someone who came alone",
    goal: "Keep a conversation alive for two minutes",
    setting: "A rooftop, music a bit too loud",
    level: "A2",
    accent: "#3DBDFF",
    ink: "#1a6a99",
    soft: "#E1F2FF",
    avatar: { style: "long", hair: "#B5651D", skin: "#FFE0C4", mood: "warm" },
  },
  {
    id: "clinic",
    title: "Rescheduling an appointment",
    them: "Ruth",
    role: "Clinic receptionist",
    edge: "is following a strict script",
    you: "a patient who needs a different time",
    goal: "Move the appointment without losing it",
    setting: "A phone call, hold music in the background",
    level: "A2",
    accent: "#FFC93C",
    ink: "#8a6013",
    soft: "#FFF4D8",
    avatar: { style: "short", hair: "#8A8FA3", skin: "#F0C39B", mood: "neutral" },
  },
];

function sceneCard(s, opts = {}) {
  const { compact = false } = opts;
  const vars = `--accent:${s.accent};--soft:${s.soft};--accent-a:${hexA(s.accent, 0.4)};--ink:${s.ink}`;
  return `<article class="scene-card" style="${vars}">
    <div class="sc-head">
      ${avatarSvg({ size: compact ? 50 : 58, accent: s.accent, ...s.avatar })}
      <div style="min-width:0">
        <div class="sc-name">${s.them}</div>
        <div class="sc-role">${s.role}</div>
      </div>
      <div class="sc-level">${s.level}</div>
    </div>
    <h3 class="sc-title">${s.title}</h3>
    <div class="sc-you"><span class="lbl">You</span><span>${s.you}</span></div>
    <div class="sc-goal">${icon("target", 17, s.accent, 2.4)}<span>${s.goal}</span></div>
    <p class="sc-setting">${s.setting}</p>
    <div class="sc-foot">
      <span class="sc-edge">${s.them} ${s.edge}</span>
      <span class="sc-go">${icon("arrowRight", 18, "#fff", 2.4)}</span>
    </div>
  </article>`;
}
