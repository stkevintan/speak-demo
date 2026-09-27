import { useId } from "react";

export type PipMood = "idle" | "listen" | "think" | "write" | "cheer";

export function Pip({ mood = "idle", size = 72 }: { mood?: PipMood; size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" className="shrink-0">
      <defs>
        <linearGradient id={id} x2="1" y2="1">
          <stop stopColor="#5ee3c0" /><stop offset="1" stopColor="#12c8a0" />
        </linearGradient>
      </defs>
      <path d="M64 34q0-13 8-17" stroke="#12c8a0" strokeWidth="4" fill="none" />
      <circle cx="74" cy="14" r="6.5" fill="#ffc93c" />
      <path d="M36 46q-6-20 8-22q6 8 8 16M92 46q6-20-8-22q-6 8-8 16" fill="#5ee3c0" />
      <ellipse cx="64" cy="66" rx="36" ry="33" fill={`url(#${id})`} />
      <ellipse cx="64" cy="80" rx="21" ry="16" fill="#e8fff9" opacity=".6" />
      <ellipse cx="27" cy="70" rx="8" ry="14" fill="#4fdcc0" transform="rotate(14 27 70)" />
      <ellipse cx="101" cy="70" rx="8" ry="14" fill="#4fdcc0" transform="rotate(-14 101 70)" />
      {[49, 79].map((x) => (
        <g key={x}>
          <ellipse cx={x} cy="54" rx="12" ry={mood === "listen" ? 14 : 12} fill="white" />
          {mood === "cheer" ? (
            <path d={`M${x - 7} 56q7-9 14 0`} stroke="#1b1633" strokeWidth="4" fill="none" strokeLinecap="round" />
          ) : (
            <ellipse cx={x + (mood === "think" ? -3 : 0)} cy="54" rx="5.6" ry={mood === "write" ? 4 : 6} fill="#1b1633" />
          )}
        </g>
      ))}
      <path d="m57 69 7-5 7 5-7 6z" fill="#ffc93c" />
      <path d={mood === "cheer" ? "M53 79q11 15 22 0z" : "M56 80q8 7 16 0"} stroke="#1b1633" strokeWidth="3" fill={mood === "cheer" ? "#1b1633" : "none"} strokeLinecap="round" />
      <ellipse cx="45" cy="104" rx="10" ry="5" fill="#ffc93c" />
      <ellipse cx="83" cy="104" rx="10" ry="5" fill="#ffc93c" />
      {mood === "think" && <g fill="#7c5cff"><circle cx="100" cy="38" r="4" /><circle cx="111" cy="29" r="6" /></g>}
      {mood === "listen" && <path d="M108 47q12 14 0 28m8-34q17 20 0 40" fill="none" stroke="#08735a" strokeWidth="3" strokeLinecap="round" />}
      {mood === "write" && <g transform="rotate(20 106 77)"><rect x="102" y="59" width="8" height="36" rx="2" fill="#ffc93c" /><path d="m102 95 4 9 4-9" fill="#1b1633" /></g>}
    </svg>
  );
}

type AvatarProps = {
  style: "bob" | "cap" | "glasses" | "bun" | "long" | "short";
  mood: "stern" | "neutral" | "warm";
  hair: string;
  skin: string;
  accent: string;
  size?: number;
};

export function Avatar({ style, mood, hair, skin, accent, size = 64 }: AvatarProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className="shrink-0">
      <circle cx="50" cy="50" r="49" fill={accent} fillOpacity=".3" />
      {style === "bun" && <circle cx="50" cy="17" r="10" fill={hair} />}
      <path d={style === "long" ? "M23 46q-2-30 27-30t27 30v43H23z" : "M24 49q-3-31 26-31t26 31v16H24z"} fill={hair} />
      <ellipse cx="50" cy="54" rx="24" ry="29" fill={skin} />
      <path d="M26 45q-2-27 24-27t24 27q-9-25-27-17-14 5-21 17" fill={hair} />
      {style === "cap" && <g fill={accent}><path d="M22 32q5-26 28-26t28 26z" /><rect x="16" y="32" width="67" height="6" rx="3" /></g>}
      {[40, 60].map(x => <g key={x}><circle cx={x} cy="54" r="3.4" fill="#1b1633" /><circle cx={x + 1} cy="53" r="1" fill="white" /></g>)}
      {style === "glasses" && <g fill="none" stroke="#3d3659" strokeWidth="2.5"><circle cx="39" cy="54" r="9" /><circle cx="61" cy="54" r="9" /><path d="M48 54h4" /></g>}
      <ellipse cx="33" cy="63" rx="5" ry="3" fill="#ff7ac6" fillOpacity=".45" />
      <ellipse cx="67" cy="63" rx="5" ry="3" fill="#ff7ac6" fillOpacity=".45" />
      <path d={mood === "stern" ? "M43 72q7-5 14 0" : mood === "warm" ? "M41 68q9 12 18 0" : "M44 70q6 4 12 0"} fill="none" stroke="#1b1633" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
