import axios, {
  type AxiosAdapter,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import type { AppState } from '@/types/domain'
import { exportSettingsText, loadState, resetState, saveState } from '@/services/storage'

type MockRequest = {
  state?: AppState
  patch?: Partial<AppState>
  action?: 'reset' | 'export'
}

function ok<T>(config: AxiosRequestConfig, data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: config as AxiosResponse<T>['config'],
  }
}

const mockAdapter: AxiosAdapter = async (config) => {
  await new Promise((resolve) => window.setTimeout(resolve, 180))
  const payload = JSON.parse((config.data as string | undefined) ?? '{}') as MockRequest
  if (config.url === '/state' && config.method === 'get') {
    return ok(config, loadState())
  }
  if (config.url === '/state' && config.method === 'post') {
    const next = payload.state ?? loadState()
    saveState(next)
    return ok(config, next)
  }
  if (config.url === '/state/patch' && config.method === 'post') {
    const state = { ...loadState(), ...payload.patch }
    saveState(state)
    return ok(config, state)
  }
  if (config.url === '/actions/reset' && config.method === 'post') {
    return ok(config, resetState())
  }
  if (config.url === '/actions/export' && config.method === 'post') {
    return ok(config, { content: exportSettingsText(loadState()) })
  }
  return Promise.reject(new Error(`未实现的本地接口：${config.method} ${config.url}`))
}

export const http = axios.create({
  baseURL: '/api',
  adapter: mockAdapter,
  headers: { 'Content-Type': 'application/json' },
})

export async function fetchState(): Promise<AppState> {
  const response = await http.get<AppState>('/state')
  return response.data
}

export async function persistState(state: AppState): Promise<AppState> {
  const response = await http.post<AppState>('/state', { state })
  return response.data
}

export async function patchState(patch: Partial<AppState>): Promise<AppState> {
  const response = await http.post<AppState>('/state/patch', { patch })
  return response.data
}

export async function resetMockState(): Promise<AppState> {
  const response = await http.post<AppState>('/actions/reset')
  return response.data
}

export async function exportSettings(): Promise<string> {
  const response = await http.post<{ content: string }>('/actions/export')
  return response.data.content
}
