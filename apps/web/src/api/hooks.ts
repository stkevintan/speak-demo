import {
  CourseCard, Debrief, Profile, ProfilePatch, SessionStart, StartSessionRequest,
} from "@rehearsal/contracts";
import {
  endSession, getGetDebriefQueryKey, getGetMeQueryKey, getListCoursesQueryKey,
  patchMe, startSession, useEndSession, useGetDebrief, useGetMe,
  useListCourses, usePatchMe, useStartSession, useUnlearnCourse,
} from "@rehearsal/contracts/generated";
import { useQueryClient } from "@tanstack/react-query";

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
      },
    },
  });
}

export function useDebrief(id: string) {
  return useGetDebrief(encodeURIComponent(id), {
    query: { select: (data) => validate(Debrief, data), retry: false, refetchOnWindowFocus: true },
  });
}
