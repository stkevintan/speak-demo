import { Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { useProfile } from "./api/hooks";
import { BackToScenes, Busy, Problem, Shell, errorMessage } from "./components/ui";
import { Onboarding } from "./screens/Onboarding";
import { Progress } from "./screens/Progress";
import { Scenes } from "./screens/Scenes";
import { DebriefScreen } from "./screens/Debrief";

const Live = lazy(() => import("./screens/Live").then(module => ({ default: module.Live })));

export function App() {
  const profile = useProfile();
  if (profile.isPending) return <Shell><Busy>Welcome to Rehearsal...</Busy></Shell>;
  if (!profile.data) return <Shell><Problem message={errorMessage(profile.error)} retry={() => { void profile.refetch(); }} /></Shell>;
  const learner = profile.data;
  return (
    <Suspense fallback={<Shell><Busy>Opening the conversation...</Busy></Shell>}><Routes>
      <Route path="/" element={<Navigate to={learner.onboarded ? "/scenes" : "/onboarding"} replace />} />
      <Route path="/onboarding" element={<Onboarding profile={learner} />} />
      <Route path="/scenes" element={learner.onboarded ? <Scenes profile={learner} /> : <Navigate to="/onboarding" replace />} />
      <Route path="/progress" element={learner.onboarded ? <Progress profile={learner} /> : <Navigate to="/onboarding" replace />} />
      <Route path="/sessions/:sessionId" element={<Live profile={learner} />} />
      <Route path="/sessions/:sessionId/debrief" element={<DebriefScreen profile={learner} />} />
      <Route path="*" element={<Shell><section className="panel"><h1 className="heading mb-5">This scene isn't here</h1><BackToScenes /></section></Shell>} />
    </Routes></Suspense>
  );
}
