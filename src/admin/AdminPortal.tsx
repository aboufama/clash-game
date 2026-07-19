import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  AdminApiError,
  adminApi,
  asRecord,
  rowsFrom,
  unwrapData,
  type JsonRecord,
} from './api'
import './AdminPortal.css'

type ViewId = 'overview' | 'players' | 'economy' | 'combat' | 'world' | 'liveops' | 'audit' | 'security'
type LoadState =
  | { kind: 'loading'; data?: unknown }
  | { kind: 'ready'; data: unknown }
  | { kind: 'empty'; data: unknown }
  | { kind: 'unsupported'; message: string }
  | { kind: 'error'; message: string }

interface AdminIdentity {
  username: string
  role: string
}

interface NavItem {
  id: ViewId
  label: string
  eyebrow: string
  glyph: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: 'Command', eyebrow: 'Live overview', glyph: 'CM' },
  { id: 'players', label: 'Players', eyebrow: 'Support & safety', glyph: 'PL' },
  { id: 'economy', label: 'Economy', eyebrow: 'Sources & sinks', glyph: 'EC' },
  { id: 'combat', label: 'Combat', eyebrow: 'Raids & replays', glyph: 'CB' },
  { id: 'world', label: 'World & bots', eyebrow: 'Persistent villages', glyph: 'WB' },
  { id: 'liveops', label: 'Live operations', eyebrow: 'Global controls', glyph: 'LO' },
  { id: 'audit', label: 'Audit trail', eyebrow: 'Accountability', glyph: 'AU' },
  { id: 'security', label: 'Security & config', eyebrow: 'Runtime posture', glyph: 'SC' },
]

const VIEW_IDS = new Set<ViewId>(NAV_ITEMS.map(item => item.id))

function routeView(): ViewId {
  const segment = window.location.pathname.split('/').filter(Boolean)[1]
  return segment && VIEW_IDS.has(segment as ViewId) ? segment as ViewId : 'overview'
}

function isObjectEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function useAdminData(path: string, onUnauthorized: () => void) {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let current = true
    setState(previous => ({ kind: 'loading', data: 'data' in previous ? previous.data : undefined }))
    adminApi.get(path).then(payload => {
      if (!current) return
      const data = unwrapData(payload)
      setState(isObjectEmpty(data) ? { kind: 'empty', data } : { kind: 'ready', data })
    }).catch((error: unknown) => {
      if (!current) return
      if (error instanceof AdminApiError && error.unauthorized) {
        onUnauthorized()
        return
      }
      if (error instanceof AdminApiError && error.unsupported) {
        setState({ kind: 'unsupported', message: error.message })
        return
      }
      setState({ kind: 'error', message: error instanceof Error ? error.message : 'This admin view could not be loaded.' })
    })
    return () => { current = false }
  }, [nonce, onUnauthorized, path])

  return { state, reload: () => setNonce(value => value + 1) }
}

function recordAt(value: unknown, path: readonly string[]): JsonRecord {
  let cursor: unknown = value
  for (const key of path) cursor = asRecord(cursor)[key]
  return asRecord(cursor)
}

function valueAt(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value
  for (const key of path) cursor = asRecord(cursor)[key]
  return cursor
}

function firstValue(value: unknown, paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    const candidate = valueAt(value, path)
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate
  }
  return undefined
}

function numberValue(value: unknown, paths: readonly (readonly string[])[], fallback = 0): number {
  const candidate = Number(firstValue(value, paths))
  return Number.isFinite(candidate) ? candidate : fallback
}

function textValue(value: unknown, keys: readonly string[], fallback = '—'): string {
  const record = asRecord(value)
  for (const key of keys) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return fallback
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const fullNumber = new Intl.NumberFormat()

function formatMetric(value: unknown, compact = true): string {
  const number = Number(value)
  if (Number.isFinite(number)) return (compact ? compactNumber : fullNumber).format(number)
  return typeof value === 'string' && value ? value : '—'
}

function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const numeric = typeof value === 'number' ? value : Number.NaN
  const date = new Date(Number.isFinite(numeric) && numeric < 10_000_000_000 ? numeric * 1000 : value as string | number)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

function formatWorldDay(value: unknown): string {
  const day = Number(value)
  if (!Number.isInteger(day)) return '—'
  return new Date(day * 86_400_000).toLocaleDateString()
}

function idOf(row: unknown): string {
  return textValue(row, ['id', 'playerId', 'accountId', 'ownerId'], '')
}

function redactSecrets(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested data]'
  if (Array.isArray(input)) return input.slice(0, 100).map(item => redactSecrets(item, depth + 1))
  if (!input || typeof input !== 'object') return input
  return Object.fromEntries(Object.entries(input).map(([key, child]) => [
    key,
    /(password|secret|token|csrf|cookie|credential|hash)/i.test(key) ? '[redacted]' : redactSecrets(child, depth + 1),
  ]))
}

function redactedJson(value: unknown): string {
  return JSON.stringify(redactSecrets(value), null, 2)
}

function sessionIdentity(payload: unknown): AdminIdentity | null {
  const root = asRecord(unwrapData(payload))
  const user = asRecord(root.user ?? root.admin ?? root.session)
  if (root.authenticated === false || root.ok === false) return null
  const username = textValue(user, ['username', 'name'], textValue(root, ['username'], ''))
  if (!username && root.authenticated !== true) return null
  return { username: username || 'admin', role: textValue(user, ['role'], textValue(root, ['role'], 'administrator')) }
}

function SectionHeading({ eyebrow, title, children, actions }: {
  eyebrow: string
  title: string
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="admin-section-heading">
      <div>
        <span className="admin-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{children}</p>
      </div>
      {actions ? <div className="admin-heading-actions">{actions}</div> : null}
    </header>
  )
}

function StateSurface({ state, onRetry, children }: {
  state: LoadState
  onRetry: () => void
  children: (data: unknown) => ReactNode
}) {
  if (state.kind === 'loading' && state.data === undefined) {
    return <div className="admin-state"><span className="admin-spinner" aria-hidden="true" /><strong>Loading secure data…</strong></div>
  }
  if (state.kind === 'unsupported') {
    return (
      <div className="admin-state admin-state-muted">
        <span className="admin-state-mark">N/A</span>
        <strong>This capability is not enabled by the deployed server.</strong>
        <p>{state.message}</p>
      </div>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="admin-state admin-state-error" role="alert">
        <span className="admin-state-mark">!</span>
        <strong>Unable to load this view</strong>
        <p>{state.message}</p>
        <button className="admin-button admin-button-secondary" type="button" onClick={onRetry}>Try again</button>
      </div>
    )
  }
  if (state.kind === 'empty') {
    return (
      <div className="admin-state admin-state-muted">
        <span className="admin-state-mark">0</span>
        <strong>No records yet</strong>
        <p>The endpoint is available, but it has no data to show.</p>
        <button className="admin-button admin-button-secondary" type="button" onClick={onRetry}>Refresh</button>
      </div>
    )
  }
  return <>{children(state.data)}</>
}

function StatusPill({ value, goodWhen = true }: { value: unknown; goodWhen?: boolean }) {
  const normalized = String(value ?? 'unknown').toLowerCase()
  const positive = typeof value === 'boolean'
    ? value === goodWhen
    : ['ok', 'online', 'healthy', 'active', 'complete', 'completed', 'ready', 'success', 'true'].includes(normalized)
  const negative = ['error', 'offline', 'unhealthy', 'failed', 'failure', 'banned', 'suspended', 'false'].includes(normalized)
  return <span className={`admin-pill ${positive ? 'is-good' : negative ? 'is-bad' : ''}`}>{String(value ?? 'unknown')}</span>
}

function MetricCard({ label, value, detail, tone = 'gold' }: {
  label: string
  value: unknown
  detail: string
  tone?: 'gold' | 'green' | 'blue' | 'red'
}) {
  return (
    <article className={`admin-metric tone-${tone}`}>
      <span>{label}</span>
      <strong>{formatMetric(value)}</strong>
      <small>{detail}</small>
    </article>
  )
}

function Panel({ title, eyebrow, children, className = '' }: {
  title: string
  eyebrow?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`admin-panel ${className}`}>
      <header className="admin-panel-heading">
        <div>{eyebrow ? <span>{eyebrow}</span> : null}<h2>{title}</h2></div>
      </header>
      {children}
    </section>
  )
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return <button className="admin-button admin-button-secondary" type="button" onClick={onClick} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh data'}</button>
}

function OverviewView({ onUnauthorized, goTo }: { onUnauthorized: () => void; goTo: (view: ViewId) => void }) {
  const { state, reload } = useAdminData('overview', onUnauthorized)
  return (
    <>
      <SectionHeading eyebrow="Realm command" title="Operations overview" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>
        Current player, world, economy, and service health at a glance.
      </SectionHeading>
      <StateSurface state={state} onRetry={reload}>{data => {
        const attacks = recordAt(data, ['attacks'])
        const activeAttacks = Number(attacks.active ?? (
          Number(attacks.preparing ?? 0)
          + Number(attacks.engaged ?? 0)
          + Number(attacks.finalizing ?? 0)
        ))
        const moderated = numberValue(data, [['moderation', 'suspended']]) + numberValue(data, [['moderation', 'banned']])
        const maintenance = data && asRecord(data).maintenance === true
        return (
          <div className="admin-stack">
            <div className="admin-metric-grid">
              <MetricCard label="Total players" value={firstValue(data, [['players', 'total'], ['totalPlayers'], ['metrics', 'players']])} detail="Registered and guest accounts" />
              <MetricCard label="Online now" value={firstValue(data, [['players', 'online'], ['onlinePlayers'], ['metrics', 'online']])} detail="Active sessions" tone="green" />
              <MetricCard label="Persistent bots" value={firstValue(data, [['villages', 'botVillages'], ['bots', 'total'], ['botVillages']])} detail="Stored world villages" tone="blue" />
              <MetricCard label="Open attacks" value={activeAttacks} detail="Across lifecycle states" tone="red" />
              <MetricCard label="Gold in circulation" value={firstValue(data, [['economy', 'gold'], ['economy', 'circulatingGold'], ['goldCirculation']])} detail="Player-held balance" />
              <MetricCard label="Moderated accounts" value={moderated} detail="Suspended or banned" tone={moderated ? 'red' : 'green'} />
            </div>

            <div className="admin-two-column">
              <Panel title="Realm posture" eyebrow="Authoritative snapshot">
                <div className="admin-service-list">
                  <div className="admin-service-row"><div><strong>Admin API</strong><small>Snapshot generated {formatDate(asRecord(data).generatedAt)}</small></div><StatusPill value="healthy" /></div>
                  <div className="admin-service-row"><div><strong>Player traffic</strong><small>{maintenance ? 'Only operators should be admitted' : 'Normal game traffic is admitted'}</small></div><StatusPill value={maintenance ? 'maintenance' : 'online'} /></div>
                  <div className="admin-service-row"><div><strong>Bot persistence</strong><small>Server-owned durable villages</small></div><StatusPill value="ready" /></div>
                </div>
              </Panel>
              <Panel title="Account & world mix" eyebrow="Current totals">
                <dl className="admin-definition-list">
                  <div><dt>Registered / guests</dt><dd>{formatMetric(valueAt(data, ['players', 'registered']), false)} / {formatMetric(valueAt(data, ['players', 'guests']), false)}</dd></div>
                  <div><dt>Player villages</dt><dd>{formatMetric(valueAt(data, ['villages', 'playerVillages']), false)}</dd></div>
                  <div><dt>Average trophies</dt><dd>{formatMetric(valueAt(data, ['economy', 'averageTrophies']), false)}</dd></div>
                  <div><dt>Ore / food</dt><dd>{formatMetric(valueAt(data, ['economy', 'ore']))} / {formatMetric(valueAt(data, ['economy', 'food']))}</dd></div>
                </dl>
              </Panel>
            </div>

            <Panel title="Operator shortcuts" eyebrow="High-frequency workflows">
              <div className="admin-shortcuts">
                <button type="button" onClick={() => goTo('players')}><strong>Find a player</strong><span>Account support, balances, access, and sessions</span></button>
                <button type="button" onClick={() => goTo('liveops')}><strong>Live operations</strong><span>Maintenance mode and global shield controls</span></button>
                <button type="button" onClick={() => goTo('world')}><strong>Inspect persistent bots</strong><span>World coordinates, provenance, and revisions</span></button>
                <button type="button" onClick={() => goTo('audit')}><strong>Review audit trail</strong><span>Every sensitive operator action with its reason</span></button>
              </div>
            </Panel>
          </div>
        )
      }}</StateSurface>
    </>
  )
}

type PlayerAction = 'adjust_resources' | 'set_trophies' | 'set_shield' | 'rename' | 'revoke_sessions' | 'set_access' | 'send_notice'

const PLAYER_ACTIONS: readonly { type: PlayerAction; label: string; detail: string; danger?: boolean }[] = [
  { type: 'adjust_resources', label: 'Adjust resources', detail: 'Apply explicit gold, ore, and food deltas.' },
  { type: 'set_trophies', label: 'Set trophies', detail: 'Correct the authoritative trophy count.' },
  { type: 'set_shield', label: 'Set shield', detail: 'Grant or remove attack protection.' },
  { type: 'rename', label: 'Rename player', detail: 'Change the public village username.' },
  { type: 'send_notice', label: 'Send notice', detail: 'Deliver a support or moderation message.' },
  { type: 'revoke_sessions', label: 'Revoke sessions', detail: 'Sign the player out of every device.', danger: true },
  { type: 'set_access', label: 'Change access', detail: 'Activate, suspend, or ban the account.', danger: true },
]

function DialogFrame({ title, subtitle, children, onClose }: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  return (
    <div className="admin-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-dialog-title">
        <header><div><span className="admin-eyebrow">Audited action</span><h2 id="admin-dialog-title">{title}</h2><p>{subtitle}</p></div><button className="admin-icon-button" type="button" onClick={onClose} aria-label="Close dialog">×</button></header>
        {children}
      </section>
    </div>
  )
}

function PlayerActionDialog({ action, player, onClose, onComplete, onUnauthorized }: {
  action: PlayerAction
  player: JsonRecord
  onClose: () => void
  onComplete: (message: string) => void
  onUnauthorized: () => void
}) {
  const playerId = idOf(player)
  const playerName = textValue(player, ['username', 'name'], playerId)
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [goldDelta, setGoldDelta] = useState('0')
  const [oreDelta, setOreDelta] = useState('0')
  const [foodDelta, setFoodDelta] = useState('0')
  const [trophies, setTrophies] = useState(String(Number(player.trophies ?? 0)))
  const [shieldMinutes, setShieldMinutes] = useState('60')
  const [newUsername, setNewUsername] = useState(playerName)
  const [noticeTitle, setNoticeTitle] = useState('Message from the Realm team')
  const [message, setMessage] = useState('')
  const [noticeSeverity, setNoticeSeverity] = useState('info')
  const [access, setAccess] = useState(String(player.access ?? 'active'))
  const [accessUntil, setAccessUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { reasonRef.current?.focus() }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (reason.trim().length < 8 || confirmation !== 'CONFIRM') return
    const body: JsonRecord = { type: action, reason: reason.trim() }
    if (action === 'adjust_resources') {
      body.gold = Number(goldDelta)
      body.ore = Number(oreDelta)
      body.food = Number(foodDelta)
    } else if (action === 'set_trophies') body.trophies = Number(trophies)
    else if (action === 'set_shield') {
      const minutes = Math.max(0, Number(shieldMinutes))
      body.until = minutes === 0 ? null : Date.now() + minutes * 60_000
    } else if (action === 'rename') body.username = newUsername.trim()
    else if (action === 'send_notice') {
      body.title = noticeTitle.trim()
      body.message = message.trim()
      body.severity = noticeSeverity
    }
    else if (action === 'set_access') {
      body.state = access
      body.until = access === 'suspended' && accessUntil ? new Date(accessUntil).getTime() : null
    }
    setBusy(true)
    setError(null)
    try {
      await adminApi.post(`players/${encodeURIComponent(playerId)}/actions`, body)
      onComplete(`${PLAYER_ACTIONS.find(item => item.type === action)?.label ?? 'Action'} completed for ${playerName}.`)
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.unauthorized) onUnauthorized()
      else setError(caught instanceof Error ? caught.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  const valid = reason.trim().length >= 8 && confirmation === 'CONFIRM' && playerId.length > 0
  return (
    <DialogFrame title={PLAYER_ACTIONS.find(item => item.type === action)?.label ?? 'Player action'} subtitle={`Target: ${playerName} · ${playerId}`} onClose={onClose}>
      <form className="admin-action-form" onSubmit={submit}>
        {action === 'adjust_resources' ? (
          <div className="admin-field-grid three">
            <label><span>Gold delta</span><input type="number" value={goldDelta} onChange={event => setGoldDelta(event.target.value)} /></label>
            <label><span>Ore delta</span><input type="number" value={oreDelta} onChange={event => setOreDelta(event.target.value)} /></label>
            <label><span>Food delta</span><input type="number" value={foodDelta} onChange={event => setFoodDelta(event.target.value)} /></label>
          </div>
        ) : null}
        {action === 'set_trophies' ? <label><span>Authoritative trophy count</span><input type="number" min="0" value={trophies} onChange={event => setTrophies(event.target.value)} /></label> : null}
        {action === 'set_shield' ? <label><span>Shield duration in minutes (0 removes)</span><input type="number" min="0" value={shieldMinutes} onChange={event => setShieldMinutes(event.target.value)} /></label> : null}
        {action === 'rename' ? <label><span>New username</span><input minLength={3} maxLength={18} value={newUsername} onChange={event => setNewUsername(event.target.value)} /></label> : null}
        {action === 'send_notice' ? <><div className="admin-field-grid"><label><span>Notice title</span><input maxLength={80} value={noticeTitle} onChange={event => setNoticeTitle(event.target.value)} /></label><label><span>Severity</span><select value={noticeSeverity} onChange={event => setNoticeSeverity(event.target.value)}><option value="info">Information</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label></div><label><span>Notice to player</span><textarea rows={4} maxLength={500} value={message} onChange={event => setMessage(event.target.value)} /></label></> : null}
        {action === 'set_access' ? (
          <div className="admin-field-grid">
            <label><span>Access state</span><select value={access} onChange={event => setAccess(event.target.value)}><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option></select></label>
            <label><span>Until (blank is indefinite)</span><input type="datetime-local" value={accessUntil} onChange={event => setAccessUntil(event.target.value)} /></label>
          </div>
        ) : null}
        <label><span>Required reason</span><textarea ref={reasonRef} rows={3} minLength={8} maxLength={500} placeholder="Explain why this intervention is necessary…" value={reason} onChange={event => setReason(event.target.value)} required /><small>Written permanently to the audit trail. Minimum 8 characters.</small></label>
        <label><span>Type CONFIRM to authorize</span><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="CONFIRM" required /></label>
        {error ? <div className="admin-form-error" role="alert">{error}</div> : null}
        <footer><button className="admin-button admin-button-secondary" type="button" onClick={onClose}>Cancel</button><button className="admin-button admin-button-danger" type="submit" disabled={!valid || busy}>{busy ? 'Applying…' : 'Authorize action'}</button></footer>
      </form>
    </DialogFrame>
  )
}

function PlayerDetail({ playerId, fallback, onClose, onUnauthorized, onChanged }: {
  playerId: string
  fallback: JsonRecord
  onClose: () => void
  onUnauthorized: () => void
  onChanged: () => void
}) {
  const { state, reload } = useAdminData(`players/${encodeURIComponent(playerId)}`, onUnauthorized)
  const [action, setAction] = useState<PlayerAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const data = state.kind === 'ready' ? asRecord(state.data) : fallback
  const resources = asRecord(data.resources ?? asRecord(data.world).resources)
  const profile = asRecord(data.profile ?? data.account)
  const world = asRecord(data.world)
  const revisions = asRecord(data.revisions)
  return (
    <aside className="admin-player-drawer" aria-label="Player details">
      <header>
        <div><span className="admin-eyebrow">Player record</span><h2>{textValue(data, ['username', 'name'], playerId)}</h2><code>{playerId}</code></div>
        <button type="button" className="admin-icon-button" onClick={onClose} aria-label="Close player details">×</button>
      </header>
      {state.kind === 'error' ? <div className="admin-form-error">Detail request failed; showing list data. <button type="button" onClick={reload}>Retry</button></div> : null}
      {notice ? <div className="admin-success" role="status">{notice}</div> : null}
      <div className="admin-detail-scroll">
        <div className="admin-detail-metrics">
          <div><span>Trophies</span><strong>{formatMetric(data.trophies, false)}</strong></div>
          <div><span>Gold</span><strong>{formatMetric(resources.gold ?? data.gold)}</strong></div>
          <div><span>Ore</span><strong>{formatMetric(resources.ore ?? data.ore)}</strong></div>
          <div><span>Food</span><strong>{formatMetric(resources.food ?? data.food)}</strong></div>
          <div><span>Sessions</span><strong>{formatMetric(data.activeSessions, false)}</strong></div>
          <div><span>Active raids</span><strong>{formatMetric(data.activeAttacks, false)}</strong></div>
          <div><span>Buildings</span><strong>{formatMetric(data.buildingCount, false)}</strong></div>
          <div><span>Population</span><strong>{formatMetric(data.population, false)}</strong></div>
        </div>
        <dl className="admin-definition-list">
          <div><dt>Access</dt><dd><StatusPill value={data.access ?? profile.access ?? data.status ?? 'active'} /></dd></div>
          <div><dt>Registered</dt><dd>{formatDate(data.createdAt ?? profile.createdAt)}</dd></div>
          <div><dt>Last seen</dt><dd>{formatDate(data.lastSeenAt ?? profile.lastSeenAt ?? data.updatedAt)}</dd></div>
          <div><dt>Plot</dt><dd>{world.worldId ? `${textValue(world, ['worldId'], '?')} · ` : ''}{textValue(world, ['x'], textValue(data, ['plotX'], '?'))}, {textValue(world, ['y'], textValue(data, ['plotY'], '?'))}</dd></div>
          <div><dt>Shield until</dt><dd>{formatDate(data.shieldUntil ?? profile.shieldUntil)}</dd></div>
          <div><dt>Access until</dt><dd>{formatDate(data.accessUntil)}</dd></div>
          <div><dt>Moderation reason</dt><dd>{textValue(data, ['moderationReason'], '—')}</dd></div>
          <div><dt>Revisions</dt><dd>P {formatMetric(revisions.profile, false)} · E {formatMetric(revisions.economy, false)} · L {formatMetric(revisions.layout, false)}</dd></div>
        </dl>
        <div className="admin-action-grid">
          {PLAYER_ACTIONS.map(item => <button className={item.danger ? 'is-danger' : ''} type="button" key={item.type} onClick={() => setAction(item.type)}><strong>{item.label}</strong><span>{item.detail}</span></button>)}
        </div>
      </div>
      {action ? <PlayerActionDialog action={action} player={data} onClose={() => setAction(null)} onUnauthorized={onUnauthorized} onComplete={message => { setAction(null); setNotice(message); reload(); onChanged() }} /> : null}
    </aside>
  )
}

function PlayersView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [queryDraft, setQueryDraft] = useState('')
  const [statusDraft, setStatusDraft] = useState('all')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const params = useMemo(() => {
    const search = new URLSearchParams({ limit: '100' })
    if (query) search.set('q', query)
    return search.toString()
  }, [query])
  const { state, reload } = useAdminData(`players?${params}`, onUnauthorized)
  const [selected, setSelected] = useState<JsonRecord | null>(null)
  const rows = state.kind === 'ready'
    ? rowsFrom(state.data, ['players', 'items', 'results']).filter(player => status === 'all' || String(player.access ?? 'active') === status)
    : []
  return (
    <>
      <SectionHeading eyebrow="Player support" title="Players & accounts" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>
        Search account state, inspect authoritative balances, and perform fully audited interventions.
      </SectionHeading>
      <Panel title="Player directory" eyebrow={`${rows.length} loaded`}>
        <form className="admin-filter-bar" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); setStatus(statusDraft) }}>
          <label className="admin-search-field"><span className="sr-only">Search player ID or username</span><input type="search" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} placeholder="Search username or player ID…" /></label>
          <label><span className="sr-only">Filter account access</span><select value={statusDraft} onChange={event => setStatusDraft(event.target.value)}><option value="all">All access states</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="banned">Banned</option></select></label>
          <button className="admin-button" type="submit">Search</button>
        </form>
        <StateSurface state={state} onRetry={reload}>{data => {
          const playerRows = rowsFrom(data, ['players', 'items', 'results']).filter(player => status === 'all' || String(player.access ?? 'active') === status)
          if (!playerRows.length) return <p className="admin-inline-empty">No players match these filters.</p>
          return (
            <div className="admin-table-wrap"><table><thead><tr><th>Player</th><th>Access</th><th>Trophies</th><th>Resources</th><th>Plot</th><th>Last seen</th><th><span className="sr-only">Open</span></th></tr></thead><tbody>
              {playerRows.map((player, index) => {
                const resources = asRecord(player.resources)
                const playerId = idOf(player)
                const world = asRecord(player.world)
                return <tr key={playerId || index}><td><strong>{textValue(player, ['username', 'name'], 'Unnamed')}</strong><code>{playerId || 'no id'}</code></td><td><StatusPill value={player.access ?? player.status ?? 'active'} /></td><td>{formatMetric(player.trophies, false)}</td><td><span className="admin-resource-line">{Object.keys(resources).length ? `G ${formatMetric(resources.gold)} · O ${formatMetric(resources.ore)} · F ${formatMetric(resources.food)}` : 'Inspect for balances'}</span></td><td>{world.worldId ? `${textValue(world, ['worldId'], '?')} · ` : ''}{textValue(world, ['x'], '?')}, {textValue(world, ['y'], '?')}</td><td>{formatDate(player.lastSeenAt ?? player.updatedAt)}</td><td><button className="admin-table-action" type="button" onClick={() => setSelected(player)} disabled={!playerId}>Inspect</button></td></tr>
              })}
            </tbody></table></div>
          )
        }}</StateSurface>
      </Panel>
      {selected ? <PlayerDetail playerId={idOf(selected)} fallback={selected} onClose={() => setSelected(null)} onUnauthorized={onUnauthorized} onChanged={reload} /> : null}
    </>
  )
}

function ResourceBars({ data }: { data: unknown }) {
  const candidates = rowsFrom(data, ['resources', 'balances', 'totals'])
  const resources: JsonRecord[] = candidates.length
    ? candidates
    : Object.entries(recordAt(data, ['resources'])).map(([name, value]) => ({ name, value }))
  if (!resources.length) return <p className="admin-inline-empty">No per-resource breakdown was returned.</p>
  const values = resources.map(row => Number(row.value ?? row.total ?? row.balance ?? row.amount ?? 0))
  const maximum = Math.max(1, ...values)
  return <div className="admin-resource-bars">{resources.map((row, index) => <div key={textValue(row, ['name', 'resource', 'type'], String(index))}><div><strong>{textValue(row, ['name', 'resource', 'type'], `Resource ${index + 1}`)}</strong><span>{formatMetric(values[index])}</span></div><span className="admin-bar"><i style={{ width: `${Math.max(2, values[index] / maximum * 100)}%` }} /></span></div>)}</div>
}

function EconomyView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('economy', onUnauthorized)
  return (
    <>
      <SectionHeading eyebrow="Economy observatory" title="Sources, sinks & balances" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>
        Watch circulation, reward pressure, and resource movement without mutating live balances.
      </SectionHeading>
      <StateSurface state={state} onRetry={reload}>{data => {
        const days = rowsFrom(data, ['days'])
        const total = (section: string, resource?: string) => days.reduce((sum, day) => {
          const bucket = asRecord(day[section])
          if (resource) return sum + Number(bucket[resource] ?? 0)
          return sum + Number(bucket.gold ?? 0) + Number(bucket.ore ?? 0) + Number(bucket.food ?? 0)
        }, 0)
        const sources = total('faucets') + total('refunds')
        const sinks = total('sinks')
        const net = sources - sinks
        const events = days.reduce<number>((sum, day) => Object.values(asRecord(day.counts)).reduce<number>((inner, count) => inner + Number(count ?? 0), sum), 0)
        const sourceByResource = Object.fromEntries(['gold', 'ore', 'food'].map(resource => [resource, total('faucets', resource) + total('refunds', resource)]))
        const today = days.find(day => Number(day.day) === Number(asRecord(data).today)) ?? days[0] ?? {}
        const todayCounts = asRecord(today.counts)
        return <div className="admin-stack">
          <div className="admin-metric-grid four">
            <MetricCard label="Window sources" value={sources} detail={`${days.length} daily buckets`} tone="green" />
            <MetricCard label="Window sinks" value={sinks} detail="Resources removed" tone="red" />
            <MetricCard label="Net issuance" value={net} detail={net > 0 ? 'Inflationary window' : net < 0 ? 'Deflationary window' : 'Balanced window'} tone={net > 0 ? 'gold' : 'blue'} />
            <MetricCard label="Economy events" value={events} detail="Saves, trades, and raids" tone="blue" />
          </div>
          <div className="admin-two-column">
            <Panel title="Resource issuance" eyebrow="Relative source totals"><ResourceBars data={{ resources: sourceByResource }} /></Panel>
            <Panel title="Today's activity" eyebrow={formatWorldDay(today.day)}>
              <dl className="admin-definition-list">
                <div><dt>Battle settlements</dt><dd>{formatMetric(todayCounts.battles, false)}</dd></div>
                <div><dt>Bot raids</dt><dd>{formatMetric(todayCounts.botRaids, false)}</dd></div>
                <div><dt>Trades / saves</dt><dd>{formatMetric(todayCounts.trades, false)} / {formatMetric(todayCounts.saves, false)}</dd></div>
                <div><dt>Loot transferred</dt><dd>{formatMetric(Object.values(asRecord(today.loot)).reduce<number>((sum, value) => sum + Number(value ?? 0), 0))}</dd></div>
              </dl>
            </Panel>
          </div>
          <Panel title="Daily economy history" eyebrow="Authoritative aggregates">
            {days.length ? <div className="admin-table-wrap"><table><thead><tr><th>Day</th><th>Faucets</th><th>Sinks</th><th>Refunds</th><th>Loot moved</th><th>Saves</th><th>Trades</th><th>Battles / bot raids</th></tr></thead><tbody>{days.map((day, index) => { const counts = asRecord(day.counts); const bucketTotal = (key: string) => Object.values(asRecord(day[key])).reduce<number>((sum, value) => sum + Number(value ?? 0), 0); return <tr key={textValue(day, ['day'], String(index))}><td>{formatWorldDay(day.day)}</td><td className="admin-positive">{formatMetric(bucketTotal('faucets'))}</td><td className="admin-negative">{formatMetric(bucketTotal('sinks'))}</td><td>{formatMetric(bucketTotal('refunds'))}</td><td>{formatMetric(bucketTotal('loot'))}</td><td>{formatMetric(counts.saves, false)}</td><td>{formatMetric(counts.trades, false)}</td><td>{formatMetric(counts.battles, false)} / {formatMetric(counts.botRaids, false)}</td></tr> })}</tbody></table></div> : <p className="admin-inline-empty">No daily economy buckets were returned.</p>}
          </Panel>
        </div>
      }}</StateSurface>
    </>
  )
}

function CombatView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('attacks?limit=150', onUnauthorized)
  return (
    <>
      <SectionHeading eyebrow="Combat authority" title="Attacks & replays" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>
        Inspect authoritative raid lifecycle, outcomes, loot settlement, and replay provenance.
      </SectionHeading>
      <StateSurface state={state} onRetry={reload}>{data => {
        const attacks = rowsFrom(data, ['attacks', 'items', 'results'])
        const active = attacks.filter(row => ['preparing', 'engaged', 'active', 'finalizing'].includes(String(row.state).toLowerCase())).length
        const settled = attacks.filter(row => String(row.state).toLowerCase() === 'settled').length
        const cancelled = attacks.filter(row => ['cancelled', 'expired'].includes(String(row.state).toLowerCase())).length
        const simulationVersion = Math.max(0, ...attacks.map(row => Number(row.simulationVersion ?? 0)))
        return <div className="admin-stack">
          <div className="admin-metric-grid four"><MetricCard label="Loaded raids" value={attacks.length} detail="Current result window" /><MetricCard label="In progress" value={active} detail="Across live lifecycle states" tone="blue" /><MetricCard label="Settled" value={settled} detail="Finalized authoritative raids" tone="green" /><MetricCard label="Cancelled / expired" value={cancelled} detail="Closed without settlement" tone="red" /><MetricCard label="Latest simulation" value={`v${simulationVersion}`} detail="Highest loaded ruleset" tone="gold" /></div>
          <Panel title="Raid ledger" eyebrow="Newest first">
            {attacks.length ? <div className="admin-table-wrap"><table><thead><tr><th>Attack</th><th>State</th><th>Attacker</th><th>Target</th><th>World / plot</th><th>Versions</th><th>Created</th><th>Deadline / ended</th></tr></thead><tbody>{attacks.map((attack, index) => <tr key={textValue(attack, ['id', 'attackId'], String(index))}><td><code>{textValue(attack, ['id', 'attackId'], '—')}</code></td><td><StatusPill value={attack.state ?? attack.status} /></td><td><code>{textValue(attack, ['attackerId'], '—')}</code></td><td><strong>{textValue(attack, ['targetKind'], 'target')}</strong><code>{textValue(attack, ['targetId', 'defenderId'], '—')}</code></td><td>{textValue(attack, ['worldId'], '?')} · {textValue(attack, ['targetX'], '?')}, {textValue(attack, ['targetY'], '?')}</td><td>state {formatMetric(attack.stateVersion, false)} · sim v{formatMetric(attack.simulationVersion, false)}</td><td>{formatDate(attack.createdAt)}</td><td>{formatDate(attack.endedAt ?? attack.deadlineAt)}</td></tr>)}</tbody></table></div> : <p className="admin-inline-empty">There are no attacks in this result window.</p>}
          </Panel>
        </div>
      }}</StateSurface>
    </>
  )
}

function WorldView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('bots?limit=200', onUnauthorized)
  const [query, setQuery] = useState('')
  return (
    <>
      <SectionHeading eyebrow="World authority" title="Persistent bot villages" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>
        Every displayed bot must exist as a durable server record. Inspect identity, generator provenance, and village revisions here.
      </SectionHeading>
      <StateSurface state={state} onRetry={reload}>{data => {
        const bots = rowsFrom(data, ['bots', 'villages', 'items'])
        const shown = bots.filter(bot => !query || JSON.stringify(bot).toLowerCase().includes(query.toLowerCase()))
        const revisions = bots.map(bot => Number(bot.revision ?? 0)).filter(Number.isFinite)
        const worlds = new Set(bots.map(bot => textValue(bot, ['worldId'], '')).filter(Boolean))
        return <div className="admin-stack">
          <div className="admin-metric-grid four"><MetricCard label="Persistent villages" value={bots.length} detail="Loaded server records" /><MetricCard label="World partitions" value={worlds.size} detail="Represented in this window" tone="blue" /><MetricCard label="Highest revision" value={Math.max(0, ...revisions)} detail="Durable mutation counter" tone="green" /><MetricCard label="Unprovenanced" value={bots.filter(bot => !bot.generatorVersion && !bot.seed).length} detail="Should remain zero" tone="red" /></div>
          <Panel title="Bot village registry" eyebrow="Persisted before presentation">
            <div className="admin-filter-bar"><label className="admin-search-field"><span className="sr-only">Filter bot villages</span><input type="search" placeholder="Filter ID, world, coordinate, or difficulty…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
            {shown.length ? <div className="admin-table-wrap"><table><thead><tr><th>Village</th><th>World / plot</th><th>Difficulty</th><th>Revision</th><th>Generator</th><th>Trophies</th><th>Buildings</th><th>Resources</th><th>Updated</th></tr></thead><tbody>{shown.map((bot, index) => { const world = asRecord(bot.world); const resources = asRecord(bot.resources ?? world.resources); const buildings = Array.isArray(world.buildings) ? world.buildings.length : Number(bot.buildingCount ?? 0); return <tr key={idOf(bot) || index}><td><strong>{textValue(bot, ['username', 'name'], 'Bot village')}</strong><code>{idOf(bot)}</code></td><td>{textValue(bot, ['worldId'], '?')} · {textValue(bot, ['x', 'plotX'], '?')}, {textValue(bot, ['y', 'plotY'], '?')}</td><td><StatusPill value={asRecord(bot.profile).difficulty ?? bot.difficulty ?? 'unknown'} /></td><td>{formatMetric(bot.revision, false)}</td><td>v{textValue(bot, ['generatorVersion'], '?')}</td><td>{formatMetric(bot.trophies, false)}</td><td>{formatMetric(buildings, false)}</td><td>G {formatMetric(resources.gold)} · O {formatMetric(resources.ore)} · F {formatMetric(resources.food)}</td><td>{formatDate(bot.updatedAt)}</td></tr> })}</tbody></table></div> : <p className="admin-inline-empty">No bot villages match this filter.</p>}
          </Panel>
          <div className="admin-callout"><strong>Persistence invariant</strong><p>This console never generates, previews, or repairs a bot client-side. Missing villages must be provisioned by the server and committed before any consumer can observe them.</p></div>
        </div>
      }}</StateSurface>
    </>
  )
}

type OperationType = 'clear_shields' | 'set_maintenance'

function OperationDialog({ operation, onClose, onComplete, onUnauthorized }: {
  operation: OperationType
  onClose: () => void
  onComplete: (message: string) => void
  onUnauthorized: () => void
}) {
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [message, setMessage] = useState('Scheduled maintenance is in progress. Please try again shortly.')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = operation === 'clear_shields' ? 'Clear every player shield' : 'Set maintenance mode'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (reason.trim().length < 8 || confirmation !== 'CONFIRM') return
    setBusy(true)
    setError(null)
    try {
      await adminApi.post('operations', { type: operation, reason: reason.trim(), ...(operation === 'set_maintenance' ? { enabled, message: enabled ? message.trim() : '' } : {}) })
      onComplete(`${label} completed.`)
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.unauthorized) onUnauthorized()
      else setError(caught instanceof Error ? caught.message : 'The operation could not be completed.')
    } finally { setBusy(false) }
  }
  return <DialogFrame title={label} subtitle="This is a global, security-sensitive operation." onClose={onClose}><form className="admin-action-form" onSubmit={submit}>
    {operation === 'set_maintenance' ? <><label className="admin-toggle-row"><span><strong>Maintenance enabled</strong><small>Blocks normal game traffic while preserving the admin route.</small></span><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></label>{enabled ? <label><span>Player-facing message</span><textarea rows={3} maxLength={300} value={message} onChange={event => setMessage(event.target.value)} /></label> : null}</> : <div className="admin-warning"><strong>All active shields will be removed.</strong><p>Players can become attackable immediately. This operation cannot be scoped or undone automatically.</p></div>}
    <label><span>Required reason</span><textarea rows={3} minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the incident, release, or support need…" required /></label>
    <label><span>Type CONFIRM to authorize</span><input autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="CONFIRM" /></label>
    {error ? <div className="admin-form-error" role="alert">{error}</div> : null}
    <footer><button className="admin-button admin-button-secondary" type="button" onClick={onClose}>Cancel</button><button className="admin-button admin-button-danger" disabled={busy || reason.trim().length < 8 || confirmation !== 'CONFIRM'}>{busy ? 'Applying…' : 'Authorize globally'}</button></footer>
  </form></DialogFrame>
}

function LiveOpsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [operation, setOperation] = useState<OperationType | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const capabilities = [
    ['Player support', 'Search, balances, trophies, names, shields, access, notices', 'Available'],
    ['Session control', 'Revoke every session belonging to one player', 'Available'],
    ['Economy correction', 'Explicit resource deltas with permanent operator reason', 'Available'],
    ['World observability', 'Persistent bot provenance, revisions, plots, resources', 'Read only'],
    ['Combat investigation', 'Attack lifecycle, simulation version, loot, replay references', 'Read only'],
    ['Maintenance mode', 'Enable or disable the player-facing maintenance gate', 'Available'],
    ['Global shield clear', 'Remove active protection from all accounts', 'Available'],
    ['Audit & configuration', 'Operator history plus safely redacted runtime config', 'Available'],
  ] as const
  return <>
    <SectionHeading eyebrow="Live operations" title="Global controls">High-impact runtime tools. Every mutation requires an explicit reason and typed confirmation.</SectionHeading>
    {notice ? <div className="admin-success" role="status">{notice}</div> : null}
    <div className="admin-operations-grid">
      <article className="admin-operation-card"><span className="admin-operation-glyph">MT</span><div><span className="admin-eyebrow">Traffic control</span><h2>Maintenance mode</h2><p>Open or close the game to player traffic with a clear player-facing status message.</p></div><button className="admin-button" type="button" onClick={() => setOperation('set_maintenance')}>Configure maintenance</button></article>
      <article className="admin-operation-card danger"><span className="admin-operation-glyph">SH</span><div><span className="admin-eyebrow">World state</span><h2>Clear all shields</h2><p>Remove attack protection globally. Reserved for incident recovery and controlled testing.</p></div><button className="admin-button admin-button-danger" type="button" onClick={() => setOperation('clear_shields')}>Clear every shield</button></article>
    </div>
    <Panel title="Administrative capability matrix" eyebrow="Current deployment">
      <div className="admin-capability-grid">{capabilities.map(([name, detail, status]) => <div key={name}><div><strong>{name}</strong><p>{detail}</p></div><StatusPill value={status === 'Available' ? 'ready' : status} /></div>)}</div>
    </Panel>
    <div className="admin-callout"><strong>Deliberate safety boundary</strong><p>Database consoles, arbitrary JSON writes, user impersonation, secret display, and unscoped delete buttons do not belong in a web admin surface. They are intentionally absent.</p></div>
    {operation ? <OperationDialog operation={operation} onClose={() => setOperation(null)} onUnauthorized={onUnauthorized} onComplete={message => { setOperation(null); setNotice(message) }} /> : null}
  </>
}

function AuditView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('audit?limit=250', onUnauthorized)
  const [query, setQuery] = useState('')
  return <>
    <SectionHeading eyebrow="Accountability" title="Immutable audit trail" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>Review who changed what, which record was targeted, and the required operator reason.</SectionHeading>
    <Panel title="Administrative events" eyebrow="Newest first">
      <div className="admin-filter-bar"><label className="admin-search-field"><span className="sr-only">Filter audit events</span><input type="search" placeholder="Filter actor, action, target, reason, or request ID…" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
      <StateSurface state={state} onRetry={reload}>{data => {
        const rows = rowsFrom(data, ['entries', 'audit', 'events', 'items']).filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
        return rows.length ? <div className="admin-table-wrap"><table><thead><tr><th>Time</th><th>Operator</th><th>Action</th><th>Target</th><th>Outcome</th><th>Reason</th><th>Audit ID</th></tr></thead><tbody>{rows.map((row, index) => { const details = asRecord(row.details); return <tr key={textValue(row, ['id'], String(index))}><td>{formatDate(row.occurredAt ?? row.createdAt ?? row.timestamp)}</td><td><strong>{textValue(row, ['actor', 'adminUsername', 'username'], 'admin')}</strong></td><td>{textValue(row, ['action', 'type', 'operation'], '—')}</td><td><strong>{textValue(row, ['targetType'], 'system')}</strong><code>{textValue(row, ['targetId', 'playerId'], 'global')}</code></td><td><StatusPill value="recorded" /></td><td className="admin-reason-cell">{textValue(details, ['reason'], 'No reason returned')}</td><td><code>{textValue(row, ['id'], '—')}</code></td></tr>})}</tbody></table></div> : <p className="admin-inline-empty">No audit events match this filter.</p>
      }}</StateSurface>
    </Panel>
  </>
}

function ConfigTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth > 4) return <code>[nested configuration]</code>
  if (Array.isArray(value)) return <span>{value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ') || '[]'}</span>
  if (!value || typeof value !== 'object') return typeof value === 'boolean' ? <StatusPill value={value} /> : <code>{String(value ?? 'null')}</code>
  return <div className="admin-config-tree">{Object.entries(value).map(([key, child]) => <div key={key}><strong>{key.replaceAll('_', ' ')}</strong><ConfigTree value={child} depth={depth + 1} /></div>)}</div>
}

function SecurityView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('config', onUnauthorized)
  return <>
    <SectionHeading eyebrow="Security posture" title="Runtime configuration" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>Read-only deployment controls and security posture. Sensitive-looking fields are redacted again in the browser.</SectionHeading>
    <StateSurface state={state} onRetry={reload}>{data => {
      const root = asRecord(data)
      const maintenance = asRecord(redactSecrets(root.maintenance))
      const accessPolicy = asRecord(redactSecrets(root.accessPolicy))
      const safeLimits = asRecord(redactSecrets(root.safeLimits))
      return <div className="admin-stack">
        <div className="admin-metric-grid four">
          <MetricCard label="Maintenance" value={maintenance.enabled === true ? 'enabled' : 'disabled'} detail={textValue(maintenance, ['message'], 'Player traffic gate')} tone={maintenance.enabled === true ? 'red' : 'green'} />
          <MetricCard label="Session revocation" value={accessPolicy.suspendedSessionsRevoked === true && accessPolicy.bannedSessionsRevoked === true ? 'enforced' : 'check'} detail="Suspended and banned players" tone="green" />
          <MetricCard label="Config revision" value={root.revision} detail="Authoritative mutation version" tone="blue" />
          <MetricCard label="Updated" value={formatDate(root.updatedAt)} detail="Latest config change" />
        </div>
        <div className="admin-two-column">
          <Panel title="Access enforcement" eyebrow="Moderation boundary"><ConfigTree value={accessPolicy} /></Panel>
          <Panel title="Safe query limits" eyebrow="Abuse protection"><ConfigTree value={safeLimits} /></Panel>
        </div>
        <Panel title="Redacted configuration snapshot" eyebrow="Read only"><pre className="admin-json-view">{redactedJson(data)}</pre></Panel>
      </div>
    }}</StateSurface>
  </>
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (identity: AdminIdentity) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = await adminApi.login(username.trim(), password)
      const identity = sessionIdentity(payload)
      if (!identity) throw new AdminApiError('The server did not establish an admin session.', 401)
      onAuthenticated(identity)
    } catch (caught) {
      setError(caught instanceof AdminApiError && caught.status === 429 ? 'Too many attempts. Wait before trying again.' : caught instanceof Error ? caught.message : 'Sign-in failed.')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  return <main className="admin-login-shell">
    <div className="admin-login-atmosphere" aria-hidden="true"><span /><span /><span /></div>
    <section className="admin-login-card" aria-labelledby="admin-login-title">
      <div className="admin-crest" aria-hidden="true"><span>OPS</span></div>
      <span className="admin-eyebrow">Restricted command surface</span>
      <h1 id="admin-login-title">Realm Operations</h1>
      <p>Authorized administrators only. Access attempts and all subsequent mutations are audited.</p>
      <form onSubmit={submit}>
        <label><span>Username</span><input autoFocus autoComplete="username" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} required /></label>
        <label><span>Password</span><input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
        {error ? <div className="admin-form-error" role="alert">{error}</div> : null}
        <button className="admin-button admin-login-button" type="submit" disabled={busy || !username.trim() || !password}>{busy ? 'Authenticating…' : 'Enter command center'}</button>
      </form>
      <footer><span className="admin-lock-dot" /> Session cookies are HttpOnly. Credentials are never stored by this page.</footer>
    </section>
  </main>
}

function PortalShell({ identity, onLoggedOut }: { identity: AdminIdentity; onLoggedOut: () => void }) {
  const [view, setView] = useState<ViewId>(routeView)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const onUnauthorized = useCallback(() => { adminApi.clearMemory(); onLoggedOut() }, [onLoggedOut])

  useEffect(() => {
    const update = () => setView(routeView())
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [])

  const goTo = (next: ViewId) => {
    setView(next)
    setMenuOpen(false)
    window.history.pushState(null, '', next === 'overview' ? '/admin' : `/admin/${next}`)
  }
  const logout = async () => {
    setLoggingOut(true)
    try { await adminApi.logout() } catch { adminApi.clearMemory() } finally { setLoggingOut(false); onLoggedOut() }
  }
  const selected = NAV_ITEMS.find(item => item.id === view) ?? NAV_ITEMS[0]
  return <div className="admin-shell">
    <a className="admin-skip-link" href="#admin-content">Skip to content</a>
    <aside className={`admin-sidebar ${menuOpen ? 'is-open' : ''}`}>
      <header className="admin-brand"><div className="admin-brand-mark">R</div><div><strong>Realm Ops</strong><span>Clash control plane</span></div></header>
      <nav aria-label="Admin sections">{NAV_ITEMS.map(item => <button type="button" key={item.id} className={view === item.id ? 'is-active' : ''} onClick={() => goTo(item.id)} aria-current={view === item.id ? 'page' : undefined}><span className="admin-nav-glyph">{item.glyph}</span><span><strong>{item.label}</strong><small>{item.eyebrow}</small></span></button>)}</nav>
      <footer><div className="admin-operator"><span>{identity.username.slice(0, 2).toUpperCase()}</span><div><strong>{identity.username}</strong><small>{identity.role}</small></div></div><button type="button" onClick={logout} disabled={loggingOut}>{loggingOut ? 'Signing out…' : 'Secure sign out'}</button></footer>
    </aside>
    {menuOpen ? <button className="admin-mobile-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    <section className="admin-workspace">
      <header className="admin-topbar"><button className="admin-menu-button" type="button" onClick={() => setMenuOpen(value => !value)} aria-expanded={menuOpen} aria-label="Open admin navigation"><span /><span /><span /></button><div><span className="admin-mobile-view">{selected.label}</span></div><div className="admin-runtime-status"><span /><div><strong>Server connected</strong><small>Secure operator session</small></div></div></header>
      <main id="admin-content" className="admin-content">
        {view === 'overview' ? <OverviewView onUnauthorized={onUnauthorized} goTo={goTo} /> : null}
        {view === 'players' ? <PlayersView onUnauthorized={onUnauthorized} /> : null}
        {view === 'economy' ? <EconomyView onUnauthorized={onUnauthorized} /> : null}
        {view === 'combat' ? <CombatView onUnauthorized={onUnauthorized} /> : null}
        {view === 'world' ? <WorldView onUnauthorized={onUnauthorized} /> : null}
        {view === 'liveops' ? <LiveOpsView onUnauthorized={onUnauthorized} /> : null}
        {view === 'audit' ? <AuditView onUnauthorized={onUnauthorized} /> : null}
        {view === 'security' ? <SecurityView onUnauthorized={onUnauthorized} /> : null}
      </main>
    </section>
  </div>
}

export function AdminPortal() {
  const [checking, setChecking] = useState(true)
  const [identity, setIdentity] = useState<AdminIdentity | null>(null)

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Realm Operations · Clash'
    return () => { document.title = previousTitle }
  }, [])

  useEffect(() => {
    let current = true
    adminApi.session().then(payload => {
      if (current) setIdentity(sessionIdentity(payload))
    }).catch(() => {
      if (current) setIdentity(null)
    }).finally(() => {
      if (current) setChecking(false)
    })
    return () => { current = false }
  }, [])

  const logOutLocally = useCallback(() => setIdentity(null), [])
  if (checking) return <main className="admin-boot"><div className="admin-crest"><span>OPS</span></div><span className="admin-spinner" /><strong>Verifying operator session…</strong></main>
  if (!identity) return <LoginScreen onAuthenticated={next => setIdentity(next)} />
  return <PortalShell identity={identity} onLoggedOut={logOutLocally} />
}
