import type { AiRisk, AiSummary, AiTeam, Incident, Summary } from './types'

export interface IncidentsResponse {
  generatedAt: string
  incidents: Incident[]
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} при запросе ${url}`)
  return (await res.json()) as T
}

export async function fetchIncidents(): Promise<IncidentsResponse> {
  const data = await getJson<IncidentsResponse>('/api/incidents')
  if (!Array.isArray(data.incidents)) throw new Error('Некорректный ответ /api/incidents: incidents не является массивом')
  return data
}

export async function fetchSummary(): Promise<Summary> {
  const data = await getJson<Summary>('/api/summary')
  if (typeof data !== 'object' || data === null || typeof data.kpi !== 'object' || data.kpi === null) {
    throw new Error('Некорректный ответ /api/summary: отсутствует блок kpi')
  }
  return data
}

export function fetchAiSummary(id: string): Promise<AiSummary> {
  return getJson<AiSummary>(`/api/ai/incidents/${encodeURIComponent(id)}/summary`)
}

export function fetchAiRisk(id: string): Promise<AiRisk> {
  return getJson<AiRisk>(`/api/ai/incidents/${encodeURIComponent(id)}/risk`)
}

export function fetchAiTeam(id: string): Promise<AiTeam> {
  return getJson<AiTeam>(`/api/ai/incidents/${encodeURIComponent(id)}/recommend-team`)
}
