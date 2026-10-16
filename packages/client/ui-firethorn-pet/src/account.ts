/** Account values exposed by the firethorn pet host route. */
export interface FirethornPetAccount {
  ok: true
  points: number | null
  balance: number
  currency: string
  updatedAt: string
}

/** Error response returned when account data is unavailable. */
export interface FirethornPetAccountError {
  ok: false
  code: string
  error: string
}

/** JSON response accepted by the browser account panel. */
export type FirethornPetAccountResponse = FirethornPetAccount | FirethornPetAccountError

interface AccountValues {
  balance: number
  currency: string
  points: number | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function optionalPoints(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumber(value)
    if (parsed !== undefined) return parsed
  }
  return null
}

/**
 * Parse the DeepSeek balance response without exposing its raw payload.
 * @param payload - The untrusted provider JSON.
 * @returns Valid account values, or undefined when a usable balance is absent.
 */
export function parseDeepSeekBalanceResponse(payload: unknown): AccountValues | undefined {
  const root = record(payload)
  if (root === undefined) return undefined
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos.map(record).filter(
    (value): value is Record<string, unknown> => value !== undefined,
  ) : []
  const info = infos.find(candidate => candidate.currency === 'CNY') ?? infos[0]
  if (info === undefined) return undefined
  const balance = finiteNumber(info.total_balance)
  if (balance === undefined) return undefined
  const currency = typeof info.currency === 'string' && info.currency.length > 0 ? info.currency : 'CNY'
  return {
    balance,
    currency,
    points: optionalPoints(root.points, root.credits, info.points, info.credits),
  }
}

/**
 * Validate the JSON response received by the browser from the host route.
 * @param value - The untrusted host JSON.
 * @returns The validated success or error response, or undefined for invalid fields.
 */
export function parseFirethornPetAccountResponse(value: unknown): FirethornPetAccountResponse | undefined {
  const candidate = record(value)
  const points = candidate?.points === null ? null : finiteNumber(candidate?.points)
  const balance = finiteNumber(candidate?.balance)
  if (candidate?.ok === false
    && typeof candidate.code === 'string'
    && typeof candidate.error === 'string') {
    return { ok: false, code: candidate.code, error: candidate.error }
  }
  if (candidate?.ok !== true
    || points === undefined
    || balance === undefined
    || typeof candidate.currency !== 'string'
    || typeof candidate.updatedAt !== 'string') return undefined
  return {
    ok: true,
    points,
    balance,
    currency: candidate.currency,
    updatedAt: candidate.updatedAt,
  }
}
