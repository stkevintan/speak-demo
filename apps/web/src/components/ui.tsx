import type { ReactNode } from "react";
import { AlertCircle, ArrowLeft, LoaderCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { Pip } from "./Artwork";

export const accents = {
  violet: { fill: "#7c5cff", soft: "#ece7ff", ink: "#5b3fd6" },
  coral: { fill: "#ff6b4a", soft: "#ffe7e0", ink: "#b23a1a" },
  teal: { fill: "#12c8a0", soft: "#d9f7ef", ink: "#08735a" },
  sun: { fill: "#ffc93c", soft: "#fff3d4", ink: "#8a6013" },
  sky: { fill: "#3dbdff", soft: "#ddf1ff", ink: "#1a6a99" },
  pink: { fill: "#ff7ac6", soft: "#ffe4f3", ink: "#a8347f" },
};

export function Shell({ children, header, scrollable = true }: { children: ReactNode; header?: ReactNode; scrollable?: boolean }) {
  return (
    <div className={`mx-auto flex h-dvh max-h-dvh min-h-0 max-w-[1600px] flex-col px-4 pb-8 sm:px-8 lg:px-11 ${scrollable ? "overflow-y-auto" : "overflow-hidden"}`}>
      <header className="flex min-h-20 shrink-0 flex-wrap items-center gap-3 py-3">
        <Link to="/scenes" className="flex min-h-11 items-center gap-2 text-xl font-black tracking-tight" aria-label="Rehearsal home">
          <Pip size={36} /> Rehearsal
        </Link>
        <div className="ml-auto flex flex-wrap items-center gap-3">{header}</div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}

export function Busy({ children = "Getting things ready..." }: { children?: ReactNode }) {
  return <div className="flex items-center justify-center gap-3 p-10 font-bold text-muted" role="status"><LoaderCircle className="animate-spin" size={22} />{children}</div>;
}

export function Problem({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="my-4 flex flex-wrap items-center gap-3 rounded-2xl border border-sun bg-sun-soft p-4 text-body">
      <AlertCircle size={22} className="shrink-0 text-sun-ink" />
      <p className="min-w-0 flex-1 text-sm font-semibold">{message}</p>
      {retry && <button className="button button-secondary" onClick={retry}>Try again</button>}
    </div>
  );
}

export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className="inline-flex min-h-11 items-center gap-3 text-sm font-extrabold text-body">
      {label}
      <span className={`flex h-7 w-12 items-center rounded-full p-1 ${checked ? "bg-teal" : "bg-[#ddd6e6]"}`}>
        <span className={`size-5 rounded-full bg-white shadow-sm ${checked ? "ml-auto" : ""}`} />
      </span>
    </button>
  );
}

export function BackToScenes() {
  return <Link className="button button-secondary" to="/scenes"><ArrowLeft size={18} />Back to scenes</Link>;
}

/**
 * A 0-100 progress ring (`DESIGN.md` §4).
 *
 * The arc and the number are both drawn in the accent's `ink` tone: the bright
 * `fill` tones are fills, never text, and a `sun` arc on white fails even the 3:1
 * a graphic needs.
 *
 * `points` is a required `number`, and the callers are what keep the "no score"
 * case honest: a scene with no attempts and a learner with no attempts render no
 * ring at all, because printing "0" would read as a failure they never had.
 */
export function ScoreRing({ points, size = 52, stroke = 5, tone = accents.violet, label }: { points: number; size?: number; stroke?: number; tone?: { fill: string; soft: string; ink: string }; label: string }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const reached = Math.min(100, Math.max(0, points)) / 100;
  return (
    <span role="img" aria-label={`${label}: ${points} of 100`} className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={tone.soft} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={tone.ink} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - reached)} />
      </svg>
      <span className="absolute font-black tabular-nums leading-none" style={{ color: tone.ink, fontSize: Math.round(size * 0.36) }} aria-hidden="true">{points}</span>
    </span>
  );
}

/** The ring plus its caption, the shape both the recap bar and a scene card use. */
export function ScorePill({ points, tone, caption = "Score", size = 30 }: { points: number; tone: { fill: string; soft: string; ink: string }; caption?: string; size?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-2 rounded-full py-1 pl-1 pr-3" style={{ background: tone.soft }}>
      <ScoreRing points={points} size={size} stroke={4} tone={tone} label={caption} />
      <span className="text-[11.5px] font-black" style={{ color: tone.ink }}>{caption}</span>
    </span>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "We couldn't complete that. Please try again.";
}
