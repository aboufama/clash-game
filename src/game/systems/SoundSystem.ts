/**
 * Procedural audio for the whole game — RuneScape-inspired, fully original,
 * synthesized live with WebAudio. No files, no downloads, no copyright.
 *
 * Three layers, all subtle by design:
 *   MUSIC     A mellow medieval loop in D dorian: a flute-ish triangle lead
 *             wandering a seeded melody over a soft drone bass, with a gentle
 *             echo. Night swaps to a slower, sparser, lower variant; the two
 *             crossfade with the day/night cycle.
 *   AMBIENCE  Quiet wind bed, birdsong chirps by day, crickets by night.
 *   SFX       Little RuneScape-flavored plinks and thocks: coins, eggs,
 *             stone clunks, door creaks, work taps, deploy pops, a panic
 *             horn and a distant dragon roar.
 *
 * The AudioContext unlocks on the first user gesture. Mute is persisted in
 * localStorage and exposed for a HUD toggle.
 */

const MUTE_KEY = 'clash.muted';

type SfxName =
    | 'coin' | 'thud' | 'door' | 'eggLay' | 'eggCollect' | 'stone'
    | 'deposit' | 'tap' | 'snip' | 'deploy' | 'horn' | 'dragon'
    | 'destroy' | 'click' | 'merchant' | 'trade';

const TRACKS_KEY = 'clash.tracks';

export interface TrackDef {
    name: string;
    /** Modal palette the melody wanders. */
    scale: number[];
    bpm: number;
    lead: OscillatorType;
    echo: number;
    /** Extra probability of a rest — sparser tunes breathe more. */
    restBias: number;
    /** Rare collectible: locked entries show as ??? until found. */
    rare?: boolean;
    hint: string;
}

/**
 * The songbook. Two tracks come free; the rest are earned by playing, and the
 * rare two are trophies. All are procedural recipes for the same synth.
 */
export const TRACKS: Record<string, TrackDef> = {
    village_green: {
        name: 'Village Green',
        scale: [146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0],
        bpm: 76, lead: 'triangle', echo: 0.42, restBias: 0,
        hint: 'The sound of home.'
    },
    nightfall: {
        name: 'Nightfall',
        scale: [73.42, 82.41, 87.31, 98.0, 110.0, 123.47, 130.81, 146.83, 164.81, 174.61],
        bpm: 54, lead: 'triangle', echo: 0.58, restBias: 0.25,
        hint: 'The village asleep.'
    },
    war_drums: {
        name: 'War Drums',
        // Phrygian: the half-step over the root keeps every phrase on edge.
        scale: [110.0, 116.54, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 233.08, 261.63],
        bpm: 132, lead: 'square', echo: 0.22, restBias: 0.05,
        rare: true,
        hint: 'It plays itself when the horns sound.'
    },
    harvest_home: {
        name: 'Harvest Home',
        scale: [196.0, 220.0, 246.94, 261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88],
        bpm: 84, lead: 'triangle', echo: 0.36, restBias: -0.08,
        hint: 'Bring food into the stores.'
    },
    miners_vein: {
        name: "Miner's Vein",
        scale: [110.0, 123.47, 130.81, 146.83, 164.81, 174.61, 196.0, 220.0, 246.94, 261.63],
        bpm: 66, lead: 'square', echo: 0.5, restBias: 0.05,
        hint: 'Bring ore into the stores.'
    },
    merchants_tune: {
        name: "Merchant's Tune",
        scale: [261.63, 293.66, 329.63, 369.99, 392.0, 440.0, 493.88, 523.25, 587.33],
        bpm: 96, lead: 'sawtooth', echo: 0.3, restBias: -0.05,
        hint: 'Strike a deal with a traveler.'
    },
    dragons_shadow: {
        name: "Dragon's Shadow",
        scale: [82.41, 87.31, 103.83, 110.0, 123.47, 130.81, 146.83, 164.81, 174.61],
        bpm: 56, lead: 'sawtooth', echo: 0.62, restBias: 0.2, rare: true,
        hint: 'Witness something vast pass overhead.'
    },
    golden_cap: {
        name: 'Golden Cap',
        scale: [220.0, 246.94, 277.18, 329.63, 369.99, 440.0, 493.88, 554.37, 659.26],
        bpm: 88, lead: 'sine', echo: 0.46, restBias: -0.1, rare: true,
        hint: 'Harvest the rarest thing that grows.'
    }
};

const DEFAULT_UNLOCKED = ['village_green', 'nightfall'];

class SoundSystem {
    private ctx: AudioContext | null = null;
    private master!: GainNode;
    private musicBus!: GainNode;
    private musicFilter!: BiquadFilterNode;
    private echoDelay!: DelayNode;
    private ambienceBus!: GainNode;
    private sfxBus!: GainNode;
    private delaySend!: GainNode;
    private noiseBuffer!: AudioBuffer;
    private started = false;
    private nightFactor = 0;
    muted = false;

    // Music scheduler state
    private nextNoteAt = 0;
    private beat = 0;
    private melodyDegree = 4;
    private nextChirpAt = 0;
    private nextCricketAt = 0;
    /** Manually chosen track (jukebox); null = auto day/night. */
    private trackOverride: string | null = null;
    private unlockedTracks = new Set<string>(DEFAULT_UNLOCKED);

    constructor() {
        try {
            this.muted = localStorage.getItem(MUTE_KEY) === '1';
        } catch {
            this.muted = false;
        }
        try {
            const saved = JSON.parse(localStorage.getItem(TRACKS_KEY) ?? '[]') as string[];
            for (const id of saved) if (TRACKS[id]) this.unlockedTracks.add(id);
        } catch {
            // fresh songbook
        }
        // Debug/test handle (same spirit as window.__clashGame).
        (window as unknown as { __clashSound?: SoundSystem }).__clashSound = this;
    }

    /** Add a track to the songbook. Returns true only when it's NEW. */
    unlockTrack(id: string): boolean {
        if (!TRACKS[id] || this.unlockedTracks.has(id)) return false;
        this.unlockedTracks.add(id);
        try {
            localStorage.setItem(TRACKS_KEY, JSON.stringify([...this.unlockedTracks]));
        } catch {
            // session-only unlock
        }
        return true;
    }

    /** Songbook for the jukebox UI. */
    getTracks(): Array<{ id: string; name: string; unlocked: boolean; rare: boolean; hint: string }> {
        return Object.entries(TRACKS).map(([id, def]) => ({
            id,
            name: def.name,
            unlocked: this.unlockedTracks.has(id),
            rare: Boolean(def.rare),
            hint: def.hint
        }));
    }

    /** Pin a track (jukebox pick); null returns to the day/night rotation. */
    setTrack(id: string | null) {
        if (id !== null && (!TRACKS[id] || !this.unlockedTracks.has(id))) return;
        this.trackOverride = id;
    }

    /** While a battle runs, the drums take the bandstand from everything. */
    private battleMusic = false;

    setBattleMusic(on: boolean) {
        if (this.battleMusic === on) return;
        this.battleMusic = on;
        if (this.ctx && this.started) {
            const t = this.ctx.currentTime;
            // War silences the countryside: birdsong and wind duck hard so
            // the drums own the field; peace restores the mix.
            this.ambienceBus.gain.setTargetAtTime(on ? 0.08 : 0.5, t, 0.3);
            this.musicBus.gain.setTargetAtTime(this.musicBusTarget(), t, 0.3);
            this.setRainLevel(this.lastRainLevel);
            // The drums come in on a downbeat, not mid-phrase.
            this.beat = 0;
        }
    }

    /** One authority for the melody bus level: battle > night > day. */
    private musicBusTarget(): number {
        if (this.battleMusic) return 0.17;
        return 0.12 * (1 - this.nightFactor * 0.35);
    }

    currentTrackId(): string {
        if (this.battleMusic) return 'war_drums';
        return this.trackOverride ?? (this.nightFactor > 0.5 ? 'nightfall' : 'village_green');
    }

    get overrideActive(): boolean {
        return this.trackOverride !== null;
    }

    /** Test/debug introspection. */
    get state(): string {
        return this.ctx?.state ?? 'not-started';
    }

    /** Last effect fired (for tests). */
    lastPlayed = '';

    /** Install one-time unlock listeners; audio starts on the first gesture. */
    attach() {
        const unlock = () => {
            this.start();
            document.removeEventListener('pointerdown', unlock);
            document.removeEventListener('keydown', unlock);
        };
        document.addEventListener('pointerdown', unlock);
        document.addEventListener('keydown', unlock);
    }

    setMuted(muted: boolean) {
        this.muted = muted;
        try {
            localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
        } catch {
            // storage unavailable — session-only mute still works
        }
        if (this.ctx && this.master) {
            this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.05);
        }
    }

    setNightFactor(nf: number) {
        this.nightFactor = Math.max(0, Math.min(1, nf));
        // Night mellows the whole soundtrack: quieter, warmer, more distant.
        if (this.ctx && this.started) {
            const t = this.ctx.currentTime;
            this.musicBus.gain.setTargetAtTime(this.musicBusTarget(), t, 0.8);
            this.musicFilter.frequency.setTargetAtTime(5200 - this.nightFactor * 3600, t, 0.8);
            this.echoDelay.delayTime.setTargetAtTime(0.42 + this.nightFactor * 0.16, t, 0.8);
        }
    }

    private start() {
        if (this.started) return;
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) {
            this.started = true;
            return;
        }
        // AudioContext construction throws on some browsers (locked-down
        // WebViews, exhausted hardware contexts). A game without sound is
        // fine; a game that throws out of a pointerdown handler is not.
        try {
            this.ctx = new Ctx();
        } catch {
            this.ctx = null;
            this.started = true;
            return;
        }
        this.started = true;
        this.ctx.resume().catch(() => { /* autoplay policy — a later gesture retries */ });

        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 1;
        this.master.connect(this.ctx.destination);

        this.musicBus = this.ctx.createGain();
        this.musicBus.gain.value = 0.12;
        // Everything musical passes through one tone filter the night can dim.
        this.musicFilter = this.ctx.createBiquadFilter();
        this.musicFilter.type = 'lowpass';
        this.musicFilter.frequency.value = 5200;
        this.musicBus.connect(this.musicFilter);
        this.musicFilter.connect(this.master);

        this.ambienceBus = this.ctx.createGain();
        this.ambienceBus.gain.value = 0.5;
        this.ambienceBus.connect(this.master);

        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 0.5;
        this.sfxBus.connect(this.master);

        // Shared gentle echo for the lead voice (the RuneScape haze).
        const delay = this.ctx.createDelay(1.2);
        this.echoDelay = delay;
        delay.delayTime.value = 0.42;
        const feedback = this.ctx.createGain();
        feedback.gain.value = 0.32;
        const delayFilter = this.ctx.createBiquadFilter();
        delayFilter.type = 'lowpass';
        delayFilter.frequency.value = 1800;
        delay.connect(feedback);
        feedback.connect(delayFilter);
        delayFilter.connect(delay);
        this.delaySend = this.ctx.createGain();
        this.delaySend.gain.value = 0.5;
        this.delaySend.connect(delay);
        delay.connect(this.musicBus);

        // Reusable noise buffer for wind, chirps, thuds...
        const len = this.ctx.sampleRate * 2;
        this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = this.noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

        this.startWind();
        this.nextNoteAt = this.ctx.currentTime + 0.2;
        window.setInterval(() => this.schedule(), 180);
    }

    // ------------------------------------------------------------- ambience

    private windGain: GainNode | null = null;
    private windFilter: BiquadFilterNode | null = null;
    private rainGain: GainNode | null = null;

    private startWind() {
        if (!this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 320;
        const gain = this.ctx.createGain();
        gain.gain.value = 0.02;
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.ambienceBus);
        src.start();
        this.windGain = gain;
        this.windFilter = filter;

        // Rain bed: high, hissy noise, silent until the weather opens it.
        const rainSrc = this.ctx.createBufferSource();
        rainSrc.buffer = this.noiseBuffer;
        rainSrc.loop = true;
        const rainHp = this.ctx.createBiquadFilter();
        rainHp.type = 'highpass';
        rainHp.frequency.value = 1400;
        const rainLp = this.ctx.createBiquadFilter();
        rainLp.type = 'lowpass';
        rainLp.frequency.value = 6500;
        const rainGain = this.ctx.createGain();
        rainGain.gain.value = 0;
        rainSrc.connect(rainHp);
        rainHp.connect(rainLp);
        rainLp.connect(rainGain);
        rainGain.connect(this.ambienceBus);
        rainSrc.start();
        this.rainGain = rainGain;
    }

    /**
     * The audible wind follows the SAME deterministic gust field the flags and
     * smoke sample (the scene feeds windAtScreen at the camera). When a gust
     * front visibly rolls across the village, this swell rolls with it.
     */
    setWindLevel(level: number) {
        if (!this.ctx || !this.windGain || !this.windFilter) return;
        const v = Math.max(0, Math.min(1.3, level));
        const t = this.ctx.currentTime;
        this.windGain.gain.setTargetAtTime(0.008 + v * 0.045, t, 0.25);
        this.windFilter.frequency.setTargetAtTime(240 + v * 420, t, 0.35);
    }

    /** Rain intensity 0..1 — the weather system drives this. */
    private lastRainLevel = 0;

    setRainLevel(level: number) {
        this.lastRainLevel = level;
        if (!this.ctx || !this.rainGain) return;
        const v = Math.max(0, Math.min(1, level));
        // Rain is background too: it stands back while the drums play.
        const duck = this.battleMusic ? 0.2 : 1;
        this.rainGain.gain.setTargetAtTime(v * 0.055 * duck, this.ctx.currentTime, 0.8);
    }

    /** A quiet positional one-shot: pan -1..1, gain scaled by distance. */
    private spatial(pan: number, gain: number): { node: AudioNode; t: number } | null {
        if (!this.ctx) return null;
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        const g = this.ctx.createGain();
        g.gain.value = Math.max(0, Math.min(1, gain));
        g.connect(panner);
        panner.connect(this.ambienceBus);
        return { node: g, t: this.ctx.currentTime };
    }

    /** Distant hammer tap from a working villager (positional). */
    hammerTap(pan: number, gain: number) {
        if (!this.started || !this.ctx) return;
        const out = this.spatial(pan, gain);
        if (!out) return;
        const t = out.t + 0.01;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        const f0 = 1500 + Math.random() * 700;
        osc.frequency.setValueAtTime(f0, t);
        osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.05);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        osc.connect(g);
        g.connect(out.node);
        osc.start(t);
        osc.stop(t + 0.09);
    }

    /** A soft two-note owl hoot in the dark (positional). */
    owlHoot(pan: number, gain: number) {
        if (!this.started || !this.ctx) return;
        const out = this.spatial(pan, gain);
        if (!out) return;
        for (let i = 0; i < 2; i++) {
            const t = out.t + 0.05 + i * 0.42;
            const osc = this.ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(i === 0 ? 392 : 330, t);
            osc.frequency.exponentialRampToValueAtTime(i === 0 ? 340 : 292, t + 0.3);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, t);
            g.gain.linearRampToValueAtTime(0.09, t + 0.05);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
            osc.connect(g);
            g.connect(out.node);
            osc.start(t);
            osc.stop(t + 0.4);
        }
    }

    /** A far wolf howl at the treeline (positional). */
    wolfHowl(pan: number, gain: number) {
        if (!this.started || !this.ctx) return;
        const out = this.spatial(pan, gain);
        if (!out) return;
        const t = out.t + 0.05;
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(280, t);
        osc.frequency.linearRampToValueAtTime(520, t + 0.5);
        osc.frequency.setValueAtTime(520, t + 0.9);
        osc.frequency.exponentialRampToValueAtTime(310, t + 1.7);
        const vib = this.ctx.createOscillator();
        vib.frequency.value = 5.2;
        const vibGain = this.ctx.createGain();
        vibGain.gain.value = 9;
        vib.connect(vibGain);
        vibGain.connect(osc.frequency);
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.35);
        g.gain.setValueAtTime(0.07, t + 1.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
        osc.connect(g);
        g.connect(out.node);
        osc.start(t);
        osc.stop(t + 1.9);
        vib.start(t);
        vib.stop(t + 1.9);
    }

    private birdChirp(at: number) {
        if (!this.ctx) return;
        const notes = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < notes; i++) {
            const t = at + i * (0.07 + Math.random() * 0.05);
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            const f0 = 2300 + Math.random() * 1400;
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f0, t);
            osc.frequency.exponentialRampToValueAtTime(f0 * (1.2 + Math.random() * 0.3), t + 0.05);
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(0.028, t + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
            osc.connect(gain);
            gain.connect(this.ambienceBus);
            osc.start(t);
            osc.stop(t + 0.12);
        }
    }

    private cricket(at: number) {
        if (!this.ctx) return;
        // A short "cree-cree": two pulsed high buzzes.
        for (let burst = 0; burst < 2; burst++) {
            const t0 = at + burst * 0.22;
            const osc = this.ctx.createOscillator();
            osc.type = 'square';
            osc.frequency.value = 4200 + Math.random() * 300;
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 4300;
            filter.Q.value = 9;
            const gain = this.ctx.createGain();
            gain.gain.value = 0;
            // pulse train inside the burst
            for (let p = 0; p < 6; p++) {
                const t = t0 + p * 0.024;
                gain.gain.setValueAtTime(0.016, t);
                gain.gain.setValueAtTime(0.0001, t + 0.013);
            }
            osc.connect(filter);
            filter.connect(gain);
            gain.connect(this.ambienceBus);
            osc.start(t0);
            osc.stop(t0 + 0.2);
        }
    }

    // --------------------------------------------------------------- music

    private schedule() {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const nf = this.nightFactor;

        // Ambient critters ride the same scheduler.
        if (nf < 0.4 && now >= this.nextChirpAt) {
            this.nextChirpAt = now + 3 + Math.random() * 7;
            this.birdChirp(now + 0.05);
        }
        if (nf > 0.6 && now >= this.nextCricketAt) {
            this.nextCricketAt = now + 1.2 + Math.random() * 1.6;
            this.cricket(now + 0.05);
        }

        // Melody: schedule up to ~0.7s ahead on the active track's grid.
        const track = TRACKS[this.currentTrackId()];
        const step = 60 / track.bpm / 2;
        while (this.nextNoteAt < now + 0.7) {
            this.scheduleBeat(this.nextNoteAt, nf, track);
            this.nextNoteAt += step;
            this.beat = (this.beat + 1) % 32;
        }
    }

    private scheduleBeat(t: number, nf: number, track: TrackDef) {
        if (!this.ctx) return;
        const scale = track.scale;
        // Drone bass on bar starts.
        if (this.beat % 16 === 0) {
            this.tone(t, scale[0] / 2, 1.9, 0.05, 'sine', 0);
        } else if (this.beat % 16 === 8) {
            this.tone(t, scale[Math.min(4, scale.length - 1)] / 2, 1.4, 0.035, 'sine', 0);
        }

        // Lead: a wandering modal melody. Rests keep it airy; night is sparser.
        const restChance = 0.38 + track.restBias + (this.trackOverride ? 0 : nf * 0.25);
        if (this.beat % 2 === 0 && Math.random() > restChance) {
            // Small random walk that leans back toward the tonic region.
            const drift = Math.random() < 0.6 ? (Math.random() < 0.5 ? -1 : 1) : (Math.random() < 0.5 ? -2 : 2);
            this.melodyDegree = Math.max(0, Math.min(scale.length - 1, this.melodyDegree + drift));
            if (this.beat % 32 === 30) this.melodyDegree = Math.min(4, scale.length - 1); // phrases resolve
            const freq = scale[this.melodyDegree];
            const dur = Math.random() < 0.25 ? 0.62 : 0.3;
            // Sawtooth leads run hot — trim their peak so every track sits level.
            const peak = track.lead === 'sawtooth' ? 0.035 : 0.055;
            this.tone(t, freq, dur, peak, track.lead, 0.9, true);
        }
        // The track's own echo colour.
        if (this.echoDelay && !this.trackOverride) return;
        if (this.echoDelay && this.trackOverride) {
            this.echoDelay.delayTime.setTargetAtTime(track.echo, t, 1.2);
        }
    }

    /** One melodic/bass tone with envelope, optional vibrato + echo send. */
    private tone(t: number, freq: number, dur: number, peak: number, type: OscillatorType, echo: number, vibrato = false) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        if (vibrato) {
            const lfo = this.ctx.createOscillator();
            lfo.frequency.value = 5.2;
            const lfoGain = this.ctx.createGain();
            lfoGain.gain.value = freq * 0.006;
            lfo.connect(lfoGain);
            lfoGain.connect(osc.frequency);
            lfo.start(t);
            lfo.stop(t + dur + 0.15);
        }
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.03);
        gain.gain.setTargetAtTime(0, t + dur * 0.6, dur * 0.28);
        osc.connect(gain);
        gain.connect(this.musicBus);
        if (echo > 0) {
            const send = this.ctx.createGain();
            send.gain.value = echo;
            gain.connect(send);
            send.connect(this.delaySend);
        }
        osc.start(t);
        osc.stop(t + dur + 0.6);
    }

    // ----------------------------------------------------------------- sfx

    /**
     * Creature voices — every click answers back. Villagers give a cheery
     * two-note "hi!" pitched to the individual (elders lower and slower),
     * dogs bark, chickens cluck. `soft` is the hover variant: shorter,
     * quieter, more of a glance than a greeting.
     */
    voice(kind: 'villager' | 'dog' | 'chicken', pitchSeed = 0.5, elder = false, soft = false) {
        if (!this.ctx || !this.started) return;
        this.lastPlayed = `voice:${kind}${soft ? ':soft' : ''}`;
        const t = this.ctx.currentTime + 0.01;
        if (kind === 'villager') {
            const f0 = (elder ? 190 : 260) + pitchSeed * (elder ? 60 : 150);
            const dur = elder ? 0.16 : 0.11;
            const vol = soft ? 0.035 : 0.06;
            this.syllable(t, f0, dur, vol);
            if (!soft) this.syllable(t + dur + 0.03, f0 * 1.3, dur * 1.15, vol * 0.9);
        } else if (kind === 'dog') {
            this.bark(t, soft);
            if (!soft && Math.random() < 0.35) this.bark(t + 0.16, false);
        } else {
            this.cluck(t, soft);
            if (!soft) this.cluck(t + 0.11, false);
        }
    }

    /** A vowel-ish blip: triangle tone through a formant bandpass. */
    private syllable(t: number, freq: number, dur: number, vol: number) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq * 0.9, t);
        osc.frequency.linearRampToValueAtTime(freq, t + dur * 0.4);
        osc.frequency.linearRampToValueAtTime(freq * 0.82, t + dur);
        const formant = this.ctx.createBiquadFilter();
        formant.type = 'bandpass';
        formant.frequency.value = freq * 3.2;
        formant.Q.value = 1.1;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(formant);
        formant.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + dur + 0.05);
    }

    private bark(t: number, soft: boolean) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(soft ? 110 : 150, t);
        osc.frequency.exponentialRampToValueAtTime(soft ? 75 : 85, t + 0.09);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 480;
        filter.Q.value = 0.9;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(soft ? 0.05 : 0.1, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + (soft ? 0.08 : 0.11));
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 0.15);
        // Breathy transient at the front of the woof.
        this.noiseHit(t, 700, 0.04, soft ? 0.03 : 0.06);
    }

    private cluck(t: number, soft: boolean) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(640, t);
        osc.frequency.exponentialRampToValueAtTime(360, t + 0.06);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 900;
        filter.Q.value = 2;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(soft ? 0.025 : 0.05, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 0.1);
    }

    /** Fire a named effect (no-op until audio is unlocked). */
    play(name: SfxName) {
        if (!this.ctx || !this.started) return;
        this.lastPlayed = name;
        const t = this.ctx.currentTime + 0.01;
        switch (name) {
            case 'coin':
                this.ping(t, 1320, 0.05);
                this.ping(t + 0.07, 1760, 0.04);
                break;
            case 'click':
                this.ping(t, 900, 0.03, 0.04);
                break;
            case 'thud':
                this.noiseHit(t, 240, 0.16, 0.09);
                this.ping(t, 90, 0.06, 0.22, 'sine');
                break;
            case 'door':
                this.creak(t);
                break;
            case 'eggLay':
                this.ping(t, 620, 0.035, 0.08, 'sine', 300);
                break;
            case 'eggCollect':
                this.ping(t, 880, 0.04);
                this.ping(t + 0.08, 1320, 0.035);
                break;
            case 'stone':
                this.noiseHit(t, 420, 0.1, 0.08);
                this.ping(t, 130, 0.045, 0.14, 'sine');
                break;
            case 'deposit':
                this.noiseHit(t, 500, 0.07, 0.06);
                this.ping(t + 0.06, 1100, 0.03);
                break;
            case 'tap':
                this.noiseHit(t, 1100, 0.028, 0.045);
                break;
            case 'snip':
                this.noiseHit(t, 2800, 0.022, 0.04);
                break;
            case 'deploy':
                this.ping(t, 520, 0.05, 0.09, 'triangle', 260);
                this.noiseHit(t + 0.02, 800, 0.05, 0.1);
                break;
            case 'horn': {
                this.tonePair(t, 220, 330, 0.32, 0.045);
                break;
            }
            case 'dragon':
                this.roar(t);
                break;
            case 'merchant':
                // Peddler's jingle: three rising bell tones with a grace note.
                this.ping(t, 660, 0.05, 0.18, 'triangle');
                this.ping(t + 0.14, 830, 0.05, 0.18, 'triangle');
                this.ping(t + 0.28, 990, 0.06, 0.3, 'triangle');
                this.ping(t + 0.3, 1320, 0.025, 0.22, 'sine');
                break;
            case 'trade':
                // Handshake and coins changing hands.
                this.noiseHit(t, 700, 0.06, 0.07);
                this.ping(t + 0.05, 1150, 0.045, 0.1, 'square');
                this.ping(t + 0.11, 1450, 0.04, 0.12, 'square');
                break;
            case 'destroy':
                this.noiseHit(t, 160, 0.5, 0.16);
                this.ping(t, 60, 0.2, 0.4, 'sine');
                break;
        }
    }

    private ping(t: number, freq: number, peak: number, dur = 0.12, type: OscillatorType = 'sine', slideTo?: number) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + dur + 0.05);
    }

    private noiseHit(t: number, freqCenter: number, dur: number, peak: number) {
        if (!this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.playbackRate.value = 0.9 + Math.random() * 0.2;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = freqCenter;
        filter.Q.value = 1.4;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(peak, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        src.start(t);
        src.stop(t + dur + 0.05);
    }

    private creak(t: number) {
        if (!this.ctx) return;
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(150, t);
        osc.frequency.linearRampToValueAtTime(95, t + 0.16);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.02, t + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 0.25);
    }

    private tonePair(t: number, f1: number, f2: number, dur: number, peak: number) {
        if (!this.ctx) return;
        this.ping(t, f1, peak, dur, 'sawtooth');
        this.ping(t + dur * 0.55, f2, peak * 0.9, dur, 'sawtooth');
    }

    private roar(t: number) {
        if (!this.ctx) return;
        // Distant: a slow swell of low noise + a growling saw, heavily lowpassed.
        const src = this.ctx.createBufferSource();
        src.buffer = this.noiseBuffer;
        src.loop = true;
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 220;
        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.09, t + 0.5);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);
        src.start(t);
        src.stop(t + 1.7);

        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(52, t);
        osc.frequency.linearRampToValueAtTime(38, t + 1.3);
        const oscFilter = this.ctx.createBiquadFilter();
        oscFilter.type = 'lowpass';
        oscFilter.frequency.value = 180;
        const oscGain = this.ctx.createGain();
        oscGain.gain.setValueAtTime(0, t);
        oscGain.gain.linearRampToValueAtTime(0.05, t + 0.4);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
        osc.connect(oscFilter);
        oscFilter.connect(oscGain);
        oscGain.connect(this.sfxBus);
        osc.start(t);
        osc.stop(t + 1.6);
    }
}

export const soundSystem = new SoundSystem();
