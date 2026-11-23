export type WorkflowState = 'active' | 'running' | 'paused' | 'completed' | 'blocked' | 'cancelled'
export type WorkflowRun = {
  id: string
  title: string
  instructions: string
  model: string
  state: WorkflowState
  createdAt: string
  updatedAt: string
  result?: string
  error?: string
}

const STORAGE_KEY = 'localpilot.workflowRuns.v1'
const readRuns = (): WorkflowRun[] => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as WorkflowRun[] } catch { return [] }
}
const writeRuns = (runs: WorkflowRun[]) => localStorage.setItem(STORAGE_KEY, JSON.stringify(runs))

export const loadWorkflowRuns = readRuns
export const activateWorkflow = (run: WorkflowRun) => {
  const runs = readRuns()
  const next = { ...run, state: 'active' as const, updatedAt: new Date().toISOString() }
  writeRuns([next, ...runs.filter(item => item.id !== run.id)])
  return next
}
export const updateWorkflowRun = (id: string, patch: Partial<WorkflowRun>) => {
  const runs = readRuns().map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)
  writeRuns(runs)
  return runs.find(item => item.id === id)
}
