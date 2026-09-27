import { Settings2, X } from "lucide-react";
import { useState } from "react";
import type { Profile } from "@rehearsal/contracts";
import { useSaveProfile } from "../api/hooks";
import { Problem, Switch, errorMessage } from "./ui";

export function Settings({ profile, live = false }: { profile: Profile; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const save = useSaveProfile();
  return (
    <div className="relative">
      <button className="icon-button" aria-label="Settings" aria-expanded={open} onClick={() => setOpen(!open)}><Settings2 size={21} /></button>
      {open && (
        <section aria-label="Settings" className="panel absolute right-0 top-14 z-30 w-[min(320px,calc(100vw-32px))] border border-line" onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
          <div className="mb-4 flex items-center justify-between"><h2 className="font-black">Your preferences</h2><button className="icon-button shadow-none" aria-label="Close settings" onClick={() => setOpen(false)}><X size={18} /></button></div>
          <label className="block text-sm font-bold" htmlFor="settings-level">English level</label>
          <select id="settings-level" className="my-2 min-h-11 w-full rounded-xl border border-line p-2" value={profile.level} disabled={save.isPending} onChange={e => {
            const level = e.target.value;
            if (level === "A2" || level === "B1" || level === "B2") save.mutate({ data: { level } });
          }}>
            <option>A2</option><option>B1</option><option>B2</option>
          </select>
          {live && <p className="mb-3 text-xs text-muted">Level changes apply to your next scene.</p>}
          <Switch label="Chinese hints" checked={profile.chinese} disabled={save.isPending} onChange={chinese => save.mutate({ data: { chinese } })} />
          {!live && <Switch label="Suggestions" checked={profile.suggestions} disabled={save.isPending} onChange={suggestions => save.mutate({ data: { suggestions } })} />}
          {save.error && <Problem message={errorMessage(save.error)} />}
        </section>
      )}
    </div>
  );
}
