export type JsonRecord = Record<string, unknown>

export class AdminApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly payload: unknown

  constructor(message: string, status: number, code: string | null = null, payload: unknown = null) {
    super(message)
    this.name = 'AdminApiError'
    this.status = status
    this.code = code
    this.payload = payload
  }

  get unsupported() {
    return this.status === 404 || this.status === 405 || this.status === 501
  }

  get unauthorized() {
    return this.status === 401 || this.status === 403
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback
  const candidate = payload.message ?? payload.error ?? payload.detail
  return typeof candidate === 'string' && candidate.trim() ? candidate : fallback
}

function responseCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const candidate = payload.code ?? (isRecord(payload.error) ? payload.error.code : null)
  return typeof candidate === 'string' ? candidate : null
}

async function parseResponse(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return { message: raw.slice(0, 500) }
  }
}

function csrfFrom(payload: unknown, response: Response): string | null {
  const header = response.headers.get('x-csrf-token')
  if (header) return header
  if (!isRecord(payload)) return null
  const direct = payload.csrfToken ?? payload.csrf
  if (typeof direct === 'string' && direct) return direct
  if (isRecord(payload.session)) {
    const nested = payload.session.csrfToken ?? payload.session.csrf
    if (typeof nested === 'string' && nested) return nested
  }
  return null
}

/**
 * Auth state deliberately lives only in this instance. The session itself is
 * an HttpOnly cookie and the CSRF value is never written to browser storage.
 */
class AdminApi {
  private csrfToken: string | null = null

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    if (method !== 'GET' && method !== 'HEAD' && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken)
    }

    let response: Response
    try {
      response = await fetch(path, {
        ...init,
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
      })
    } catch {
      throw new AdminApiError('The admin API could not be reached.', 0, 'NETWORK_ERROR')
    }

    const payload = await parseResponse(response)
    const nextCsrf = csrfFrom(payload, response)
    if (nextCsrf) this.csrfToken = nextCsrf

    if (!response.ok) {
      if (response.status === 401) this.csrfToken = null
      throw new AdminApiError(
        responseMessage(payload, `Admin API request failed (${response.status}).`),
        response.status,
        responseCode(payload),
        payload,
      )
    }
    return payload
  }

  session() {
    return this.request('/api/admin/auth/session')
  }

  login(username: string, password: string) {
    return this.request('/api/admin/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async logout() {
    try {
      return await this.request('/api/admin/auth/logout', { method: 'POST', body: '{}' })
    } finally {
      this.csrfToken = null
    }
  }

  get(path: string) {
    return this.request(`/api/admin/${path.replace(/^\/+/, '')}`)
  }

  post(path: string, body: JsonRecord) {
    return this.request(`/api/admin/${path.replace(/^\/+/, '')}`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  clearMemory() {
    this.csrfToken = null
  }
}

export const adminApi = new AdminApi()

export function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

export function unwrapData(value: unknown): unknown {
  const record = asRecord(value)
  if ('data' in record && Object.keys(record).length <= 4) return record.data
  return value
}

export function rowsFrom(value: unknown, keys: readonly string[]): JsonRecord[] {
  const unwrapped = unwrapData(value)
  if (Array.isArray(unwrapped)) return unwrapped.filter(isRecord)
  const record = asRecord(unwrapped)
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) return candidate.filter(isRecord)
  }
  return []
}

