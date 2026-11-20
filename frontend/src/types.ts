export type IncidentGroup = 'critical' | 'coordinators' | 'high_priority' | 'research'

export type ChangeKind =
  | 'created'
  | 'updated'
  | 'resolved'
  | 'reopened'
  | 'research_new'
  | 'critical_new'
  | 'coordinator_assigned'
  | 'priority_changed'
  | 'deadline_changed'

export type SlaState = 'ok' | 'warning' | 'danger' | 'breach' | 'none' | 'done'

export type ToastType = 'info' | 'success' | 'warning' | 'critical'

export interface Sla {
  state: SlaState
  timeLeftSeconds: number | null
  totalSeconds: number | null
  overdueSeconds: number | null
}

export interface Incident {
  id: string
  header: string
  shortDescription: string | null
  description: string | null
  solution: string | null
  state: string | null
  stateId: number
  stageId: number | null
  priority: string | null
  priorityId: number
  urgency: string | null
  urgencyId: number | null
  impact: string | null
  impactId: number | null
  submitDate: string | null
  deadline: string | null
  completionDate: string | null
  lastAssignmentToTeamDateTime: string | null
  assignedGroupName: string | null
  assignedEmployee: string | null
  initiatorName: string | null
  receivingChannel: string | null
  incType: string | null
  service: string | null
  serviceType: string | null
  scenarioName: string | null
  productName: string | null
  productUrl: string | null
  isEffect: boolean | null
  isReason: boolean | null
  isDouble: boolean | null
  isMaster: boolean | null
  isRootIncident: boolean | null
  groups: IncidentGroup[]
  sla: Sla
  [key: string]: unknown
}

export interface Kpi {
  open: number
  critical: number
  breached: number
  research: number
  coordinators: number
  resolvedToday: number
}

export interface ByProduct {
  name: string
  count: number
}

export interface ByStatus {
  stateId: number
  state: string
  count: number
}

export interface Shift {
  openedToday: number
  resolvedToday: number
  avgResolutionMinutes: number | null
  topProduct: string | null
  byProduct: ByProduct[]
  byStatus: ByStatus[]
}

export interface Summary {
  generatedAt: string
  kpi: Kpi
  shift: Shift
}

export interface WsChange {
  id: string
  kind: ChangeKind
}

export interface WsSnapshot {
  type: 'snapshot'
  payload: { incidents: Incident[]; summary: Summary; ts: string }
}

export interface WsUpdate {
  type: 'update'
  payload: { incidents: Incident[]; summary: Summary; changes: WsChange[]; ts: string }
}

export type WsMessage = WsSnapshot | WsUpdate

export interface AiSummary {
  text: string
}

export interface AiRisk {
  score: number
  reason: string
}

export interface AiTeam {
  team: string
  reason: string
}
