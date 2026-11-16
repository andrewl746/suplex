import { WARMUP_URL } from './config'

/** GET /warmup on the live server (deploy/server/serve.py): how far its start-up is. */
export interface WarmupStatus {
  ready: boolean
  /** 0 to 1: the share of the start-up that is done. */
  progress: number
  /** 0 to 1: where the step it is on ends. */
  until: number
  /** The step it is on: a key of labels.warmup.steps. */
  step: string
  error: string | null
}

const READY: WarmupStatus = { ready: true, progress: 1, until: 1, step: 'ready', error: null }

function isStatus(body: unknown): body is WarmupStatus {
  const b = body as Partial<WarmupStatus> | null
  return (
    typeof b?.ready === 'boolean' &&
    typeof b.progress === 'number' &&
    typeof b.until === 'number' &&
    typeof b.step === 'string'
  )
}

/**
 * The server's status. A host with nothing at the address counts as ready, so the app is never held
 * back by a status it cannot read. A server that is still starting (no answer, or an error from the
 * proxy in front of it) rejects, and the caller asks again.
 */
export async function fetchWarmup(signal?: AbortSignal): Promise<WarmupStatus> {
  if (WARMUP_URL === null) return READY
  const response = await fetch(WARMUP_URL, { cache: 'no-store', signal })
  if (response.status === 404) return READY
  if (!response.ok) throw new Error(`warmup answered ${response.status}`)
  const body: unknown = await response.json().catch(() => null)
  return isStatus(body) ? body : READY
}
