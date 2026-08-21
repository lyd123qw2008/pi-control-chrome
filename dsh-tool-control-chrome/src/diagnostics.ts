/** Shared Bridge recovery metadata used by DSH tools and human commands. */

export type BridgeRecovery = {
  readonly available: boolean
  readonly authority: 'local_user' | 'unknown'
  readonly controlDomain: 'local_user'
  readonly method: 'cooperative_restart' | 'unavailable'
  readonly requiresUserConfirmation: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Derive recovery availability from the Bridge protocol capability, not its launcher label. */
export function bridgeRecovery(health: Record<string, unknown>): BridgeRecovery {
  const restart = isRecord(health.restart) ? health.restart : undefined
  const capabilities = isRecord(health.capabilities) ? health.capabilities : undefined
  const available = restart?.available === true && capabilities?.cooperativeRestart === true
  return {
    available,
    authority: available ? 'local_user' : 'unknown',
    controlDomain: 'local_user',
    method: available ? 'cooperative_restart' : 'unavailable',
    requiresUserConfirmation: !available,
  }
}

/** Return the recovery contract used when no Bridge health document is available. */
export function unavailableBridgeRecovery(): BridgeRecovery {
  return {
    available: false,
    authority: 'unknown',
    controlDomain: 'local_user',
    method: 'unavailable',
    requiresUserConfirmation: true,
  }
}
