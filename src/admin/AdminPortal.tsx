import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  Bot,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Coins,
  Command,
  DatabaseZap,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  MessageSquareText,
  Plus,
  RadioTower,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Swords,
  Trash2,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  AdminApiError,
  adminApi,
  asRecord,
  rowsFrom,
  unwrapData,
  type JsonRecord,
} from './api'
import { Alert, AlertDescription, AlertTitle } from './ui/alert'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from './ui/progress'
import { ScrollArea } from './ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Separator } from './ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet'
import { Skeleton } from './ui/skeleton'
import { Switch } from './ui/switch'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table'
import { Textarea } from './ui/textarea'
import { cn } from './lib/utils'
import './AdminPortal.css'

const PlayerVillagePreview = lazy(() => import('./PlayerVillagePreview'))

const ADMIN_DATA_REFRESH_EVENT = 'clash:admin-data-refresh'
const RESET_ALL_BASES_CONFIRMATION = 'RESET ALL BASES'

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
  icon: LucideIcon
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'overview', label: 'Command', eyebrow: 'Live overview', icon: LayoutDashboard },
  { id: 'players', label: 'Players', eyebrow: 'Support & safety', icon: Users },
  { id: 'economy', label: 'Economy', eyebrow: 'Sources & sinks', icon: CircleDollarSign },
  { id: 'combat', label: 'Combat', eyebrow: 'Raids & replays', icon: Swords },
  { id: 'world', label: 'World & bots', eyebrow: 'Persistent villages', icon: Bot },
  { id: 'liveops', label: 'Live operations', eyebrow: 'Global controls', icon: RadioTower },
  { id: 'audit', label: 'Audit trail', eyebrow: 'Accountability', icon: ScrollText },
  { id: 'security', label: 'Security & config', eyebrow: 'Runtime posture', icon: ShieldCheck },
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
  const requestKey = `${path}\u0000${nonce}`
  const [result, setResult] = useState<{ key: string; path: string; state: LoadState }>({
    key: requestKey,
    path,
    state: { kind: 'loading' },
  })

  useEffect(() => {
    let current = true
    adminApi.get(path).then(payload => {
      if (!current) return
      const data = unwrapData(payload)
      setResult({
        key: requestKey,
        path,
        state: isObjectEmpty(data) ? { kind: 'empty', data } : { kind: 'ready', data },
      })
    }).catch((error: unknown) => {
      if (!current) return
      if (error instanceof AdminApiError && error.unauthorized) {
        onUnauthorized()
        return
      }
      if (error instanceof AdminApiError && error.unsupported) {
        setResult({ key: requestKey, path, state: { kind: 'unsupported', message: error.message } })
        return
      }
      setResult({
        key: requestKey,
        path,
        state: {
          kind: 'error',
          message: error instanceof Error ? error.message : 'This admin view could not be loaded.',
        },
      })
    })
    return () => { current = false }
  }, [onUnauthorized, path, requestKey])

  useEffect(() => {
    const refresh = () => setNonce(value => value + 1)
    window.addEventListener(ADMIN_DATA_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(ADMIN_DATA_REFRESH_EVENT, refresh)
  }, [])

  const isCurrent = result.key === requestKey
  // A nonce change is a revalidation of the SAME endpoint, not a navigation.
  // Keep the last complete snapshot visible while Vercel performs the GET;
  // otherwise player detail falls back to the resource-less directory row and
  // briefly renders missing balances immediately after a successful mutation.
  const canReuseSnapshot = result.path === path
    && (result.state.kind === 'ready' || result.state.kind === 'empty')
  const refreshing = !isCurrent && canReuseSnapshot
  const state: LoadState = isCurrent || canReuseSnapshot ? result.state : { kind: 'loading' }
  return { state, refreshing, reload: () => setNonce(value => value + 1) }
}

function refreshAdminData() {
  window.dispatchEvent(new Event(ADMIN_DATA_REFRESH_EVENT))
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
    <header className="flex flex-col gap-4 border-b border-border/70 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl space-y-1.5">
        <div className="text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{children}</p>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

function StateSurface({ state, onRetry, children }: {
  state: LoadState
  onRetry: () => void
  children: (data: unknown) => ReactNode
}) {
  if (state.kind === 'loading' && state.data === undefined) {
    return (
      <Card aria-busy="true">
        <CardContent className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /><span>Loading secure data…</span></div>
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-3 sm:grid-cols-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        </CardContent>
      </Card>
    )
  }
  if (state.kind === 'unsupported') {
    return (
      <Alert>
        <AlertCircle />
        <AlertTitle>Capability unavailable</AlertTitle>
        <AlertDescription>This deployed server does not expose this admin capability. {state.message}</AlertDescription>
      </Alert>
    )
  }
  if (state.kind === 'error') {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle />
        <AlertTitle>Unable to load this view</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{state.message}</span>
          <Button variant="outline" size="sm" type="button" onClick={onRetry}>Try again</Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (state.kind === 'empty') {
    return (
      <Card className="border-dashed bg-muted/20">
        <CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-background"><AlertCircle className="size-4 text-muted-foreground" /></div>
          <div><p className="font-medium">No records yet</p><p className="mt-1 text-muted-foreground">The endpoint is available, but it has no data to show.</p></div>
          <Button variant="outline" size="sm" type="button" onClick={onRetry}><RefreshCw data-icon="inline-start" />Refresh</Button>
        </CardContent>
      </Card>
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
  return (
    <Badge
      variant={negative ? 'destructive' : positive ? 'secondary' : 'outline'}
      className={cn(positive && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300')}
    >
      <span className={cn('size-1.5 rounded-full bg-muted-foreground', positive && 'bg-emerald-500', negative && 'bg-destructive')} />
      {String(value ?? 'unknown')}
    </Badge>
  )
}

interface TestModeState {
  override: boolean | null
  effective: boolean
}

function testModeStateOf(value: unknown): TestModeState {
  const state = asRecord(value)
  return {
    override: typeof state.override === 'boolean' ? state.override : null,
    effective: state.effective === true,
  }
}

function TestModePill({ value, testId }: { value: unknown; testId?: string }) {
  const state = testModeStateOf(value)
  const source = state.override === null ? 'Inherited' : 'Override'
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      data-test-mode-effective={state.effective ? 'enabled' : 'disabled'}
      data-test-mode-source={source.toLowerCase()}
      aria-label={`Test mode ${state.effective ? 'enabled' : 'disabled'}, ${source.toLowerCase()}`}
      className={cn(
        state.effective
          ? 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200'
          : 'bg-muted/40 text-muted-foreground',
      )}
    >
      <FlaskConical />
      {state.effective ? 'Enabled' : 'Disabled'} · {source}
    </Badge>
  )
}

function MetricCard({ label, value, detail, tone = 'gold' }: {
  label: string
  value: unknown
  detail: string
  tone?: 'gold' | 'green' | 'blue' | 'red'
}) {
  const toneStyles = {
    gold: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    blue: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    red: 'bg-destructive/10 text-destructive',
  } as const
  return (
    <Card size="sm" className="min-w-0 shadow-xs">
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
          <span className={cn('size-2 rounded-full', toneStyles[tone])} aria-hidden="true" />
        </div>
        <strong className="block truncate text-2xl font-semibold tracking-tight tabular-nums">{formatMetric(value)}</strong>
        <p className="min-h-8 text-xs leading-4 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function Panel({ title, eyebrow, children, className = '' }: {
  title: string
  eyebrow?: string
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={cn('shadow-xs', className)}>
      <CardHeader className="border-b">
        <h2 className="text-sm leading-none font-medium">{title}</h2>
        {eyebrow ? <CardDescription>{eyebrow}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return <Button variant="outline" size="lg" type="button" onClick={onClick} disabled={loading}><RefreshCw data-icon="inline-start" className={cn(loading && 'animate-spin')} />{loading ? 'Refreshing…' : 'Refresh data'}</Button>
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
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              <MetricCard label="Total players" value={firstValue(data, [['players', 'total'], ['totalPlayers'], ['metrics', 'players']])} detail="Registered and guest accounts" />
              <MetricCard label="Online now" value={firstValue(data, [['players', 'online'], ['onlinePlayers'], ['metrics', 'online']])} detail="Active sessions" tone="green" />
              <MetricCard label="Persistent bots" value={firstValue(data, [['villages', 'botVillages'], ['bots', 'total'], ['botVillages']])} detail="Stored world villages" tone="blue" />
              <MetricCard label="Open attacks" value={activeAttacks} detail="Across lifecycle states" tone="red" />
              <MetricCard label="Gold in circulation" value={firstValue(data, [['economy', 'gold'], ['economy', 'circulatingGold'], ['goldCirculation']])} detail="Player-held balance" />
              <MetricCard label="Moderated accounts" value={moderated} detail="Suspended or banned" tone={moderated ? 'red' : 'green'} />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <Panel title="Realm posture" eyebrow="Authoritative snapshot">
                <div className="divide-y">
                  <div className="flex items-center justify-between gap-4 py-3 first:pt-0"><div><strong className="block font-medium">Admin API</strong><small className="text-muted-foreground">Snapshot generated {formatDate(asRecord(data).generatedAt)}</small></div><StatusPill value="healthy" /></div>
                  <div className="flex items-center justify-between gap-4 py-3"><div><strong className="block font-medium">Player traffic</strong><small className="text-muted-foreground">{maintenance ? 'Only operators should be admitted' : 'Normal game traffic is admitted'}</small></div><StatusPill value={maintenance ? 'maintenance' : 'online'} /></div>
                  <div className="flex items-center justify-between gap-4 py-3 last:pb-0"><div><strong className="block font-medium">Bot persistence</strong><small className="text-muted-foreground">Server-owned durable villages</small></div><StatusPill value="ready" /></div>
                </div>
              </Panel>
              <Panel title="Account & world mix" eyebrow="Current totals">
                <dl className="divide-y">
                  <div className="flex items-center justify-between gap-4 py-3 first:pt-0"><dt className="text-muted-foreground">Registered / guests</dt><dd className="font-medium tabular-nums">{formatMetric(valueAt(data, ['players', 'registered']), false)} / {formatMetric(valueAt(data, ['players', 'guests']), false)}</dd></div>
                  <div className="flex items-center justify-between gap-4 py-3"><dt className="text-muted-foreground">Player villages</dt><dd className="font-medium tabular-nums">{formatMetric(valueAt(data, ['villages', 'playerVillages']), false)}</dd></div>
                  <div className="flex items-center justify-between gap-4 py-3"><dt className="text-muted-foreground">Average trophies</dt><dd className="font-medium tabular-nums">{formatMetric(valueAt(data, ['economy', 'averageTrophies']), false)}</dd></div>
                  <div className="flex items-center justify-between gap-4 py-3 last:pb-0"><dt className="text-muted-foreground">Ore / food</dt><dd className="font-medium tabular-nums">{formatMetric(valueAt(data, ['economy', 'ore']))} / {formatMetric(valueAt(data, ['economy', 'food']))}</dd></div>
                </dl>
              </Panel>
            </div>

            <Panel title="Operator shortcuts" eyebrow="High-frequency workflows">
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                {([
                  ['players', 'Find a player', 'Account support, balances, access, and sessions', Users],
                  ['liveops', 'Live operations', 'Maintenance mode and global shield controls', RadioTower],
                  ['world', 'Inspect persistent bots', 'World coordinates, provenance, and revisions', Bot],
                  ['audit', 'Review audit trail', 'Every sensitive operator action with its reason', ScrollText],
                ] as const).map(([target, label, detail, Icon]) => (
                  <Button key={target} variant="outline" className="h-auto items-start justify-between gap-3 p-3 text-left whitespace-normal" type="button" onClick={() => goTo(target)}>
                    <span className="flex min-w-0 gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted"><Icon className="size-4" /></span><span><strong className="block text-sm">{label}</strong><span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">{detail}</span></span></span>
                    <ArrowRight className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
                  </Button>
                ))}
              </div>
            </Panel>
          </div>
        )
      }}</StateSurface>
    </>
  )
}

type PlayerAction = 'adjust_resources' | 'set_trophies' | 'set_shield' | 'rename' | 'revoke_sessions' | 'set_access' | 'send_notice' | 'set_test_mode'

const PLAYER_ACTIONS: readonly { type: PlayerAction; label: string; detail: string; icon: LucideIcon; danger?: boolean }[] = [
  { type: 'adjust_resources', label: 'Adjust resources', detail: 'Apply explicit gold, ore, and food deltas.', icon: Coins },
  { type: 'set_trophies', label: 'Set trophies', detail: 'Correct the authoritative trophy count.', icon: Gauge },
  { type: 'set_shield', label: 'Set shield', detail: 'Grant or remove attack protection.', icon: ShieldCheck },
  { type: 'rename', label: 'Rename player', detail: 'Change the public village username.', icon: UserCog },
  { type: 'send_notice', label: 'Send notice', detail: 'Deliver a support or moderation message.', icon: MessageSquareText },
  { type: 'set_test_mode', label: 'Configure test mode', detail: 'Inherit the realm setting or override it for this player.', icon: FlaskConical },
  { type: 'revoke_sessions', label: 'Revoke sessions', detail: 'Sign the player out of every device.', icon: LogOut, danger: true },
  { type: 'set_access', label: 'Change access', detail: 'Activate, suspend, or ban the account.', icon: Ban, danger: true },
]

function DialogFrame({ title, subtitle, children, onClose }: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <Badge variant="outline" className="mb-1">Audited action</Badge>
          <DialogTitle className="text-lg">{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function FormField({ id, label, hint, children, className }: {
  id: string
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  const hintId = hint ? `${id}-hint` : undefined
  const childElement = isValidElement<{ 'aria-describedby'?: string }>(children) ? children : null
  const describedChild = hintId && childElement
    ? cloneElement(childElement, {
        'aria-describedby': [childElement.props['aria-describedby'], hintId].filter(Boolean).join(' '),
      })
    : children
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {describedChild}
      {hint ? <p id={hintId} className="text-[0.6875rem] leading-4 text-muted-foreground">{hint}</p> : null}
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
  const currentTestMode = testModeStateOf(player.testMode)
  const [testModeOverride, setTestModeOverride] = useState<'inherit' | 'enabled' | 'disabled'>(
    currentTestMode.override === null ? 'inherit' : currentTestMode.override ? 'enabled' : 'disabled',
  )
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
    else if (action === 'set_test_mode') {
      body.override = testModeOverride === 'inherit' ? null : testModeOverride === 'enabled'
    }
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
      <form className="grid gap-4" onSubmit={submit}>
        {action === 'adjust_resources' ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField id="gold-delta" label="Gold delta"><Input id="gold-delta" type="number" value={goldDelta} onChange={event => setGoldDelta(event.target.value)} /></FormField>
            <FormField id="ore-delta" label="Ore delta"><Input id="ore-delta" type="number" value={oreDelta} onChange={event => setOreDelta(event.target.value)} /></FormField>
            <FormField id="food-delta" label="Food delta"><Input id="food-delta" type="number" value={foodDelta} onChange={event => setFoodDelta(event.target.value)} /></FormField>
          </div>
        ) : null}
        {action === 'set_trophies' ? <FormField id="trophy-count" label="Authoritative trophy count"><Input id="trophy-count" type="number" min="0" value={trophies} onChange={event => setTrophies(event.target.value)} /></FormField> : null}
        {action === 'set_shield' ? <FormField id="shield-minutes" label="Shield duration in minutes" hint="Set 0 to remove the shield immediately."><Input id="shield-minutes" type="number" min="0" value={shieldMinutes} onChange={event => setShieldMinutes(event.target.value)} /></FormField> : null}
        {action === 'rename' ? <FormField id="new-username" label="New username"><Input id="new-username" minLength={3} maxLength={18} value={newUsername} onChange={event => setNewUsername(event.target.value)} /></FormField> : null}
        {action === 'set_test_mode' ? <>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-4">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div><strong className="block text-sm">Player test-mode policy</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">Inheritance follows the realm-wide setting. An override remains in effect when the global setting changes.</p></div>
              <TestModePill value={player.testMode} testId="player-test-mode-current" />
            </div>
            <FormField id="player-test-mode-override" label="Policy">
              <Select value={testModeOverride} onValueChange={value => setTestModeOverride(String(value) as 'inherit' | 'enabled' | 'disabled')}>
                <SelectTrigger id="player-test-mode-override" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="inherit">Inherit realm setting</SelectItem><SelectItem value="enabled">Enabled for this player</SelectItem><SelectItem value="disabled">Disabled for this player</SelectItem></SelectContent>
              </Select>
            </FormField>
          </div>
          <Alert className="border-amber-500/25 bg-amber-500/[0.04]"><FlaskConical className="text-amber-700 dark:text-amber-300" /><AlertTitle>Testing privileges</AlertTitle><AlertDescription>When effective, this player receives infinite resources, instant upgrades, and access to every trainable troop.</AlertDescription></Alert>
        </> : null}
        {action === 'send_notice' ? <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="notice-title" label="Notice title"><Input id="notice-title" maxLength={80} value={noticeTitle} onChange={event => setNoticeTitle(event.target.value)} /></FormField>
            <FormField id="notice-severity" label="Severity">
              <Select value={noticeSeverity} onValueChange={value => setNoticeSeverity(String(value))}>
                <SelectTrigger id="notice-severity" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="info">Information</SelectItem><SelectItem value="warning">Warning</SelectItem><SelectItem value="critical">Critical</SelectItem></SelectContent>
              </Select>
            </FormField>
          </div>
          <FormField id="notice-message" label="Notice to player"><Textarea id="notice-message" rows={4} maxLength={500} value={message} onChange={event => setMessage(event.target.value)} /></FormField>
        </> : null}
        {action === 'set_access' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField id="access-state" label="Access state">
              <Select value={access} onValueChange={value => setAccess(String(value))}>
                <SelectTrigger id="access-state" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="active">Active</SelectItem><SelectItem value="suspended">Suspended</SelectItem><SelectItem value="banned">Banned</SelectItem></SelectContent>
              </Select>
            </FormField>
            <FormField id="access-until" label="Until" hint="Leave blank for an indefinite restriction."><Input id="access-until" type="datetime-local" value={accessUntil} onChange={event => setAccessUntil(event.target.value)} /></FormField>
          </div>
        ) : null}
        {action === 'revoke_sessions' ? <Alert><AlertTriangle /><AlertTitle>Every active device will be signed out</AlertTitle><AlertDescription>The player must authenticate again on each device.</AlertDescription></Alert> : null}
        <Separator />
        <FormField id="action-reason" label="Required reason" hint="Written permanently to the audit trail. Minimum 8 characters."><Textarea id="action-reason" ref={reasonRef} rows={3} minLength={8} maxLength={500} placeholder="Explain why this intervention is necessary…" value={reason} onChange={event => setReason(event.target.value)} required /></FormField>
        <FormField id="action-confirmation" label="Type CONFIRM to authorize"><Input id="action-confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="CONFIRM" required /></FormField>
        {error ? <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>Action failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" type="submit" disabled={!valid || busy}>{busy ? <LoaderCircle className="animate-spin" /> : <ShieldAlert />}{busy ? 'Applying…' : 'Authorize action'}</Button>
        </DialogFooter>
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
  const sheetStartRef = useRef<HTMLDivElement | null>(null)
  const { state, refreshing, reload } = useAdminData(`players/${encodeURIComponent(playerId)}`, onUnauthorized)
  const [action, setAction] = useState<PlayerAction | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const data = state.kind === 'ready' ? asRecord(state.data) : fallback
  const resources = asRecord(data.resources ?? asRecord(data.world).resources)
  const profile = asRecord(data.profile ?? data.account)
  const world = asRecord(data.world)
  const village = asRecord(data.village)
  const revisions = asRecord(data.revisions)
  return (
    <Sheet open onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className="w-[min(100%,44rem)] sm:max-w-2xl" initialFocus={sheetStartRef}>
        <SheetHeader ref={sheetStartRef} tabIndex={-1} className="border-b pr-14 outline-none">
          <Badge variant="outline" className="mb-1">Player record</Badge>
          <SheetTitle className="text-lg">{textValue(data, ['username', 'name'], playerId)}</SheetTitle>
          <SheetDescription className="font-mono">{playerId}</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-5">
            {state.kind === 'error' ? <Alert variant="destructive"><AlertCircle /><AlertTitle>Detail request failed</AlertTitle><AlertDescription className="flex items-center justify-between gap-3"><span>Showing directory data instead.</span><Button variant="outline" size="sm" type="button" onClick={reload}>Retry</Button></AlertDescription></Alert> : null}
            {notice ? <Alert role="status" className="border-emerald-500/30 bg-emerald-500/5"><CheckCircle2 className="text-emerald-600" /><AlertTitle>Player updated</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
            {refreshing ? <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-[0.6875rem] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" /><span>Refreshing authoritative balances…</span></div> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['Trophies', formatMetric(data.trophies, false)],
                ['Gold', formatMetric(resources.gold ?? data.gold)],
                ['Ore', formatMetric(resources.ore ?? data.ore)],
                ['Food', formatMetric(resources.food ?? data.food)],
                ['Sessions', formatMetric(data.activeSessions, false)],
                ['Active raids', formatMetric(data.activeAttacks, false)],
                ['Buildings', formatMetric(data.buildingCount, false)],
                ['Population', formatMetric(data.population, false)],
              ] as const).map(([label, value]) => <Card key={label} size="sm" className="bg-muted/30"><CardContent><span className="block text-[0.625rem] uppercase tracking-wide text-muted-foreground">{label}</span><strong className="mt-1 block text-base font-semibold tabular-nums">{value}</strong></CardContent></Card>)}
            </div>
            {state.kind === 'loading' ? (
              <Card size="sm"><CardHeader><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-64 max-w-full" /></CardHeader><CardContent><Skeleton className="aspect-[16/9] w-full" /></CardContent></Card>
            ) : Object.keys(village).length ? (
              <Suspense fallback={<Card size="sm"><CardContent><Skeleton className="aspect-[16/9] w-full" /></CardContent></Card>}>
                <PlayerVillagePreview village={village} playerName={textValue(data, ['username', 'name'], playerId)} />
              </Suspense>
            ) : (
              <Alert><AlertTitle>No village snapshot</AlertTitle><AlertDescription>This account does not currently own a complete persisted village.</AlertDescription></Alert>
            )}
            <Card size="sm">
              <CardHeader className="border-b"><CardTitle>Account state</CardTitle><CardDescription>Authoritative profile and world metadata</CardDescription></CardHeader>
              <CardContent><dl className="divide-y">
                <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0"><dt className="text-muted-foreground">Access</dt><dd><StatusPill value={data.access ?? profile.access ?? data.status ?? 'active'} /></dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Test mode</dt><dd><TestModePill value={data.testMode} testId="player-detail-test-mode" /></dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Registered</dt><dd className="text-right">{formatDate(data.createdAt ?? profile.createdAt)}</dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Last seen</dt><dd className="text-right">{formatDate(data.lastSeenAt ?? profile.lastSeenAt ?? data.updatedAt)}</dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Plot</dt><dd className="text-right">{world.worldId ? `${textValue(world, ['worldId'], '?')} · ` : ''}{textValue(world, ['x'], textValue(data, ['plotX'], '?'))}, {textValue(world, ['y'], textValue(data, ['plotY'], '?'))}</dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Shield until</dt><dd className="text-right">{formatDate(data.shieldUntil ?? profile.shieldUntil)}</dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Access until</dt><dd className="text-right">{formatDate(data.accessUntil)}</dd></div>
                <div className="flex items-start justify-between gap-4 py-2.5"><dt className="text-muted-foreground">Moderation reason</dt><dd className="max-w-64 text-right">{textValue(data, ['moderationReason'], '—')}</dd></div>
                <div className="flex items-center justify-between gap-4 py-2.5 last:pb-0"><dt className="text-muted-foreground">Revisions</dt><dd className="font-mono">P {formatMetric(revisions.profile, false)} · E {formatMetric(revisions.economy, false)} · L {formatMetric(revisions.layout, false)}</dd></div>
              </dl></CardContent>
            </Card>
            <div>
              <div className="mb-2"><h3 className="font-medium">Operator actions</h3><p className="text-xs text-muted-foreground">Each change requires a reason and explicit confirmation.</p></div>
              <div className="grid gap-2 sm:grid-cols-2">
                {PLAYER_ACTIONS.map(item => { const Icon = item.icon; return <Button variant={item.danger ? 'destructive' : 'outline'} className="h-auto justify-start gap-3 p-3 text-left whitespace-normal" type="button" key={item.type} onClick={() => setAction(item.type)}><span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/60"><Icon className="size-4" /></span><span><strong className="block">{item.label}</strong><span className="mt-0.5 block text-[0.6875rem] font-normal leading-4 opacity-70">{item.detail}</span></span></Button> })}
              </div>
            </div>
          </div>
        </ScrollArea>
      {action ? <PlayerActionDialog action={action} player={data} onClose={() => setAction(null)} onUnauthorized={onUnauthorized} onComplete={message => { setAction(null); setNotice(message); reload(); onChanged() }} /> : null}
      </SheetContent>
    </Sheet>
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
      <Panel title="Player directory" eyebrow={`${rows.length} loaded`} className="min-w-0">
        <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={event => { event.preventDefault(); setQuery(queryDraft.trim()); setStatus(statusDraft) }}>
          <div className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Label htmlFor="player-search" className="sr-only">Search player ID or username</Label><Input id="player-search" type="search" className="pl-8" value={queryDraft} onChange={event => setQueryDraft(event.target.value)} placeholder="Search username or player ID…" /></div>
          <Label htmlFor="player-status" className="sr-only">Filter account access</Label>
          <Select value={statusDraft} onValueChange={value => setStatusDraft(String(value))}>
            <SelectTrigger id="player-status" className="w-full sm:w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All access states</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="suspended">Suspended</SelectItem><SelectItem value="banned">Banned</SelectItem></SelectContent>
          </Select>
          <Button type="submit"><Search data-icon="inline-start" />Search</Button>
        </form>
        <StateSurface state={state} onRetry={reload}>{data => {
          const playerRows = rowsFrom(data, ['players', 'items', 'results']).filter(player => status === 'all' || String(player.access ?? 'active') === status)
          if (!playerRows.length) return <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-10 text-center text-muted-foreground">No players match these filters.</div>
          return (
            <div className="overflow-hidden rounded-lg border"><Table><TableCaption className="sr-only">Player accounts and authoritative status</TableCaption><TableHeader><TableRow><TableHead>Player</TableHead><TableHead>Access</TableHead><TableHead>Test mode</TableHead><TableHead>Trophies</TableHead><TableHead>Resources</TableHead><TableHead>Plot</TableHead><TableHead>Last seen</TableHead><TableHead><span className="sr-only">Open</span></TableHead></TableRow></TableHeader><TableBody>
              {playerRows.map((player, index) => {
                const resources = asRecord(player.resources)
                const playerId = idOf(player)
                const world = asRecord(player.world)
                return <TableRow key={playerId || index}><TableCell><strong className="block font-medium">{textValue(player, ['username', 'name'], 'Unnamed')}</strong><code className="block text-[0.6875rem] text-muted-foreground">{playerId || 'no id'}</code></TableCell><TableCell><StatusPill value={player.access ?? player.status ?? 'active'} /></TableCell><TableCell><TestModePill value={player.testMode} testId={playerId ? `player-test-mode-${playerId}` : undefined} /></TableCell><TableCell className="tabular-nums">{formatMetric(player.trophies, false)}</TableCell><TableCell className="text-muted-foreground">{Object.keys(resources).length ? `G ${formatMetric(resources.gold)} · O ${formatMetric(resources.ore)} · F ${formatMetric(resources.food)}` : 'Inspect for balances'}</TableCell><TableCell>{world.worldId ? `${textValue(world, ['worldId'], '?')} · ` : ''}{textValue(world, ['x'], '?')}, {textValue(world, ['y'], '?')}</TableCell><TableCell>{formatDate(player.lastSeenAt ?? player.updatedAt)}</TableCell><TableCell><Button variant="ghost" size="sm" type="button" onClick={() => setSelected(player)} disabled={!playerId}>Inspect<ArrowRight data-icon="inline-end" /></Button></TableCell></TableRow>
              })}
            </TableBody></Table></div>
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
  if (!resources.length) return <div className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground">No per-resource breakdown was returned.</div>
  const values = resources.map(row => Number(row.value ?? row.total ?? row.balance ?? row.amount ?? 0))
  const maximum = Math.max(1, ...values)
  return <div className="space-y-4">{resources.map((row, index) => <Progress key={textValue(row, ['name', 'resource', 'type'], String(index))} value={Math.max(2, values[index] / maximum * 100)}><ProgressLabel className="capitalize">{textValue(row, ['name', 'resource', 'type'], `Resource ${index + 1}`)}</ProgressLabel><ProgressValue>{() => formatMetric(values[index])}</ProgressValue></Progress>)}</div>
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
        return <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Window sources" value={sources} detail={`${days.length} daily buckets`} tone="green" />
            <MetricCard label="Window sinks" value={sinks} detail="Resources removed" tone="red" />
            <MetricCard label="Net issuance" value={net} detail={net > 0 ? 'Inflationary window' : net < 0 ? 'Deflationary window' : 'Balanced window'} tone={net > 0 ? 'gold' : 'blue'} />
            <MetricCard label="Economy events" value={events} detail="Saves, trades, and raids" tone="blue" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Panel title="Resource issuance" eyebrow="Relative source totals"><ResourceBars data={{ resources: sourceByResource }} /></Panel>
            <Panel title="Today's activity" eyebrow={formatWorldDay(today.day)}>
              <dl className="divide-y">
                <div className="flex items-center justify-between py-3 first:pt-0"><dt className="text-muted-foreground">Battle settlements</dt><dd className="font-medium tabular-nums">{formatMetric(todayCounts.battles, false)}</dd></div>
                <div className="flex items-center justify-between py-3"><dt className="text-muted-foreground">Bot raids</dt><dd className="font-medium tabular-nums">{formatMetric(todayCounts.botRaids, false)}</dd></div>
                <div className="flex items-center justify-between py-3"><dt className="text-muted-foreground">Trades / saves</dt><dd className="font-medium tabular-nums">{formatMetric(todayCounts.trades, false)} / {formatMetric(todayCounts.saves, false)}</dd></div>
                <div className="flex items-center justify-between py-3 last:pb-0"><dt className="text-muted-foreground">Loot transferred</dt><dd className="font-medium tabular-nums">{formatMetric(Object.values(asRecord(today.loot)).reduce<number>((sum, value) => sum + Number(value ?? 0), 0))}</dd></div>
              </dl>
            </Panel>
          </div>
          <Panel title="Daily economy history" eyebrow="Authoritative aggregates">
            {days.length ? <div className="overflow-hidden rounded-lg border"><Table><TableCaption className="sr-only">Daily economy sources, sinks, refunds, loot, and event counts</TableCaption><TableHeader><TableRow><TableHead>Day</TableHead><TableHead>Faucets</TableHead><TableHead>Sinks</TableHead><TableHead>Refunds</TableHead><TableHead>Loot moved</TableHead><TableHead>Saves</TableHead><TableHead>Trades</TableHead><TableHead>Battles / bot raids</TableHead></TableRow></TableHeader><TableBody>{days.map((day, index) => { const counts = asRecord(day.counts); const bucketTotal = (key: string) => Object.values(asRecord(day[key])).reduce<number>((sum, value) => sum + Number(value ?? 0), 0); return <TableRow key={textValue(day, ['day'], String(index))}><TableCell>{formatWorldDay(day.day)}</TableCell><TableCell className="font-medium text-emerald-700 tabular-nums">{formatMetric(bucketTotal('faucets'))}</TableCell><TableCell className="font-medium text-destructive tabular-nums">{formatMetric(bucketTotal('sinks'))}</TableCell><TableCell className="tabular-nums">{formatMetric(bucketTotal('refunds'))}</TableCell><TableCell className="tabular-nums">{formatMetric(bucketTotal('loot'))}</TableCell><TableCell className="tabular-nums">{formatMetric(counts.saves, false)}</TableCell><TableCell className="tabular-nums">{formatMetric(counts.trades, false)}</TableCell><TableCell className="tabular-nums">{formatMetric(counts.battles, false)} / {formatMetric(counts.botRaids, false)}</TableCell></TableRow> })}</TableBody></Table></div> : <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">No daily economy buckets were returned.</div>}
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
        return <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"><MetricCard label="Loaded raids" value={attacks.length} detail="Current result window" /><MetricCard label="In progress" value={active} detail="Across live lifecycle states" tone="blue" /><MetricCard label="Settled" value={settled} detail="Finalized authoritative raids" tone="green" /><MetricCard label="Cancelled / expired" value={cancelled} detail="Closed without settlement" tone="red" /><MetricCard label="Latest simulation" value={`v${simulationVersion}`} detail="Highest loaded ruleset" tone="gold" /></div>
          <Panel title="Raid ledger" eyebrow="Newest first">
            {attacks.length ? <div className="overflow-hidden rounded-lg border"><Table><TableCaption className="sr-only">Authoritative attack lifecycle records</TableCaption><TableHeader><TableRow><TableHead>Attack</TableHead><TableHead>State</TableHead><TableHead>Attacker</TableHead><TableHead>Target</TableHead><TableHead>World / plot</TableHead><TableHead>Versions</TableHead><TableHead>Created</TableHead><TableHead>Deadline / ended</TableHead></TableRow></TableHeader><TableBody>{attacks.map((attack, index) => <TableRow key={textValue(attack, ['id', 'attackId'], String(index))}><TableCell><code className="text-[0.6875rem]">{textValue(attack, ['id', 'attackId'], '—')}</code></TableCell><TableCell><StatusPill value={attack.state ?? attack.status} /></TableCell><TableCell><code className="text-[0.6875rem]">{textValue(attack, ['attackerId'], '—')}</code></TableCell><TableCell><strong className="block font-medium">{textValue(attack, ['targetKind'], 'target')}</strong><code className="text-[0.6875rem] text-muted-foreground">{textValue(attack, ['targetId', 'defenderId'], '—')}</code></TableCell><TableCell>{textValue(attack, ['worldId'], '?')} · {textValue(attack, ['targetX'], '?')}, {textValue(attack, ['targetY'], '?')}</TableCell><TableCell className="tabular-nums">state {formatMetric(attack.stateVersion, false)} · sim v{formatMetric(attack.simulationVersion, false)}</TableCell><TableCell>{formatDate(attack.createdAt)}</TableCell><TableCell>{formatDate(attack.endedAt ?? attack.deadlineAt)}</TableCell></TableRow>)}</TableBody></Table></div> : <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">There are no attacks in this result window.</div>}
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
        return <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Persistent villages" value={bots.length} detail="Loaded server records" /><MetricCard label="World partitions" value={worlds.size} detail="Represented in this window" tone="blue" /><MetricCard label="Highest revision" value={Math.max(0, ...revisions)} detail="Durable mutation counter" tone="green" /><MetricCard label="Unprovenanced" value={bots.filter(bot => !bot.generatorVersion && !bot.seed).length} detail="Should remain zero" tone="red" /></div>
          <Panel title="Bot village registry" eyebrow="Persisted before presentation">
            <div className="relative mb-4"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Label htmlFor="bot-filter" className="sr-only">Filter bot villages</Label><Input id="bot-filter" className="pl-8" type="search" placeholder="Filter ID, world, coordinate, or difficulty…" value={query} onChange={event => setQuery(event.target.value)} /></div>
            {shown.length ? <div className="overflow-hidden rounded-lg border"><Table><TableCaption className="sr-only">Persisted server bot villages and generator provenance</TableCaption><TableHeader><TableRow><TableHead>Village</TableHead><TableHead>World / plot</TableHead><TableHead>Difficulty</TableHead><TableHead>Revision</TableHead><TableHead>Generator</TableHead><TableHead>Trophies</TableHead><TableHead>Buildings</TableHead><TableHead>Resources</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{shown.map((bot, index) => { const world = asRecord(bot.world); const resources = asRecord(bot.resources ?? world.resources); const buildings = Array.isArray(world.buildings) ? world.buildings.length : Number(bot.buildingCount ?? 0); return <TableRow key={idOf(bot) || index}><TableCell><strong className="block font-medium">{textValue(bot, ['username', 'name'], 'Bot village')}</strong><code className="block text-[0.6875rem] text-muted-foreground">{idOf(bot)}</code></TableCell><TableCell>{textValue(bot, ['worldId'], '?')} · {textValue(bot, ['x', 'plotX'], '?')}, {textValue(bot, ['y', 'plotY'], '?')}</TableCell><TableCell><StatusPill value={asRecord(bot.profile).difficulty ?? bot.difficulty ?? 'unknown'} /></TableCell><TableCell className="tabular-nums">{formatMetric(bot.revision, false)}</TableCell><TableCell>v{textValue(bot, ['generatorVersion'], '?')}</TableCell><TableCell className="tabular-nums">{formatMetric(bot.trophies, false)}</TableCell><TableCell className="tabular-nums">{formatMetric(buildings, false)}</TableCell><TableCell>G {formatMetric(resources.gold)} · O {formatMetric(resources.ore)} · F {formatMetric(resources.food)}</TableCell><TableCell>{formatDate(bot.updatedAt)}</TableCell></TableRow> })}</TableBody></Table></div> : <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">No bot villages match this filter.</div>}
          </Panel>
          <Alert><Bot /><AlertTitle>Persistence invariant</AlertTitle><AlertDescription>This console never generates, previews, or repairs a bot client-side. Missing villages must be provisioned by the server and committed before any consumer can observe them.</AlertDescription></Alert>
        </div>
      }}</StateSurface>
    </>
  )
}

type OperationType = 'clear_shields' | 'set_maintenance' | 'set_test_mode'

function OperationDialog({ operation, initialEnabled = true, onClose, onComplete, onUnauthorized }: {
  operation: OperationType
  initialEnabled?: boolean
  onClose: () => void
  onComplete: (message: string) => void
  onUnauthorized: () => void
}) {
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [enabled, setEnabled] = useState(initialEnabled)
  const [message, setMessage] = useState('Scheduled maintenance is in progress. Please try again shortly.')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = operation === 'clear_shields'
    ? 'Clear every player shield'
    : operation === 'set_test_mode' ? 'Set realm test mode' : 'Set maintenance mode'
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (reason.trim().length < 8 || confirmation !== 'CONFIRM') return
    setBusy(true)
    setError(null)
    try {
      await adminApi.post('operations', {
        type: operation,
        reason: reason.trim(),
        ...(operation === 'set_maintenance'
          ? { enabled, message: enabled ? message.trim() : '' }
          : operation === 'set_test_mode' ? { enabled } : {}),
      })
      onComplete(`${label} completed.`)
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.unauthorized) onUnauthorized()
      else setError(caught instanceof Error ? caught.message : 'The operation could not be completed.')
    } finally { setBusy(false) }
  }
  return <DialogFrame title={label} subtitle="This is a global, security-sensitive operation." onClose={onClose}><form className="grid gap-4" onSubmit={submit}>
    {operation === 'set_maintenance' ? <>
      <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-3"><div><Label htmlFor="maintenance-enabled" className="font-medium">Maintenance enabled</Label><p className="mt-0.5 text-xs text-muted-foreground">Blocks normal game traffic while preserving the admin route.</p></div><Switch id="maintenance-enabled" checked={enabled} onCheckedChange={setEnabled} /></div>
      {enabled ? <FormField id="maintenance-message" label="Player-facing message"><Textarea id="maintenance-message" rows={3} maxLength={300} value={message} onChange={event => setMessage(event.target.value)} /></FormField> : null}
    </> : operation === 'set_test_mode' ? <>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-4">
        <div><Label htmlFor="global-test-mode-enabled" className="font-medium">Realm-wide test mode</Label><p className="mt-1 text-xs leading-5 text-muted-foreground">Applies to every player who does not have an individual override.</p></div>
        <Switch id="global-test-mode-enabled" checked={enabled} onCheckedChange={setEnabled} aria-label="Realm-wide test mode" />
      </div>
      <Alert className="border-amber-500/25 bg-amber-500/[0.04]"><FlaskConical className="text-amber-700 dark:text-amber-300" /><AlertTitle>{enabled ? 'Enable testing privileges realm-wide' : 'Return inherited players to normal rules'}</AlertTitle><AlertDescription>Individual player overrides remain unchanged. Enabled players receive infinite resources, instant upgrades, and every trainable troop.</AlertDescription></Alert>
    </> : <Alert variant="destructive"><AlertTriangle /><AlertTitle>All active shields will be removed</AlertTitle><AlertDescription>Players can become attackable immediately. This operation cannot be scoped or undone automatically.</AlertDescription></Alert>}
    <Separator />
    <FormField id="operation-reason" label="Required reason" hint="Written permanently to the audit trail. Minimum 8 characters."><Textarea id="operation-reason" rows={3} minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the incident, release, or support need…" required /></FormField>
    <FormField id="operation-confirmation" label="Type CONFIRM to authorize"><Input id="operation-confirmation" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="CONFIRM" /></FormField>
    {error ? <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>Operation failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
    <DialogFooter><Button variant="outline" type="button" onClick={onClose}>Cancel</Button><Button variant={operation === 'set_test_mode' ? 'default' : 'destructive'} type="submit" disabled={busy || reason.trim().length < 8 || confirmation !== 'CONFIRM'}>{busy ? <LoaderCircle className="animate-spin" /> : operation === 'set_test_mode' ? <FlaskConical /> : <ShieldAlert />}{busy ? 'Applying…' : operation === 'set_test_mode' ? `${enabled ? 'Enable' : 'Disable'} globally` : 'Authorize globally'}</Button></DialogFooter>
  </form></DialogFrame>
}

type ResetAllBasesStep = 'scope' | 'confirm' | 'running' | 'complete'

const RESET_RESULT_FIELDS = [
  ['accountsPreserved', 'Accounts preserved'],
  ['sessionsPreserved', 'Login sessions preserved'],
  ['playerPlotsPreserved', 'Player plots preserved'],
  ['playerVillagesReset', 'Player villages reset'],
  ['botVillagesPurged', 'Bot villages purged'],
  ['attacksPurged', 'Attack records purged'],
  ['combatRecordsPurged', 'Combat records purged'],
  ['notificationsPurged', 'Notifications purged'],
  ['economyRecordsPurged', 'Economy records purged'],
  ['auxiliaryRecordsPurged', 'Auxiliary records purged'],
] as const

function resetResultRows(payload: unknown): { label: string; value: number }[] {
  const root = asRecord(unwrapData(payload))
  const summary = asRecord(root.resetSummary)
  const rows: { label: string; value: number }[] = []
  for (const [field, label] of RESET_RESULT_FIELDS) {
    const value = Number(summary[field])
    if (!Number.isFinite(value)) continue
    rows.push({ label, value })
  }
  if (!rows.length && Number.isFinite(Number(root.affected))) {
    rows.push({ label: 'Player villages reset', value: Number(root.affected) })
  }
  return rows
}

function ResetAllBasesDialog({ onClose, onReset, onUnauthorized }: {
  onClose: () => void
  onReset: (message: string) => void
  onUnauthorized: () => void
}) {
  const [step, setStep] = useState<ResetAllBasesStep>('scope')
  const [acknowledged, setAcknowledged] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [result, setResult] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (step === 'confirm') window.requestAnimationFrame(() => reasonRef.current?.focus())
  }, [step])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (reason.trim().length < 12 || confirmation !== RESET_ALL_BASES_CONFIRMATION) return
    setStep('running')
    setError(null)
    try {
      const payload = await adminApi.resetAllBases(reason.trim(), confirmation)
      setResult(payload)
      refreshAdminData()
      setStep('complete')
      onReset('Every player village was reset and all base-scoped data was purged. Admin data has been refreshed.')
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.unauthorized) {
        onUnauthorized()
        return
      }
      const maintenanceRequired = caught instanceof AdminApiError
        && caught.code === 'ADMIN_MAINTENANCE_REQUIRED'
      setError(maintenanceRequired
        ? 'Maintenance mode must be enabled before the realm can be reset. Close this dialog, configure maintenance mode, then try again.'
        : caught instanceof Error ? caught.message : 'The realm reset could not be completed.')
      setStep('confirm')
    }
  }

  const stepNumber = step === 'scope' ? 1 : step === 'complete' ? 3 : 2
  const resultRows = resetResultRows(result)
  return <DialogFrame
    title="Reset every base"
    subtitle="Permanently replace all villages and purge base-scoped realm data."
    onClose={() => { if (step !== 'running') onClose() }}
  >
    <div className="grid grid-cols-3 gap-2" aria-label={`Step ${stepNumber} of 3`}>
      {(['Review scope', 'Confirm reset', 'Complete'] as const).map((label, index) => {
        const number = index + 1
        const active = number === stepNumber
        const done = number < stepNumber
        return <div className={cn('rounded-lg border px-2.5 py-2', active && 'border-destructive/40 bg-destructive/5', done && 'bg-muted/50')} key={label}>
          <span className={cn('mb-1 flex size-5 items-center justify-center rounded-full border text-[0.625rem] font-semibold', active && 'border-destructive bg-destructive text-white', done && 'border-emerald-600 bg-emerald-600 text-white')}>{done ? <CheckCircle2 className="size-3" /> : number}</span>
          <strong className="block text-[0.6875rem] leading-4">{label}</strong>
        </div>
      })}
    </div>

    {step === 'scope' ? <div className="grid gap-4">
      <Alert variant="destructive"><DatabaseZap /><AlertTitle>Realm-wide, irreversible reset</AlertTitle><AlertDescription>This replaces every player village with the current starter configuration and permanently deletes auxiliary base data across all worlds.</AlertDescription></Alert>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-destructive/20 bg-destructive/[0.025] p-3">
          <strong className="text-destructive">Reset or purged</strong>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[0.6875rem] leading-4 text-muted-foreground">
            <li>Every player layout, resource balance, army, and upgrade state</li>
            <li>Every persistent bot village</li>
            <li>Base-scoped combat, economy, notification, and history data</li>
          </ul>
        </div>
        <div className="rounded-lg border bg-muted/25 p-3">
          <strong>Preserved</strong>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-[0.6875rem] leading-4 text-muted-foreground">
            <li>Accounts, credentials, login sessions, and moderation state</li>
            <li>Admin configuration and the immutable audit trail</li>
            <li>Each player’s current world and plot coordinates</li>
          </ul>
        </div>
      </div>
      <Alert><ShieldAlert /><AlertTitle>Maintenance mode is required</AlertTitle><AlertDescription>Enable maintenance mode before authorizing the reset. It fences game traffic while the server performs the guarded purge. Each rebuilt starter village will have an empty flag and must choose a variant again.</AlertDescription></Alert>
      <label className="flex items-start gap-3 rounded-lg border p-3" htmlFor="reset-scope-acknowledgement">
        <Checkbox id="reset-scope-acknowledgement" className="mt-0.5" checked={acknowledged} onCheckedChange={setAcknowledged} />
        <span><strong className="block font-medium">I understand the full realm scope</strong><span className="mt-0.5 block text-[0.6875rem] leading-4 text-muted-foreground">There is no undo or per-player recovery from this operation.</span></span>
      </label>
      <DialogFooter><Button variant="outline" type="button" onClick={onClose}>Cancel</Button><Button variant="destructive" type="button" disabled={!acknowledged} onClick={() => setStep('confirm')}>Continue to confirmation<ArrowRight data-icon="inline-end" /></Button></DialogFooter>
    </div> : null}

    {step === 'confirm' ? <form className="grid gap-4" onSubmit={submit}>
      <Alert variant="destructive"><AlertTriangle /><AlertTitle>Final authorization</AlertTitle><AlertDescription>Maintenance mode must already be enabled. On submission, the purge starts immediately and cannot be cancelled.</AlertDescription></Alert>
      <FormField id="reset-all-bases-reason" label="Required audit reason" hint="Written permanently to the admin audit trail. Minimum 12 characters."><Textarea ref={reasonRef} id="reset-all-bases-reason" rows={3} minLength={12} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain why the entire realm must be reset…" required /></FormField>
      <FormField id="reset-all-bases-confirmation" label={`Type ${RESET_ALL_BASES_CONFIRMATION} exactly`} hint="Case and spacing must match."><Input id="reset-all-bases-confirmation" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder={RESET_ALL_BASES_CONFIRMATION} /></FormField>
      {error ? <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>Reset blocked</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      <DialogFooter><Button variant="outline" type="button" onClick={() => { setError(null); setStep('scope') }}>Back</Button><Button variant="destructive" type="submit" disabled={reason.trim().length < 12 || confirmation !== RESET_ALL_BASES_CONFIRMATION}><DatabaseZap />Reset every base permanently</Button></DialogFooter>
    </form> : null}

    {step === 'running' ? <div className="grid gap-4 py-2" role="status" aria-live="polite">
      <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/[0.025] p-4"><LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-destructive" /><div><strong className="block">Resetting the realm…</strong><p className="mt-1 text-xs leading-5 text-muted-foreground">The server is running the guarded village replacement and base-data purge. Keep this window open.</p></div></div>
      <Progress value={null} aria-label="Realm reset in progress" className="[&_[data-slot=progress-indicator]]:w-1/2 [&_[data-slot=progress-indicator]]:animate-pulse [&_[data-slot=progress-indicator]]:bg-destructive"><ProgressLabel>Authoritative purge in progress</ProgressLabel></Progress>
    </div> : null}

    {step === 'complete' ? <div className="grid gap-4">
      <Alert className="border-emerald-500/30 bg-emerald-500/5" role="status"><CheckCircle2 className="text-emerald-600" /><AlertTitle>Realm reset complete</AlertTitle><AlertDescription>Every account now has a fresh starter village with an empty flag. Dashboard, player, world, combat, economy, and audit data have been refreshed.</AlertDescription></Alert>
      {resultRows.length ? <div className="grid gap-2 sm:grid-cols-2">{resultRows.map(row => <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2" key={row.label}><span className="text-muted-foreground">{row.label}</span><strong className="tabular-nums">{formatMetric(row.value, false)}</strong></div>)}</div> : null}
      <DialogFooter><Button type="button" onClick={onClose}>Close</Button></DialogFooter>
    </div> : null}
  </DialogFrame>
}

function LiveOpsView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state: configState } = useAdminData('config', onUnauthorized)
  const [operation, setOperation] = useState<OperationType | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const config = configState.kind === 'ready' ? asRecord(configState.data) : {}
  const testMode = asRecord(config.testMode)
  const testModeReady = configState.kind === 'ready'
  const testModeEnabled = testMode.enabled === true
  const testModeOverrideCount = Math.max(0, Number(testMode.overrideCount) || 0)
  const capabilities = [
    ['Player support', 'Search, balances, trophies, names, shields, access, notices', 'Available'],
    ['Session control', 'Revoke every session belonging to one player', 'Available'],
    ['Economy correction', 'Explicit resource deltas with permanent operator reason', 'Available'],
    ['World observability', 'Persistent bot provenance, revisions, plots, resources', 'Read only'],
    ['Combat investigation', 'Attack lifecycle, simulation version, loot, replay references', 'Read only'],
    ['Maintenance mode', 'Enable or disable the player-facing maintenance gate', 'Available'],
    ['Test mode', 'Global testing privileges with explicit per-player overrides', 'Available'],
    ['Global shield clear', 'Remove active protection from all accounts', 'Available'],
    ['Full base reset', 'Rebuild every player village and purge base-scoped realm data', 'Available'],
    ['Audit & configuration', 'Operator history plus safely redacted runtime config', 'Available'],
  ] as const
  return <>
    <SectionHeading eyebrow="Live operations" title="Global controls">High-impact runtime tools. Every mutation requires an explicit reason and typed confirmation.</SectionHeading>
    {notice ? <Alert role="status" className="border-emerald-500/30 bg-emerald-500/5"><CheckCircle2 className="text-emerald-600" /><AlertTitle>Operation complete</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
      <Card className="shadow-xs"><CardHeader><div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><RadioTower className="size-4" /></div><CardTitle>Maintenance mode</CardTitle><CardDescription>Open or close the game to player traffic with a clear player-facing status message.</CardDescription></CardHeader><CardContent><Button type="button" onClick={() => setOperation('set_maintenance')}>Configure maintenance<ArrowRight data-icon="inline-end" /></Button></CardContent></Card>
      <Card data-testid="global-test-mode-card" className={cn('shadow-xs', testModeEnabled && 'border-amber-500/40 bg-amber-500/[0.045]')}>
        <CardHeader>
          <div className="flex items-start justify-between gap-3"><div className={cn('flex size-9 items-center justify-center rounded-lg', testModeEnabled ? 'bg-amber-500 text-amber-950' : 'bg-amber-500/10 text-amber-800 dark:text-amber-200')}><FlaskConical className="size-4" /></div><Badge variant="outline" className={cn(testModeEnabled && 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200')}>{testModeReady ? testModeEnabled ? 'Enabled globally' : 'Disabled globally' : 'Loading status…'}</Badge></div>
          <CardTitle>Test mode</CardTitle>
          <CardDescription>Grant infinite resources, instant upgrades, and every trainable troop to inherited players.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <p className="text-xs text-muted-foreground">{testModeOverrideCount === 0 ? 'No individual player overrides.' : `${testModeOverrideCount.toLocaleString()} individual player override${testModeOverrideCount === 1 ? '' : 's'} active.`}</p>
          <Button type="button" disabled={!testModeReady} onClick={() => setOperation('set_test_mode')}>Configure test mode<ArrowRight data-icon="inline-end" /></Button>
        </CardContent>
      </Card>
      <Card className="border-destructive/20 bg-destructive/[0.025] shadow-xs"><CardHeader><div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-destructive/10 text-destructive"><ShieldAlert className="size-4" /></div><CardTitle>Clear all shields</CardTitle><CardDescription>Remove attack protection globally. Reserved for incident recovery and controlled testing.</CardDescription></CardHeader><CardContent><Button variant="destructive" type="button" onClick={() => setOperation('clear_shields')}>Clear every shield<ArrowRight data-icon="inline-end" /></Button></CardContent></Card>
      <Card className="border-destructive/50 bg-destructive/[0.04] shadow-sm lg:col-span-2 xl:col-span-3">
        <CardHeader className="gap-3 border-b border-destructive/15 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-destructive text-white"><DatabaseZap className="size-4" /></div>
            <div><Badge variant="destructive" className="mb-2">Danger zone</Badge><CardTitle>Reset all bases</CardTitle><CardDescription className="mt-1 max-w-3xl">Replace every player village with the current starter configuration, clear every flag, and purge persistent bots plus base-scoped combat and economy records. Accounts, sessions, moderation, admin configuration, and player coordinates are preserved.</CardDescription></div>
          </div>
          <Badge variant="outline" className="shrink-0 border-destructive/30 text-destructive">Maintenance required</Badge>
        </CardHeader>
        <CardContent className="flex flex-col items-start justify-between gap-3 pt-4 sm:flex-row sm:items-center">
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground">This is irreversible and realm-wide. A two-step review, exact typed phrase, audit reason, and server-side maintenance gate are required.</p>
          <Button variant="destructive" type="button" className="shrink-0" onClick={() => { setNotice(null); setResetOpen(true) }}><DatabaseZap />Review full reset</Button>
        </CardContent>
      </Card>
    </div>
    <Panel title="Administrative capability matrix" eyebrow="Current deployment">
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-2">{capabilities.map(([name, detail, status]) => <div className="flex items-start justify-between gap-4 bg-card p-3" key={name}><div><strong className="font-medium">{name}</strong><p className="mt-0.5 text-xs leading-4 text-muted-foreground">{detail}</p></div><StatusPill value={status === 'Available' ? 'ready' : status} /></div>)}</div>
    </Panel>
    <Alert><ShieldCheck /><AlertTitle>Deliberate safety boundary</AlertTitle><AlertDescription>Database consoles, arbitrary JSON writes, user impersonation, and secret display remain intentionally absent. The full reset is a single audited server operation with an exact scope and maintenance prerequisite.</AlertDescription></Alert>
    {operation ? <OperationDialog operation={operation} initialEnabled={operation === 'set_test_mode' ? testModeEnabled : true} onClose={() => setOperation(null)} onUnauthorized={onUnauthorized} onComplete={message => { setOperation(null); setNotice(message); refreshAdminData() }} /> : null}
    {resetOpen ? <ResetAllBasesDialog onClose={() => setResetOpen(false)} onUnauthorized={onUnauthorized} onReset={setNotice} /> : null}
  </>
}

function AuditView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('audit?limit=250', onUnauthorized)
  const [query, setQuery] = useState('')
  return <>
    <SectionHeading eyebrow="Accountability" title="Immutable audit trail" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>Review who changed what, which record was targeted, and the required operator reason.</SectionHeading>
    <Panel title="Administrative events" eyebrow="Newest first">
      <div className="relative mb-4"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Label htmlFor="audit-filter" className="sr-only">Filter audit events</Label><Input id="audit-filter" className="pl-8" type="search" placeholder="Filter actor, action, target, reason, or request ID…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <StateSurface state={state} onRetry={reload}>{data => {
        const rows = rowsFrom(data, ['entries', 'audit', 'events', 'items']).filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()))
        return rows.length ? <div className="overflow-hidden rounded-lg border"><Table><TableCaption className="sr-only">Permanent operator audit trail</TableCaption><TableHeader><TableRow><TableHead>Time</TableHead><TableHead>Operator</TableHead><TableHead>Action</TableHead><TableHead>Target</TableHead><TableHead>Outcome</TableHead><TableHead>Reason</TableHead><TableHead>Audit ID</TableHead></TableRow></TableHeader><TableBody>{rows.map((row, index) => { const details = asRecord(row.details); return <TableRow key={textValue(row, ['id'], String(index))}><TableCell>{formatDate(row.occurredAt ?? row.createdAt ?? row.timestamp)}</TableCell><TableCell><strong className="font-medium">{textValue(row, ['actor', 'adminUsername', 'username'], 'admin')}</strong></TableCell><TableCell>{textValue(row, ['action', 'type', 'operation'], '—')}</TableCell><TableCell><strong className="block font-medium">{textValue(row, ['targetType'], 'system')}</strong><code className="text-[0.6875rem] text-muted-foreground">{textValue(row, ['targetId', 'playerId'], 'global')}</code></TableCell><TableCell><StatusPill value="recorded" /></TableCell><TableCell className="max-w-80 whitespace-normal">{textValue(details, ['reason'], 'No reason returned')}</TableCell><TableCell><code className="text-[0.6875rem]">{textValue(row, ['id'], '—')}</code></TableCell></TableRow>})}</TableBody></Table></div> : <div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground">No audit events match this filter.</div>
      }}</StateSurface>
    </Panel>
  </>
}

function ConfigTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth > 4) return <code className="text-[0.6875rem] text-muted-foreground">[nested configuration]</code>
  if (Array.isArray(value)) return <span className="text-muted-foreground">{value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(', ') || '[]'}</span>
  if (!value || typeof value !== 'object') return typeof value === 'boolean' ? <StatusPill value={value} /> : <code>{String(value ?? 'null')}</code>
  return <div className="divide-y">{Object.entries(value).map(([key, child]) => <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0" key={key}><strong className="font-medium capitalize">{key.replaceAll('_', ' ')}</strong><ConfigTree value={child} depth={depth + 1} /></div>)}</div>
}

type StarterResource = 'gold' | 'ore' | 'food'

interface StarterBuildingCatalogItem {
  type: string
  name: string
  category: string
  width: number
  height: number
  maxLevel: number
  maxCount: number
}

interface StarterLimits {
  mapSize: number
  maxBalance: number
  maxBuildings: number
}

interface StarterBuildingDraft {
  key: string
  type: string
  level: string
  gridX: string
  gridY: string
}

interface StarterVillageDraft {
  resources: Record<StarterResource, string>
  buildings: StarterBuildingDraft[]
  wallLevel: string
}

interface ValidatedStarterVillage {
  resources: Record<StarterResource, number>
  buildings: { type: string; level: number; gridX: number; gridY: number }[]
  wallLevel: number
}

interface StarterValidation {
  valid: boolean
  value: ValidatedStarterVillage | null
  issues: string[]
  resourceErrors: Partial<Record<StarterResource, string>>
  wallError: string | null
  rowErrors: Record<string, string[]>
}

const STARTER_RESOURCES: readonly { id: StarterResource; label: string }[] = [
  { id: 'gold', label: 'Starting gold' },
  { id: 'ore', label: 'Starting ore' },
  { id: 'food', label: 'Starting food' },
]

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function integerString(value: unknown, fallback: number): string {
  const parsed = Number(value)
  return String(Number.isSafeInteger(parsed) ? parsed : fallback)
}

function parseDraftInteger(value: string): number | null {
  const normalized = value.trim()
  if (!/^-?\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function starterCatalogFrom(config: JsonRecord): StarterBuildingCatalogItem[] {
  if (!Array.isArray(config.buildingCatalog)) return []
  const seen = new Set<string>()
  const catalog: StarterBuildingCatalogItem[] = []
  for (const raw of config.buildingCatalog) {
    const item = asRecord(raw)
    const type = String(item.type ?? '').trim()
    if (!type || seen.has(type)) continue
    seen.add(type)
    catalog.push({
      type,
      name: String(item.name ?? type).trim() || type,
      category: String(item.category ?? 'other').trim() || 'other',
      width: positiveInteger(item.width, 1),
      height: positiveInteger(item.height, 1),
      maxLevel: positiveInteger(item.maxLevel, 1),
      maxCount: positiveInteger(item.maxCount, 1),
    })
  }
  return catalog
}

function starterLimitsFrom(config: JsonRecord): StarterLimits {
  const limits = asRecord(config.starterLimits)
  return {
    mapSize: positiveInteger(limits.mapSize, 25),
    maxBalance: positiveInteger(limits.maxBalance, 1_000_000_000),
    maxBuildings: positiveInteger(limits.maxBuildings, 600),
  }
}

function starterDraftFrom(config: JsonRecord, revision: number): StarterVillageDraft {
  const starterVillage = asRecord(config.starterVillage)
  const resources = asRecord(starterVillage.resources)
  const buildings = Array.isArray(starterVillage.buildings) ? starterVillage.buildings : []
  return {
    resources: {
      gold: integerString(resources.gold, 0),
      ore: integerString(resources.ore, 0),
      food: integerString(resources.food, 0),
    },
    buildings: buildings.map((raw, index) => {
      const building = asRecord(raw)
      return {
        key: `starter-${revision}-${index}`,
        type: String(building.type ?? ''),
        level: integerString(building.level, 1),
        gridX: integerString(building.gridX, 0),
        gridY: integerString(building.gridY, 0),
      }
    }),
    wallLevel: integerString(starterVillage.wallLevel, 1),
  }
}

function comparableStarterDraft(draft: StarterVillageDraft) {
  return {
    resources: draft.resources,
    buildings: draft.buildings.map(({ type, level, gridX, gridY }) => ({ type, level, gridX, gridY })),
    wallLevel: draft.wallLevel,
  }
}

function validateStarterVillage(
  draft: StarterVillageDraft,
  catalog: readonly StarterBuildingCatalogItem[],
  limits: StarterLimits,
): StarterValidation {
  const resourceErrors: Partial<Record<StarterResource, string>> = {}
  const parsedResources = {} as Record<StarterResource, number>
  for (const resource of STARTER_RESOURCES) {
    const value = parseDraftInteger(draft.resources[resource.id])
    if (value === null) resourceErrors[resource.id] = 'Enter a whole number.'
    else if (value < 0 || value > limits.maxBalance) resourceErrors[resource.id] = `Use 0–${limits.maxBalance.toLocaleString()}.`
    else parsedResources[resource.id] = value
  }

  const catalogByType = new Map(catalog.map(item => [item.type, item]))
  const wallDefinition = catalogByType.get('wall')
  const wallLevel = parseDraftInteger(draft.wallLevel)
  const wallLevelMax = wallDefinition?.maxLevel ?? 1
  const wallError = wallLevel === null
    ? 'Enter a whole-number wall level.'
    : wallLevel < 1 || wallLevel > wallLevelMax
      ? `Wall level must be between 1 and ${wallLevelMax}.`
      : null

  const issues: string[] = []
  if (draft.buildings.length > limits.maxBuildings) issues.push(`Starter villages can contain at most ${limits.maxBuildings.toLocaleString()} buildings.`)
  const townHallCount = draft.buildings.filter(building => building.type === 'town_hall').length
  if (townHallCount !== 1) issues.push('A starter village must contain exactly one Town Hall.')

  const rowErrors: Record<string, string[]> = {}
  const addRowError = (key: string, message: string) => {
    const errors = rowErrors[key] ?? []
    if (!errors.includes(message)) errors.push(message)
    rowErrors[key] = errors
  }
  const parsedRows = draft.buildings.map((building, index) => {
    const definition = catalogByType.get(building.type)
    const level = parseDraftInteger(building.level)
    const gridX = parseDraftInteger(building.gridX)
    const gridY = parseDraftInteger(building.gridY)
    if (!definition) addRowError(building.key, 'Choose a supported building type.')
    if (definition && (level === null || level < 1 || level > definition.maxLevel)) {
      addRowError(building.key, `Level must be between 1 and ${definition.maxLevel}.`)
    }
    if (definition && building.type === 'wall' && wallLevel !== null && level !== wallLevel) {
      addRowError(building.key, `Wall rows must use the shared wall level (${wallLevel}).`)
    }
    if (definition) {
      const maxX = limits.mapSize - definition.width
      const maxY = limits.mapSize - definition.height
      if (gridX === null || gridX < 0 || gridX > maxX) addRowError(building.key, `X must be between 0 and ${Math.max(0, maxX)}.`)
      if (gridY === null || gridY < 0 || gridY > maxY) addRowError(building.key, `Y must be between 0 and ${Math.max(0, maxY)}.`)
    }
    return { building, index, definition, level, gridX, gridY }
  })

  const rowsByType = new Map<string, typeof parsedRows>()
  for (const row of parsedRows) {
    if (!row.definition) continue
    const rows = rowsByType.get(row.building.type) ?? []
    rows.push(row)
    rowsByType.set(row.building.type, rows)
  }
  for (const [type, rows] of rowsByType) {
    const definition = catalogByType.get(type)
    if (!definition || rows.length <= definition.maxCount) continue
    for (const row of rows) addRowError(row.building.key, `${definition.name} allows at most ${definition.maxCount} in a starter village.`)
  }

  for (let left = 0; left < parsedRows.length; left++) {
    const a = parsedRows[left]
    if (!a.definition || a.gridX === null || a.gridY === null) continue
    for (let right = left + 1; right < parsedRows.length; right++) {
      const b = parsedRows[right]
      if (!b.definition || b.gridX === null || b.gridY === null) continue
      const overlaps = a.gridX < b.gridX + b.definition.width
        && a.gridX + a.definition.width > b.gridX
        && a.gridY < b.gridY + b.definition.height
        && a.gridY + a.definition.height > b.gridY
      if (!overlaps) continue
      addRowError(a.building.key, `Overlaps building ${right + 1} (${b.definition.name}).`)
      addRowError(b.building.key, `Overlaps building ${left + 1} (${a.definition.name}).`)
    }
  }

  const valid = issues.length === 0
    && Object.keys(resourceErrors).length === 0
    && wallError === null
    && Object.keys(rowErrors).length === 0
  return {
    valid,
    issues,
    resourceErrors,
    wallError,
    rowErrors,
    value: valid ? {
      resources: parsedResources,
      buildings: parsedRows.map(row => ({
        type: row.building.type,
        level: row.level as number,
        gridX: row.gridX as number,
        gridY: row.gridY as number,
      })),
      wallLevel: wallLevel as number,
    } : null,
  }
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y
}

function openStarterPosition(
  definition: StarterBuildingCatalogItem,
  draft: StarterVillageDraft,
  catalog: readonly StarterBuildingCatalogItem[],
  mapSize: number,
) {
  const catalogByType = new Map(catalog.map(item => [item.type, item]))
  const occupied = draft.buildings.flatMap(building => {
    const item = catalogByType.get(building.type)
    const x = parseDraftInteger(building.gridX)
    const y = parseDraftInteger(building.gridY)
    return item && x !== null && y !== null ? [{ x, y, width: item.width, height: item.height }] : []
  })
  for (let y = 0; y <= mapSize - definition.height; y++) {
    for (let x = 0; x <= mapSize - definition.width; x++) {
      const candidate = { x, y, width: definition.width, height: definition.height }
      if (!occupied.some(rectangle => rectanglesOverlap(candidate, rectangle))) return { x, y }
    }
  }
  return { x: 0, y: 0 }
}

function StarterVillageEditor({ config, reload, onUnauthorized }: {
  config: JsonRecord
  reload: () => void
  onUnauthorized: () => void
}) {
  const revision = Number.isSafeInteger(Number(config.revision)) ? Number(config.revision) : 0
  const catalog = useMemo(() => starterCatalogFrom(config), [config])
  const limits = useMemo(() => starterLimitsFrom(config), [config])
  const initialDraft = useMemo(() => starterDraftFrom(config, revision), [config, revision])
  const initialSignature = useMemo(() => JSON.stringify(comparableStarterDraft(initialDraft)), [initialDraft])
  const [draft, setDraft] = useState<StarterVillageDraft>(initialDraft)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [saving, setSaving] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const nextRow = useRef(0)

  useEffect(() => {
    setDraft(initialDraft)
    setConfirmOpen(false)
    setReason('')
    setConfirmation('')
    setMutationError(null)
    setStale(false)
  }, [initialDraft, initialSignature])

  const validation = useMemo(() => validateStarterVillage(draft, catalog, limits), [catalog, draft, limits])
  const dirty = JSON.stringify(comparableStarterDraft(draft)) !== initialSignature
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const building of draft.buildings) result.set(building.type, (result.get(building.type) ?? 0) + 1)
    return result
  }, [draft.buildings])
  const catalogGroups = useMemo(() => {
    const groups = new Map<string, StarterBuildingCatalogItem[]>()
    for (const item of catalog) {
      const category = item.category || 'other'
      const entries = groups.get(category) ?? []
      entries.push(item)
      groups.set(category, entries)
    }
    return [...groups.entries()]
  }, [catalog])
  const nextDefinition = catalog.find(item => (counts.get(item.type) ?? 0) < item.maxCount)

  if (!config.starterVillage || catalog.length === 0) {
    return <Alert><AlertCircle /><AlertTitle>Starter configuration unavailable</AlertTitle><AlertDescription>The server has not published the starter-village catalog yet. Refresh after the current deployment completes.</AlertDescription></Alert>
  }

  const setResource = (resource: StarterResource, value: string) => {
    setDraft(current => ({ ...current, resources: { ...current.resources, [resource]: value } }))
  }
  const updateBuilding = (key: string, field: 'type' | 'level' | 'gridX' | 'gridY', value: string) => {
    setDraft(current => ({
      ...current,
      buildings: current.buildings.map(building => {
        if (building.key !== key) return building
        if (field !== 'type') return { ...building, [field]: value }
        const definition = catalog.find(item => item.type === value)
        const currentLevel = parseDraftInteger(building.level) ?? 1
        return {
          ...building,
          type: value,
          level: value === 'wall'
            ? current.wallLevel
            : String(Math.max(1, Math.min(currentLevel, definition?.maxLevel ?? 1))),
        }
      }),
    }))
  }
  const setWallLevel = (value: string) => {
    setDraft(current => ({
      ...current,
      wallLevel: value,
      buildings: current.buildings.map(building => building.type === 'wall' ? { ...building, level: value } : building),
    }))
  }
  const addBuilding = () => {
    if (!nextDefinition) return
    const position = openStarterPosition(nextDefinition, draft, catalog, limits.mapSize)
    setDraft(current => ({
      ...current,
      buildings: [...current.buildings, {
        key: `starter-new-${revision}-${nextRow.current++}`,
        type: nextDefinition.type,
        level: nextDefinition.type === 'wall' ? current.wallLevel : '1',
        gridX: String(position.x),
        gridY: String(position.y),
      }],
    }))
  }
  const removeBuilding = (key: string) => {
    setDraft(current => ({ ...current, buildings: current.buildings.filter(building => building.key !== key) }))
  }
  const beginSave = () => {
    if (!dirty || !validation.valid) return
    setReason('')
    setConfirmation('')
    setMutationError(null)
    setStale(false)
    setConfirmOpen(true)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!validation.value || reason.trim().length < 8 || confirmation !== 'CONFIRM') return
    setSaving(true)
    setMutationError(null)
    setStale(false)
    try {
      const payload = await adminApi.post('operations', {
        type: 'set_starter_village',
        starterVillage: validation.value,
        expectedRevision: revision,
        reason: reason.trim(),
      })
      const result = asRecord(unwrapData(payload))
      const auditId = typeof result.auditId === 'string' ? ` Audit ${result.auditId}.` : ''
      setNotice(`Starter defaults saved. They apply to accounts created from now on.${auditId}`)
      setConfirmOpen(false)
      refreshAdminData()
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.unauthorized) {
        onUnauthorized()
        return
      }
      const staleConfig = caught instanceof AdminApiError
        && (caught.status === 409 || /STALE|REVISION/i.test(caught.code ?? ''))
      setStale(staleConfig)
      setMutationError(staleConfig
        ? 'Another operator changed this configuration. Reload the latest revision and review your edits before saving again.'
        : caught instanceof Error ? caught.message : 'The starter configuration could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const invalidRowCount = Object.keys(validation.rowErrors).length
  const resourceErrorCount = Object.keys(validation.resourceErrors).length
  const issueCount = validation.issues.length + invalidRowCount + resourceErrorCount + (validation.wallError ? 1 : 0)
  return <>
    {notice ? <Alert role="status" className="border-emerald-500/30 bg-emerald-500/5"><CheckCircle2 className="text-emerald-600" /><AlertTitle>Defaults updated</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <Card className="shadow-xs">
      <CardHeader className="gap-3 border-b sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300"><Building2 className="size-4" /></div>
          <div><CardTitle>New-village defaults</CardTitle><CardDescription className="mt-1 max-w-3xl">Set the authoritative wallet and layout copied into every newly created player village.</CardDescription></div>
        </div>
        <Badge variant="outline" className="shrink-0 border-sky-500/30 text-sky-700 dark:text-sky-300">Future accounts only</Badge>
      </CardHeader>
      <CardContent className="space-y-6">
        <Alert><ShieldCheck /><AlertTitle>Server-issued starting state</AlertTitle><AlertDescription>Starting balances may exceed the village’s storage capacity because the server grants them directly. Saving does not change an existing village. The separate Reset All Bases operation uses the latest saved defaults.</AlertDescription></Alert>

        <section className="space-y-3" aria-labelledby="starter-resources-title">
          <div><h3 id="starter-resources-title" className="text-sm font-medium">Starting resources</h3><p className="mt-1 text-xs text-muted-foreground">Whole numbers from 0 to {limits.maxBalance.toLocaleString()}; building storage limits are not applied.</p></div>
          <div className="grid gap-3 sm:grid-cols-3">
            {STARTER_RESOURCES.map(resource => {
              const id = `starter-${resource.id}`
              const error = validation.resourceErrors[resource.id]
              return <div key={resource.id}>
                <FormField id={id} label={resource.label}>
                  <Input id={id} type="number" inputMode="numeric" min={0} max={limits.maxBalance} step={1} value={draft.resources[resource.id]} onChange={event => setResource(resource.id, event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
                </FormField>
                {error ? <p id={`${id}-error`} className="mt-1 text-[0.6875rem] leading-4 text-destructive">{error}</p> : null}
              </div>
            })}
          </div>
          <div className="max-w-xs">
            <FormField id="starter-wall-level" label="Shared wall level" hint="Every starting wall uses one cohort level.">
              <Input id="starter-wall-level" type="number" inputMode="numeric" min={1} max={catalog.find(item => item.type === 'wall')?.maxLevel ?? 1} step={1} value={draft.wallLevel} onChange={event => setWallLevel(event.target.value)} aria-invalid={Boolean(validation.wallError)} aria-describedby={validation.wallError ? 'starter-wall-level-error' : undefined} />
            </FormField>
            {validation.wallError ? <p id="starter-wall-level-error" className="mt-1 text-[0.6875rem] leading-4 text-destructive">{validation.wallError}</p> : null}
          </div>
        </section>

        <Separator />

        <section className="space-y-3" aria-labelledby="starter-buildings-title">
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-end">
            <div><h3 id="starter-buildings-title" className="text-sm font-medium">Starting buildings</h3><p className="mt-1 text-xs text-muted-foreground">The map is {limits.mapSize}×{limits.mapSize}. Footprints cannot overlap, and every village needs exactly one Town Hall.</p></div>
            <Button variant="outline" type="button" onClick={addBuilding} disabled={!nextDefinition || draft.buildings.length >= limits.maxBuildings}><Plus />Add building</Button>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <Table className="min-w-[52rem]">
              <TableCaption className="sr-only">Buildings copied into each new player village</TableCaption>
              <TableHeader><TableRow><TableHead className="w-[32%]">Type</TableHead><TableHead>Level</TableHead><TableHead>Grid X</TableHead><TableHead>Grid Y</TableHead><TableHead>Footprint</TableHead><TableHead><span className="sr-only">Remove</span></TableHead></TableRow></TableHeader>
              <TableBody>
                {draft.buildings.map((building, index) => {
                  const definition = catalog.find(item => item.type === building.type)
                  const errors = validation.rowErrors[building.key] ?? []
                  const errorId = errors.length ? `starter-building-${building.key}-errors` : undefined
                  return <TableRow key={building.key} className={cn(errors.length && 'bg-destructive/[0.025]')}>
                    <TableCell className="min-w-64 align-top">
                      <Label className="sr-only" htmlFor={`starter-building-${building.key}-type`}>Building {index + 1} type</Label>
                      <Select value={building.type} onValueChange={value => updateBuilding(building.key, 'type', String(value))}>
                        <SelectTrigger id={`starter-building-${building.key}-type`} className="w-full" aria-invalid={errors.length > 0} aria-describedby={errorId}><SelectValue placeholder="Choose a building">{value => catalog.find(item => item.type === value)?.name ?? String(value ?? '')}</SelectValue></SelectTrigger>
                        <SelectContent>
                          {!definition && building.type ? <SelectItem value={building.type} disabled>Unknown: {building.type}</SelectItem> : null}
                          {catalogGroups.map(([category, entries]) => <SelectGroup key={category}>
                            <SelectLabel className="capitalize">{category.replaceAll('_', ' ')}</SelectLabel>
                            {entries.map(item => <SelectItem key={item.type} value={item.type} disabled={item.type !== building.type && (counts.get(item.type) ?? 0) >= item.maxCount}>{item.name} · max {item.maxCount}</SelectItem>)}
                          </SelectGroup>)}
                        </SelectContent>
                      </Select>
                      {errors.length ? <ul id={errorId} className="mt-1 list-disc space-y-0.5 pl-4 text-[0.6875rem] leading-4 text-destructive">{errors.map(error => <li key={error}>{error}</li>)}</ul> : null}
                    </TableCell>
                    <TableCell className="align-top">
                      <Label className="sr-only" htmlFor={`starter-building-${building.key}-level`}>Building {index + 1} level</Label>
                      <Input id={`starter-building-${building.key}-level`} className="w-20" type="number" inputMode="numeric" min={1} max={definition?.maxLevel ?? 1} step={1} value={building.level} onChange={event => updateBuilding(building.key, 'level', event.target.value)} disabled={building.type === 'wall'} aria-invalid={errors.length > 0} aria-describedby={errorId} />
                    </TableCell>
                    <TableCell className="align-top">
                      <Label className="sr-only" htmlFor={`starter-building-${building.key}-x`}>Building {index + 1} grid X</Label>
                      <Input id={`starter-building-${building.key}-x`} className="w-20" type="number" inputMode="numeric" min={0} max={definition ? limits.mapSize - definition.width : limits.mapSize - 1} step={1} value={building.gridX} onChange={event => updateBuilding(building.key, 'gridX', event.target.value)} aria-invalid={errors.length > 0} aria-describedby={errorId} />
                    </TableCell>
                    <TableCell className="align-top">
                      <Label className="sr-only" htmlFor={`starter-building-${building.key}-y`}>Building {index + 1} grid Y</Label>
                      <Input id={`starter-building-${building.key}-y`} className="w-20" type="number" inputMode="numeric" min={0} max={definition ? limits.mapSize - definition.height : limits.mapSize - 1} step={1} value={building.gridY} onChange={event => updateBuilding(building.key, 'gridY', event.target.value)} aria-invalid={errors.length > 0} aria-describedby={errorId} />
                    </TableCell>
                    <TableCell className="align-top"><Badge variant="outline" className="tabular-nums">{definition ? `${definition.width}×${definition.height}` : '—'}</Badge></TableCell>
                    <TableCell className="text-right align-top"><Button variant="ghost" size="icon-sm" type="button" aria-label={`Remove building ${index + 1}${definition ? `, ${definition.name}` : ''}`} onClick={() => removeBuilding(building.key)}><Trash2 /></Button></TableCell>
                  </TableRow>
                })}
                {!draft.buildings.length ? <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No starting buildings. Add a Town Hall to create a valid starter village.</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2 text-[0.6875rem] text-muted-foreground"><Badge variant="outline">{draft.buildings.length} / {limits.maxBuildings.toLocaleString()} buildings</Badge><span>Coordinates identify each footprint’s top-left grid tile.</span></div>
        </section>

        {dirty && issueCount > 0 ? <Alert variant="destructive" role="alert"><AlertTriangle /><AlertTitle>Fix {issueCount} configuration {issueCount === 1 ? 'issue' : 'issues'} before saving</AlertTitle><AlertDescription>{validation.issues.length ? <ul className="list-disc space-y-1 pl-4">{validation.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : 'Review the highlighted resource and building fields.'}</AlertDescription></Alert> : null}
      </CardContent>
      <CardFooter className="flex-col items-stretch justify-between gap-3 border-t sm:flex-row sm:items-center">
        <div className="text-xs text-muted-foreground"><strong className="font-medium text-foreground">Revision {revision}</strong><span className="mx-1.5">·</span>{dirty ? validation.valid ? 'Valid unsaved changes' : 'Unsaved changes need attention' : 'No unsaved changes'}</div>
        <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" type="button" disabled={!dirty || saving} onClick={() => setDraft(initialDraft)}>Discard changes</Button><Button type="button" disabled={!dirty || !validation.valid || saving} onClick={beginSave}><Save />Review & save</Button></div>
      </CardFooter>
    </Card>

    {confirmOpen && validation.value ? <DialogFrame title="Save new-village defaults" subtitle={`Publish revision ${revision + 1} for all accounts created afterward.`} onClose={() => { if (!saving) setConfirmOpen(false) }}>
      <form className="grid gap-4" onSubmit={save}>
        <Alert><Building2 /><AlertTitle>Future accounts only</AlertTitle><AlertDescription>This saves {validation.value.buildings.length} starting buildings and G {validation.value.resources.gold.toLocaleString()} · O {validation.value.resources.ore.toLocaleString()} · F {validation.value.resources.food.toLocaleString()}. Existing villages remain unchanged.</AlertDescription></Alert>
        <FormField id="starter-config-reason" label="Required audit reason" hint="Written permanently to the admin audit trail. Minimum 8 characters."><Textarea id="starter-config-reason" rows={3} minLength={8} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain why new-player defaults are changing…" required /></FormField>
        <FormField id="starter-config-confirmation" label="Type CONFIRM to publish"><Input id="starter-config-confirmation" autoComplete="off" spellCheck={false} value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="CONFIRM" required /></FormField>
        {mutationError ? <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>{stale ? 'Configuration changed' : 'Save failed'}</AlertTitle><AlertDescription className="space-y-3"><p>{mutationError}</p>{stale ? <Button variant="outline" size="sm" type="button" onClick={() => { setConfirmOpen(false); reload() }}><RefreshCw />Reload latest revision</Button> : null}</AlertDescription></Alert> : null}
        <DialogFooter><Button variant="outline" type="button" disabled={saving} onClick={() => setConfirmOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || reason.trim().length < 8 || confirmation !== 'CONFIRM'}>{saving ? <LoaderCircle className="animate-spin" /> : <Save />}{saving ? 'Publishing…' : 'Publish defaults'}</Button></DialogFooter>
      </form>
    </DialogFrame> : null}
  </>
}

function SecurityView({ onUnauthorized }: { onUnauthorized: () => void }) {
  const { state, reload } = useAdminData('config', onUnauthorized)
  return <>
    <SectionHeading eyebrow="Realm configuration" title="Runtime & village defaults" actions={<RefreshButton onClick={reload} loading={state.kind === 'loading'} />}>Manage audited defaults for future accounts and inspect the server’s read-only security posture.</SectionHeading>
    <StateSurface state={state} onRetry={reload}>{data => {
      const root = asRecord(data)
      const maintenance = asRecord(redactSecrets(root.maintenance))
      const accessPolicy = asRecord(redactSecrets(root.accessPolicy))
      const safeLimits = asRecord(redactSecrets(root.safeLimits))
      return <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Maintenance" value={maintenance.enabled === true ? 'enabled' : 'disabled'} detail={textValue(maintenance, ['message'], 'Player traffic gate')} tone={maintenance.enabled === true ? 'red' : 'green'} />
          <MetricCard label="Session revocation" value={accessPolicy.suspendedSessionsRevoked === true && accessPolicy.bannedSessionsRevoked === true ? 'enforced' : 'check'} detail="Suspended and banned players" tone="green" />
          <MetricCard label="Config revision" value={root.revision} detail="Authoritative mutation version" tone="blue" />
          <MetricCard label="Updated" value={formatDate(root.updatedAt)} detail="Latest config change" />
        </div>
        <StarterVillageEditor config={root} reload={reload} onUnauthorized={onUnauthorized} />
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Access enforcement" eyebrow="Moderation boundary"><ConfigTree value={accessPolicy} /></Panel>
          <Panel title="Safe query limits" eyebrow="Abuse protection"><ConfigTree value={safeLimits} /></Panel>
        </div>
        <Panel title="Redacted configuration snapshot" eyebrow="Read only"><pre className="max-h-96 overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-[0.6875rem] leading-5 text-zinc-100">{redactedJson(data)}</pre></Panel>
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
  return <main className="admin-theme admin-login-surface flex min-h-dvh items-center justify-center bg-muted/40 p-4 sm:p-8">
    <Card className="grid w-full max-w-4xl gap-0 overflow-hidden py-0 shadow-xl md:grid-cols-[0.9fr_1.1fr]" aria-labelledby="admin-login-title">
      <div className="relative hidden min-h-[34rem] flex-col justify-between overflow-hidden bg-zinc-950 p-8 text-zinc-50 md:flex">
        <div className="absolute inset-0 opacity-30 admin-dot-grid" aria-hidden="true" />
        <div className="relative flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-white text-zinc-950"><Command className="size-4" /></div><div><strong className="block text-sm">Realm Operations</strong><span className="text-xs text-zinc-400">Clash control plane</span></div></div>
        <div className="relative space-y-5">
          <Badge className="border-white/15 bg-white/10 text-zinc-100" variant="outline">Restricted access</Badge>
          <div><h2 className="text-3xl font-semibold tracking-tight">Operate the realm with confidence.</h2><p className="mt-3 max-w-sm text-sm leading-6 text-zinc-400">One secure surface for player support, economy health, combat authority, persistent villages, and live operations.</p></div>
          <div className="space-y-2.5 text-xs text-zinc-300">{['Signed operator sessions', 'Permanent mutation audit trail', 'Server-authoritative controls'].map(item => <div className="flex items-center gap-2" key={item}><CheckCircle2 className="size-3.5 text-zinc-100" />{item}</div>)}</div>
        </div>
        <p className="relative text-[0.6875rem] text-zinc-500">Administrative access is monitored and rate limited.</p>
      </div>
      <CardContent className="flex min-h-[34rem] flex-col justify-center p-6 sm:p-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-7 md:hidden"><div className="mb-5 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Command className="size-4" /></div><Badge variant="outline">Restricted access</Badge></div>
          <div className="space-y-2"><h1 id="admin-login-title" className="text-2xl font-semibold tracking-tight">Welcome back</h1><p className="text-sm leading-6 text-muted-foreground">Sign in with your administrator credentials to open the command center.</p></div>
          <form className="mt-7 grid gap-4" onSubmit={submit}>
            <FormField id="admin-username" label="Username"><Input id="admin-username" autoFocus autoComplete="username" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} required /></FormField>
            <FormField id="admin-password" label="Password"><Input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></FormField>
            {error ? <Alert variant="destructive" role="alert"><AlertCircle /><AlertTitle>Sign-in failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Button className="mt-1 h-9 w-full" size="lg" type="submit" disabled={busy || !username.trim() || !password}>{busy ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}{busy ? 'Authenticating…' : 'Enter command center'}</Button>
          </form>
          <Separator className="my-6" />
          <div className="flex items-start gap-2 text-[0.6875rem] leading-4 text-muted-foreground"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" /><span>Session cookies are HttpOnly. Credentials are never stored by this page.</span></div>
        </div>
      </CardContent>
    </Card>
  </main>
}

function PortalNavigation({ identity, view, loggingOut, onNavigate, onLogout }: {
  identity: AdminIdentity
  view: ViewId
  loggingOut: boolean
  onNavigate: (view: ViewId) => void
  onLogout: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-3 border-b border-sidebar-border px-4 pr-12">
        <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground"><Command className="size-4" /></div>
        <div><strong className="block text-sm font-semibold">Realm Ops</strong><span className="block text-[0.6875rem] text-muted-foreground">Clash control plane</span></div>
      </div>
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2" aria-label="Admin sections">
        {NAV_ITEMS.map(item => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <Button
              type="button"
              key={item.id}
              variant={active ? 'secondary' : 'ghost'}
              className={cn('h-auto w-full justify-start gap-3 px-3 py-2 text-left', active && 'bg-sidebar-accent text-sidebar-accent-foreground')}
              onClick={() => onNavigate(item.id)}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0"><strong className="block truncate text-xs font-medium">{item.label}</strong><small className="block truncate text-[0.625rem] font-normal text-muted-foreground">{item.eyebrow}</small></span>
            </Button>
          )
        })}
      </nav>
      <div className="border-t border-sidebar-border p-3">
        <div className="mb-3 flex items-center gap-3 px-1">
          <Avatar size="sm"><AvatarFallback>{identity.username.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
          <div className="min-w-0"><strong className="block truncate text-xs font-medium">{identity.username}</strong><span className="block truncate text-[0.625rem] capitalize text-muted-foreground">{identity.role}</span></div>
        </div>
        <Button className="w-full" variant="outline" type="button" onClick={onLogout} disabled={loggingOut}>{loggingOut ? <LoaderCircle className="animate-spin" /> : <LogOut />}{loggingOut ? 'Signing out…' : 'Secure sign out'}</Button>
      </div>
    </div>
  )
}

function PortalShell({ identity, onLoggedOut }: { identity: AdminIdentity; onLoggedOut: () => void }) {
  const [view, setView] = useState<ViewId>(routeView)
  const [menuOpen, setMenuOpen] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const contentRef = useRef<HTMLElement | null>(null)
  const onUnauthorized = useCallback(() => { adminApi.clearMemory(); onLoggedOut() }, [onLoggedOut])
  const focusContent = useCallback(() => {
    window.requestAnimationFrame(() => contentRef.current?.focus())
  }, [])

  useEffect(() => {
    const update = () => { setView(routeView()); focusContent() }
    window.addEventListener('popstate', update)
    return () => window.removeEventListener('popstate', update)
  }, [focusContent])

  const goTo = (next: ViewId) => {
    setView(next)
    setMenuOpen(false)
    window.history.pushState(null, '', next === 'overview' ? '/admin' : `/admin/${next}`)
    focusContent()
  }
  const logout = async () => {
    setLoggingOut(true)
    try { await adminApi.logout() } catch { adminApi.clearMemory() } finally { setLoggingOut(false); onLoggedOut() }
  }
  const selected = NAV_ITEMS.find(item => item.id === view) ?? NAV_ITEMS[0]
  const SelectedIcon = selected.icon
  return <div className="admin-theme admin-shell min-h-dvh bg-muted/30 text-foreground">
    <a className="admin-skip-link" href="#admin-content">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border lg:block">
      <PortalNavigation identity={identity} view={view} loggingOut={loggingOut} onNavigate={goTo} onLogout={logout} />
    </aside>
    <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
      <SheetContent side="left" className="w-72 p-0 sm:max-w-72">
        <SheetHeader className="sr-only"><SheetTitle>Admin navigation</SheetTitle><SheetDescription>Choose an administrative workspace.</SheetDescription></SheetHeader>
        <PortalNavigation identity={identity} view={view} loggingOut={loggingOut} onNavigate={goTo} onLogout={logout} />
      </SheetContent>
    </Sheet>
    <section className="flex min-h-dvh min-w-0 flex-col lg:pl-64">
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" type="button" className="lg:hidden" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen} aria-label="Open admin navigation"><Menu /></Button>
          <div className="flex min-w-0 items-center gap-2"><SelectedIcon className="size-4 text-muted-foreground" /><span className="truncate text-sm font-medium">{selected.label}</span></div>
        </div>
        <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground"><span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-50" /><span className="relative inline-flex size-2 rounded-full bg-emerald-500" /></span><span className="hidden sm:inline">Server connected</span><Badge variant="outline" className="hidden md:inline-flex">Secure session</Badge></div>
      </header>
      <main ref={contentRef} id="admin-content" tabIndex={-1} className="admin-content mx-auto w-full max-w-[100rem] flex-1 space-y-5 p-4 outline-none sm:p-6 xl:p-8">
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
    document.documentElement.classList.add('admin-surface')
    document.body.classList.add('admin-surface')
    return () => {
      document.title = previousTitle
      document.documentElement.classList.remove('admin-surface')
      document.body.classList.remove('admin-surface')
    }
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
  if (checking) return <main className="admin-theme flex min-h-dvh items-center justify-center bg-muted/30 p-4"><Card className="w-full max-w-xs shadow-lg"><CardContent className="flex flex-col items-center gap-3 py-6 text-center"><div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Command className="size-4" /></div><LoaderCircle className="size-4 animate-spin text-muted-foreground" /><div><strong className="font-medium">Verifying operator session…</strong><p className="mt-1 text-xs text-muted-foreground">Checking the signed admin cookie.</p></div></CardContent></Card></main>
  if (!identity) return <LoginScreen onAuthenticated={next => setIdentity(next)} />
  return <PortalShell identity={identity} onLoggedOut={logOutLocally} />
}
