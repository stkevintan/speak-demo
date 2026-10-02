import { useRef, useState } from "react";
import {
  CourseCard, Debrief, Profile, ProfilePatch, Progress, SessionStart, StartSessionRequest,
} from "@rehearsal/contracts";
import {
  endSession, getGetDebriefQueryKey, getGetMeQueryKey, getListCoursesQueryKey, getGetProgressQueryKey,
  patchMe, startSession, useEndSession, useGetDebrief, useGetMe,
  useGetProgress, useListCourses, usePatchMe, useStartSession, useUnlearnCourse,
} from "@rehearsal/contracts/generated";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useSessionStore } from "../session/store";

export function validate<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error("The server returned data we couldn't understand. Please try again.");
  return result.data;
}

export function useProfile() {
  return useGetMe({ query: { select: (data) => validate(Profile, data), staleTime: 60_000 } });
}

export function useCourses() {
  return useListCourses({ query: { select: (data) => validate(CourseCard.array(), data), staleTime: 60_000 } });
}

/**
 * The goal states are derived by the server (`progressView`, `ARCHITECTURE.md`
 * §5.8), so this screen validates the answer and renders it as-is — it never
 * counts attempts or decides what "ended early" means for itself.
 */
export function useProgress() {
  return useGetProgress({ query: { select: (data) => validate(Progress, data), staleTime: 30_000 } });
}

/**
 * Opening a scene from either the picker or the progress screen. Both send the
 * same request and hand the same grant to the live session, so the two entry
 * points cannot drift into two different definitions of "start a scene".
 */
export function useBeginScene(profile: Profile) {
  const start = useCreateSession();
  const navigate = useNavigate();
  const opening = useRef(false);
  const [startingCourse, setStartingCourse] = useState<string | null>(null);
  const begin = async (course: CourseCard) => {
    if (opening.current) return;
    opening.current = true;
    setStartingCourse(course.id);
    try {
      const grant = await start.mutateAsync({ data: { courseId: course.id } });
      useSessionStore.getState().begin(grant, course, profile);
      start.reset();
      navigate(`/sessions/${encodeURIComponent(grant.sessionId)}`);
    } catch {
      // The generated mutation exposes the failure beside the scene it belongs to.
    } finally {
      opening.current = false;
      setStartingCourse(null);
    }
  };
  return { begin, start, startingCourse };
}

export function useSaveProfile() {
  const client = useQueryClient();
  return usePatchMe({
    mutation: {
      mutationFn: async ({ data }) => validate(Profile, await patchMe(validate(ProfilePatch, data))),
      onSuccess: (profile) => {
        client.setQueryData(getGetMeQueryKey(), profile);
        void client.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      },
    },
  });
}

export function useUnlearn() {
  const client = useQueryClient();
  return useUnlearnCourse({
    mutation: {
      retry: false,
      onSuccess: () => { void client.invalidateQueries({ queryKey: getListCoursesQueryKey() }); },
    },
  });
}

export function useCreateSession() {
  return useStartSession({
    mutation: {
      gcTime: 0,
      retry: false,
      mutationFn: async ({ data }) => validate(SessionStart, await startSession(validate(StartSessionRequest, data))),
    },
  });
}

export function useFinishSession() {
  const client = useQueryClient();
  return useEndSession({
    mutation: {
      retry: false,
      mutationFn: async ({ id }) => validate(Debrief, await endSession(encodeURIComponent(id))),
      onSuccess: (debrief, { id }) => {
        client.setQueryData(getGetDebriefQueryKey(encodeURIComponent(id)), debrief);
        void client.invalidateQueries({ queryKey: getGetMeQueryKey() });
        // The attempt this just closed is part of the progress view now.
        void client.invalidateQueries({ queryKey: getGetProgressQueryKey() });
      },
    },
  });
}

export function useDebrief(id: string) {
  return useGetDebrief(encodeURIComponent(id), {
    query: { select: (data) => validate(Debrief, data), retry: false, refetchOnWindowFocus: true },
  });
}
