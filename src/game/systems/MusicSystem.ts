// MusicSystem — streams the real RuneScape soundtrack (baked OGG files under
// public/assets/audio/music/, see manifest.json there) as the game's music
// layer, replacing SoundSystem's procedural melody. SoundSystem keeps owning
// SFX + ambience. Music © Jagex — personal non-commercial fan use.
//
// Design notes:
// - Plain singleton, no Phaser dependency: playback is 2 crossfading
//   HTMLAudioElements (the tracks are ~160 MB total — they MUST stream,
//   never decode into WebAudio buffers) plus a third element for stingers.
// - All volume ramps run on one ~60 ms interval tick.
// - Browser autoplay: a one-time pointerdown/keydown listener unlocks
//   playback; anything requested earlier is queued until then.
// - Kill switch: localStorage['clash.music.off']==='1' disables this system
//   entirely and SoundSystem keeps its procedural melody.

export type MusicContext = 'home' | 'night' | 'world' | 'battle'
export type StingerKind = 'reveal' | 'build' | 'victory' | 'defeat' | 'loot'

export interface MusicTrack {
    name: string
    slug: string
    file: string
    context: string
    duration: number | null
}

const VOL_KEY = 'clash.musicvol'
const MUTE_KEY = 'clash.muted'
const OFF_KEY = 'clash.music.off'
const BASE_URL = '/assets/audio/music/'
const MANIFEST_URL = `${BASE_URL}manifest.json`

const STINGER_CONTEXT: Record<StingerKind, string> = {
    reveal: 'jingle_reveal',
    build: 'jingle_build',
    victory: 'jingle_victory',
    defeat: 'jingle_defeat',
    loot: 'jingle_loot'
}

/** The clouds-parting flourish — always preferred for 'reveal'. */
const REVEAL_SLUG = 'first_sunshine_death_to_the_dorgeshuun'

const TICK_MS = 60
const CROSSFADE_MS = 1800
const DUCK_DOWN_MS = 250
const DUCK_UP_MS = 700
const DUCK_LEVEL = 0.15
/** Big wins hold a full Fanfare bed this long before rotation resumes. */
const VICTORY_BED_MS = 25000
/** RuneScape-feel silence between village/night tracks (5–10 s). */
const GAP_MIN_MS = 5000
const GAP_JITTER_MS = 5000
/** Safety restore if a stinger element never fires ended/error. */
const STINGER_SAFETY_MS = 20000

interface Bed {
    el: HTMLAudioElement
    /** Crossfade gain 0..1 (multiplied by duck × master volume). */
    fade: number
    fadeTarget: number
    fadeMs: number
    track: MusicTrack | null
}

class MusicSystem {
    /** False when the kill switch is set — every API becomes a no-op. */
    readonly enabled: boolean

    private tracks: MusicTrack[] = []
    private byContext = new Map<string, MusicTrack[]>()
    private attribution = ''
    private inited = false
    private manifestReady = false
    private unlocked = false
    private muted = false
    private volume = 0.6

    private beds: Bed[] = []
    private active = 0
    private tickTimer: number | null = null

    /** Context the game derives (sync); forced overrides it (war camp). */
    private context: MusicContext = 'home'
    private forced: MusicContext | null = null
    /** Context whose track currently occupies the bed (null = nothing yet). */
    private playingCtx: string | null = null
    /** Hysteresis latch for night (enter > 0.65, leave < 0.55). */
    private night = false

    /** Jukebox pin: loops one track until resumeAuto(). */
    private overrideTrack: MusicTrack | null = null
    /** Per-context shuffle bags (popped from the end; reshuffle on empty). */
    private bags = new Map<string, MusicTrack[]>()
    private lastSlugByContext = new Map<string, string>()

    private gapTimer: number | null = null
    private victoryBed = false
    private victoryTimer: number | null = null

    private stingerEl: HTMLAudioElement | null = null
    private stingerBusy = false
    private stingerToken = 0
    private duck = 1
    private duckTarget = 1
    private duckMs = DUCK_UP_MS

    /** Playback was requested before unlock/manifest — start when ready. */
    private wantPlay = false
    private warned = new Set<string>()

    constructor() {
        let off = false
        let vol = 0.6
        let muted = false
        try {
            off = localStorage.getItem(OFF_KEY) === '1'
            const v = Number(localStorage.getItem(VOL_KEY))
            if (Number.isFinite(v) && localStorage.getItem(VOL_KEY) !== null) {
                vol = Math.max(0, Math.min(1, v))
            }
            muted = localStorage.getItem(MUTE_KEY) === '1'
        } catch {
            // storage unavailable — defaults stand
        }
        this.enabled = !off
        this.volume = vol
        this.muted = muted
        // Debug/test handle (same spirit as window.__clashSound).
        ;(window as unknown as { __clashMusic?: MusicSystem }).__clashMusic = this
    }

    // ------------------------------------------------------------ lifecycle

    /** Load the manifest and arm the autoplay-unlock gesture listener. */
    init(): void {
        if (!this.enabled || this.inited) return
        this.inited = true
        this.armUnlock()
        void fetch(MANIFEST_URL)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json()
            })
            .then((m: { attribution?: string; tracks?: MusicTrack[] }) => {
                this.attribution = typeof m?.attribution === 'string' ? m.attribution : ''
                this.tracks = (Array.isArray(m?.tracks) ? m.tracks : [])
                    .filter(t => t && typeof t.slug === 'string' && typeof t.file === 'string')
                this.byContext.clear()
                for (const t of this.tracks) {
                    const list = this.byContext.get(t.context)
                    if (list) list.push(t)
                    else this.byContext.set(t.context, [t])
                }
                this.manifestReady = true
                this.wantPlay = true
                this.maybeStart()
            })
            .catch(err => {
                console.warn('MusicSystem: manifest load failed — music stays off.', err)
            })
    }

    /** Autoplay unlock — also callable directly (SoundSystem.attach bridges). */
    unlock(): void {
        if (!this.enabled || this.unlocked) return
        this.unlocked = true
        this.maybeStart()
    }

    private armUnlock(): void {
        const onGesture = () => {
            document.removeEventListener('pointerdown', onGesture)
            document.removeEventListener('keydown', onGesture)
            this.unlock()
        }
        document.addEventListener('pointerdown', onGesture)
        document.addEventListener('keydown', onGesture)
    }

    private maybeStart(): void {
        if (!this.unlocked || !this.manifestReady || !this.wantPlay) return
        this.wantPlay = false
        const bed = this.beds[this.active]
        if (bed?.track && bed.el.paused && bed.fadeTarget > 0) {
            // A play() rejected before the first gesture — retry the same bed.
            void bed.el.play().catch(() => { /* still locked; a later gesture retries */ })
            this.ensureTick()
            return
        }
        if (this.overrideTrack) {
            this.crossfadeTo(this.overrideTrack)
            return
        }
        this.playingCtx = this.effectiveContext()
        this.crossfadeTo(this.nextFromBag(this.playingCtx))
    }

    // ------------------------------------------------------------- context

    /** Per-frame sync from MainScene.update: derives the active context. */
    sync(state: { mode: string; nightFactor: number; zoomedOut: boolean }): void {
        if (!this.enabled) return
        let ctx: MusicContext
        if (state.mode === 'ATTACK' || state.mode === 'REPLAY') {
            ctx = 'battle'
        } else if (state.zoomedOut) {
            ctx = 'world'
        } else {
            if (state.nightFactor > 0.65) this.night = true
            else if (state.nightFactor < 0.55) this.night = false
            ctx = this.night ? 'night' : 'home'
        }
        if (ctx === this.context) return // only act on context CHANGES
        this.context = ctx
        this.onContextChange()
    }

    /** Hard context override (e.g. war camp planted). Pass null to clear. */
    forceContext(ctx: MusicContext | null): void {
        if (!this.enabled || this.forced === ctx) return
        this.forced = ctx
        this.onContextChange()
    }

    private effectiveContext(): MusicContext {
        return this.forced ?? this.context
    }

    private onContextChange(): void {
        const eff = this.effectiveContext()
        if (this.overrideTrack) return // jukebox pin outranks the rotation
        if (this.playingCtx === eff && !this.victoryBed) return
        this.clearVictoryBed()
        this.playingCtx = eff
        if (!this.manifestReady || !this.unlocked) {
            this.wantPlay = true
            return
        }
        this.crossfadeTo(this.nextFromBag(eff))
    }

    // ------------------------------------------------------------ playback

    private ensureBeds(): void {
        if (this.beds.length) return
        for (let i = 0; i < 2; i++) {
            const el = new Audio()
            el.preload = 'auto'
            el.muted = this.muted
            el.addEventListener('ended', () => this.onBedEnded(i))
            el.addEventListener('error', () => this.onBedError(i))
            this.beds.push({ el, fade: 0, fadeTarget: 0, fadeMs: CROSSFADE_MS, track: null })
        }
    }

    private crossfadeTo(track: MusicTrack | null): void {
        this.clearGap()
        if (!track) return
        this.ensureBeds()
        const cur = this.beds[this.active]
        const next = this.beds[1 - this.active]
        cur.fadeTarget = 0
        cur.fadeMs = CROSSFADE_MS
        next.track = track
        next.el.loop = this.overrideTrack?.slug === track.slug
        next.el.src = BASE_URL + track.file
        next.el.volume = 0
        next.fade = 0
        next.fadeTarget = 1
        next.fadeMs = CROSSFADE_MS
        this.active = 1 - this.active
        const p = next.el.play()
        if (p) p.catch(() => { this.wantPlay = true /* locked — retried on unlock */ })
        this.ensureTick()
    }

    /** Advance the rotation for the effective context (crossfade in). */
    private advance(): void {
        this.playingCtx = this.effectiveContext()
        this.crossfadeTo(this.nextFromBag(this.playingCtx))
    }

    private onBedEnded(i: number): void {
        if (i !== this.active) return
        const bed = this.beds[i]
        bed.fade = 0
        bed.fadeTarget = 0
        if (this.overrideTrack) {
            // loop=true should prevent this; belt-and-braces restart.
            bed.el.currentTime = 0
            void bed.el.play().catch(() => { /* retried on next gesture */ })
            bed.fade = 1
            bed.fadeTarget = 1
            return
        }
        if (this.victoryBed) {
            this.clearVictoryBed()
            this.advance()
            return
        }
        const eff = this.effectiveContext()
        if (eff === 'home' || eff === 'night') {
            // RuneScape feel: leave a quiet gap between village tracks.
            this.clearGap()
            this.gapTimer = window.setTimeout(() => {
                this.gapTimer = null
                this.advance()
            }, GAP_MIN_MS + Math.random() * GAP_JITTER_MS)
        } else {
            this.advance()
        }
    }

    private onBedError(i: number): void {
        const bed = this.beds[i]
        const slug = bed.track?.slug ?? '(unknown)'
        if (!this.warned.has(slug)) {
            this.warned.add(slug)
            console.warn(`MusicSystem: failed to load '${slug}' — skipping to the next track.`)
        }
        if (i !== this.active) return
        bed.fade = 0
        bed.fadeTarget = 0
        if (this.overrideTrack) this.overrideTrack = null
        this.clearVictoryBed()
        window.setTimeout(() => this.advance(), 400)
    }

    private nextFromBag(ctx: string): MusicTrack | null {
        const pool = this.byContext.get(ctx)
        if (!pool || pool.length === 0) return null
        let bag = this.bags.get(ctx)
        if (!bag || bag.length === 0) {
            bag = [...pool]
            for (let i = bag.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1))
                ;[bag[i], bag[j]] = [bag[j], bag[i]]
            }
            // No immediate repeat across the reshuffle boundary (we pop the end).
            const last = this.lastSlugByContext.get(ctx)
            if (bag.length > 1 && bag[bag.length - 1].slug === last) {
                const j = Math.floor(Math.random() * (bag.length - 1))
                ;[bag[bag.length - 1], bag[j]] = [bag[j], bag[bag.length - 1]]
            }
            this.bags.set(ctx, bag)
        }
        const t = bag.pop() as MusicTrack
        this.lastSlugByContext.set(ctx, t.slug)
        return t
    }

    // ---------------------------------------------------------------- tick

    private ensureTick(): void {
        if (this.tickTimer !== null) return
        this.tickTimer = window.setInterval(() => this.tick(), TICK_MS)
    }

    private tick(): void {
        const step = (cur: number, target: number, ms: number): number => {
            if (ms <= 0) return target
            const d = TICK_MS / ms
            if (cur < target) return Math.min(target, cur + d)
            if (cur > target) return Math.max(target, cur - d)
            return cur
        }
        this.duck = step(this.duck, this.duckTarget, this.duckMs)
        for (let i = 0; i < this.beds.length; i++) {
            const bed = this.beds[i]
            bed.fade = step(bed.fade, bed.fadeTarget, bed.fadeMs)
            bed.el.volume = Math.max(0, Math.min(1, bed.fade * this.duck * this.volume))
            if (bed.fade === 0 && bed.fadeTarget === 0 && !bed.el.paused) bed.el.pause()
        }
        if (this.stingerEl) {
            this.stingerEl.volume = Math.max(0, Math.min(1, this.volume))
        }
    }

    // ------------------------------------------------------------ stingers

    /** One-shot jingle; ducks the music bed while it plays. */
    stinger(kind: StingerKind): void {
        if (!this.enabled || !this.manifestReady || !this.unlocked) return
        if (this.stingerBusy) return // never overlap two stingers — drop
        const pool = this.byContext.get(STINGER_CONTEXT[kind])
        if (!pool || pool.length === 0) return
        const track = kind === 'reveal'
            ? pool.find(t => t.slug === REVEAL_SLUG) ?? pool[Math.floor(Math.random() * pool.length)]
            : pool[Math.floor(Math.random() * pool.length)]
        if (!this.stingerEl) {
            const el = new Audio()
            el.preload = 'auto'
            this.stingerEl = el
        }
        const el = this.stingerEl
        this.stingerBusy = true
        const token = ++this.stingerToken
        const finish = () => {
            if (token !== this.stingerToken || !this.stingerBusy) return
            this.stingerBusy = false
            this.duckTarget = 1
            this.duckMs = DUCK_UP_MS
        }
        el.muted = this.muted
        el.loop = false
        el.src = BASE_URL + track.file
        el.volume = Math.max(0, Math.min(1, this.volume))
        el.onended = finish
        el.onerror = () => {
            if (!this.warned.has(track.slug)) {
                this.warned.add(track.slug)
                console.warn(`MusicSystem: failed to load stinger '${track.slug}'.`)
            }
            finish()
        }
        // Duck the bed under the jingle, restore after it ends.
        this.duckTarget = DUCK_LEVEL
        this.duckMs = DUCK_DOWN_MS
        this.ensureTick()
        const p = el.play()
        if (p) p.catch(() => finish())
        window.setTimeout(finish, STINGER_SAFETY_MS)
    }

    /** Victory presentation: jingle, plus a Fanfare track on a big win. */
    playVictory(big: boolean): void {
        if (!this.enabled) return
        this.stinger('victory')
        if (!big || !this.manifestReady || !this.unlocked || this.overrideTrack) return
        const pool = this.byContext.get('victory')
        if (!pool || pool.length === 0) return
        const t = pool[Math.floor(Math.random() * pool.length)]
        this.clearVictoryBed()
        this.victoryBed = true
        this.playingCtx = null // the next context change re-arms the rotation
        this.crossfadeTo(t)
        this.victoryTimer = window.setTimeout(() => {
            this.victoryTimer = null
            if (!this.victoryBed) return
            this.victoryBed = false
            this.advance() // fades the fanfare out under the next rotation track
        }, VICTORY_BED_MS)
    }

    /** Defeat presentation jingle. */
    playDefeat(): void {
        this.stinger('defeat')
    }

    // ------------------------------------------------------------ controls

    setMuted(muted: boolean): void {
        this.muted = muted
        for (const bed of this.beds) bed.el.muted = muted
        if (this.stingerEl) this.stingerEl.muted = muted
    }

    setVolume(volume: number): void {
        this.volume = Math.max(0, Math.min(1, volume))
        try {
            localStorage.setItem(VOL_KEY, String(this.volume))
        } catch {
            // session-only volume
        }
        // Applied immediately (the tick would also catch up within 60 ms).
        for (const bed of this.beds) {
            bed.el.volume = Math.max(0, Math.min(1, bed.fade * this.duck * this.volume))
        }
        if (this.stingerEl) this.stingerEl.volume = this.volume
    }

    getVolume(): number {
        return this.volume
    }

    // ------------------------------------------------------------- jukebox

    /** Jukebox: play one specific track now, looped until resumeAuto(). */
    playTrack(slug: string): void {
        if (!this.enabled) return
        const t = this.tracks.find(x => x.slug === slug)
        if (!t) return
        this.overrideTrack = t
        this.clearVictoryBed()
        if (!this.manifestReady || !this.unlocked) {
            this.wantPlay = true
            return
        }
        this.crossfadeTo(t)
    }

    /** Jukebox: stop manual playback and resume contextual rotation. */
    resumeAuto(): void {
        if (!this.enabled || !this.overrideTrack) return
        this.overrideTrack = null
        for (const bed of this.beds) bed.el.loop = false
        this.advance()
    }

    getTracks(): MusicTrack[] {
        return this.tracks.slice()
    }

    getNowPlaying(): MusicTrack | null {
        const bed = this.beds[this.active]
        if (!bed || !bed.track || bed.fadeTarget <= 0) return null
        return bed.el.paused ? null : bed.track
    }

    /** Slug of the jukebox-pinned track, or null when rotating on auto. */
    getOverride(): string | null {
        return this.overrideTrack?.slug ?? null
    }

    getAttribution(): string {
        return this.attribution
    }

    // ------------------------------------------------------------- helpers

    private clearGap(): void {
        if (this.gapTimer !== null) {
            window.clearTimeout(this.gapTimer)
            this.gapTimer = null
        }
    }

    private clearVictoryBed(): void {
        this.victoryBed = false
        if (this.victoryTimer !== null) {
            window.clearTimeout(this.victoryTimer)
            this.victoryTimer = null
        }
    }
}

export const musicSystem = new MusicSystem()
