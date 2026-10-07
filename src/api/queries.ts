import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import {
  exportSettings,
  fetchState,
  patchState,
  persistState,
  resetMockState,
} from './client'
import type { AppState } from '@/types/domain'

export const appStateQueryKey = ['grid-protection-state'] as const

export function useAppStateQuery() {
  return useQuery({
    queryKey: appStateQueryKey,
    queryFn: fetchState,
    staleTime: 30_000,
  })
}

export function usePersistStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (state: AppState) => persistState(state),
    onSuccess: (state) => queryClient.setQueryData(appStateQueryKey, state),
  })
}

export function usePatchStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<AppState>) => patchState(patch),
    onSuccess: (state) => queryClient.setQueryData(appStateQueryKey, state),
  })
}

export function useResetStateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: resetMockState,
    onSuccess: (state) => queryClient.setQueryData(appStateQueryKey, state),
  })
}

export function useExportMutation() {
  return useMutation({
    mutationFn: exportSettings,
  })
}

export function useIssueStats() {
  const query = useAppStateQuery()
  return computed(() => {
    const issues = query.data.value?.issues ?? []
    return {
      total: issues.length,
      high: issues.filter((issue) => issue.level === 'high').length,
      open: issues.filter((issue) => issue.status !== 'closed').length,
    }
  })
}
