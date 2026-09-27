import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Check, ArrowRight } from "lucide-react";
import type { Profile } from "@rehearsal/contracts";
import { useSaveProfile } from "../api/hooks";
import { Pip } from "../components/Artwork";
import { Problem, Shell, errorMessage } from "../components/ui";

const levels = [
  { code: "A2", title: "I can get by.", description: "Short sentences. Please speak slowly." },
  { code: "B1", title: "I can hold a conversation.", description: "I keep up in everyday situations, but I freeze when it matters." },
  { code: "B2", title: "I'm fairly fluent.", description: "I want to sound natural, not just correct." },
] as const;

export function Onboarding({ profile }: { profile: Profile }) {
  const [level, setLevel] = useState<Profile["level"]>(profile.level);
  const save = useSaveProfile();
  const navigate = useNavigate();
  if (profile.onboarded) return <Navigate to="/scenes" replace />;
  const complete = (selected: Profile["level"]) => save.mutate({ data: { level: selected } }, {
    onSuccess: () => navigate("/scenes", { replace: true }),
  });
  return (
    <Shell>
      <div className="mx-auto flex max-w-5xl flex-col items-center pb-8 pt-8 sm:pt-14">
        <div className="-mb-8 z-10"><Pip size={142} mood="cheer" /></div>
        <section className="panel w-full px-5 pb-8 pt-10 text-center sm:rounded-[44px] sm:px-12 sm:py-12">
          <span className="pill bg-teal-soft text-teal-ink">One question. Just for you.</span>
          <h1 className="heading mt-5">What's your English level?</h1>
          <p className="mt-3 font-semibold text-muted">Just this once - it tunes how simply the character speaks to you.</p>
          <fieldset className="mt-8 grid gap-4 text-left md:grid-cols-3">
            <legend className="sr-only">Choose your English level</legend>
            {levels.map(item => (
              <label key={item.code} className={`relative cursor-pointer rounded-[26px] border-[3px] p-6 ${level === item.code ? "border-coral bg-coral-soft/40" : "border-line bg-[#fffaf6]"}`}>
                <input className="peer sr-only" type="radio" name="level" value={item.code} checked={level === item.code} onChange={() => setLevel(item.code)} />
                <span className="absolute inset-[-5px] rounded-[28px] peer-focus-visible:outline-3 peer-focus-visible:outline-violet-ink" />
                {level === item.code && <Check className="absolute right-4 top-4 rounded-full bg-coral p-1 text-ink" size={28} />}
                <span className="block text-3xl font-black">{item.code}</span>
                <span className="mt-2 block text-sm font-extrabold text-body">{item.title}</span>
                <span className="mt-2 block text-sm leading-relaxed text-muted">{item.description}</span>
              </label>
            ))}
          </fieldset>
          {save.error && <Problem message={errorMessage(save.error)} />}
          <button className="button button-primary mt-8 w-full text-base" disabled={save.isPending} onClick={() => complete(level)}>
            {save.isPending ? "Saving your level..." : "Continue"}<ArrowRight size={19} />
          </button>
          <button className="mt-3 min-h-11 text-sm font-bold text-muted underline decoration-line underline-offset-4" disabled={save.isPending} onClick={() => complete("B1")}>Skip for now - use B1</button>
          <p className="mt-2 text-xs font-semibold text-muted">Change it any time in settings. Nothing else to set up.</p>
        </section>
      </div>
    </Shell>
  );
}
