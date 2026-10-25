import { isFrozen } from '../runtime.js';
import type { Runtime } from '../runtime.js';
import type { IdlingGame } from '../types/index.js';

const HOURS_MS = 60 * 60 * 1000;
// Periodic relog to force a playtime commit (clean logOff). Caps worst-case loss
// at this interval instead of the whole session.
const FLUSH_INTERVAL_MS = 4 * HOURS_MS;
// Watchdog that checks server playtime is actually climbing. Must exceed the
// ~30min commit lore to avoid false positives.
const ZOMBIE_CHECK_INTERVAL_MS = 90 * 60 * 1000;
const TAKEOVER_DRIFT_DELAY_MS = 120_000;

// The 4-hour flush relog and the zombie watchdog, which together cap how much
// playtime a stale Steam session can lose (docs/steam-playtime-research.md).
// Constructed inert: start() arms the timers once idling has begun.
export class Flush {
  // Last successful single-app playtime probe (zombie watchdog). Doubles as the
  // "last known good" baseline for post-takeover drift reporting.
  private zombieBaseline: { appid: number; playtime: number; at: number } | null = null;
  private lastGoodPlaytime: { appid: number; playtime: number } | null = null;
  private takeoverDriftPending = false;
  // Consecutive zombie checks with flat server playtime (two-strike: the first
  // flat reading triggers a flush relog, only a second confirms a real zombie).
  private zombieStrike = 0;
  // Apps the owned-apps probe returns nothing for (family-shared / unvetted);
  // skipped as probe candidates so the watchdog is not silently disabled.
  private readonly unprobeableAppIds = new Set<number>();

  // Takes the shared runtime; arms nothing yet
  constructor(private readonly rt: Runtime) {}

  // Arms the flush and zombie timers when idling starts
  start(): void {
    this.scheduleFlush();
    this.scheduleZombieCheck();
  }

  // Server playtime is flat for the whole block; a baseline from before it
  // would read as a zombie strike on the first probe afterwards.
  resetBaseline(): void {
    this.zombieBaseline = null;
    this.zombieStrike = 0;
  }

  // A takeover kicked the session: once it is back, report how much of the
  // pre-takeover tail the server kept (only when a known-good value exists).
  noteTakeover(): void {
    if (this.lastGoodPlaytime) this.takeoverDriftPending = true;
  }

  // Called by restoreIdling once the session is back: runs the pending drift report
  afterResume(): void {
    if (this.takeoverDriftPending) {
      if (this.lastGoodPlaytime) this.reportTakeoverDrift(this.lastGoodPlaytime);
      this.takeoverDriftPending = false;
    }
  }

  // One-shot, delayed comparison of the server's committed playtime against the
  // last known-good value, to quantify how much of the pre-takeover tail survived.
  // Observability only; reuses the zombie watchdog's baseline.
  private reportTakeoverDrift(lastGood: { appid: number; playtime: number }): void {
    this.rt.timers.timeout('takeoverDrift', async () => {
      try {
        const now = await this.rt.client.getPlaytimeForever(lastGood.appid);
        if (now === null) return;
        const delta = now - lastGood.playtime;
        const name = this.rt.library.byId.get(lastGood.appid)?.name ?? `App ${lastGood.appid}`;
        const sign = delta >= 0 ? '+' : '';
        this.rt.discord.send(
          `📊 Post-takeover commit check (${name}): last-known ${lastGood.playtime}m → now ${now}m (Δ${sign}${delta}m).`
        );
      } catch {
        // Best-effort observability — a failed probe is not worth surfacing.
      }
    }, TAKEOVER_DRIFT_DELAY_MS);
  }

  // Shared self-initiated relog used by the periodic flush and zombie recovery. A
  // clean logOff commits the in-flight idle session; the disconnect→loggedOn
  // handlers restore idling and clear the suppression flag. Re-entrant calls
  // (flush timer and zombie check firing close together) are ignored: steamID
  // stays set until Steam acknowledges the logOff, so isConnected alone is not
  // enough to detect a relog already in flight.
  forceRelog(): void {
    if (!this.rt.client.isConnected || this.rt.selfInitiatedRelog) return;
    this.rt.selfInitiatedRelog = true;
    try {
      this.rt.client.relog();
    } catch {
      this.rt.selfInitiatedRelog = false;
    }
  }

  // Mitigation A: periodically force a clean logOff+reconnect so the server folds
  // the in-flight idle session into playtime_forever. Caps worst-case loss at
  // FLUSH_INTERVAL_MS. Self-reschedules.
  private scheduleFlush(): void {
    this.rt.timers.timeout('flush', () => {
      const rt = this.rt;
      const idle = !rt.isWaitingForResume && !rt.isInEditMode && !rt.isShuttingDown && !rt.session.blocked;
      if (idle && rt.session.idling.length > 0) {
        this.forceRelog();
      }
      this.scheduleFlush();
    }, FLUSH_INTERVAL_MS);
  }

  // Picks the app to probe: stick with the current baseline app while it is still
  // continuously idling, otherwise fall back to the first probeable idling game
  // (which forces a re-baseline rather than a false zombie verdict).
  private pickProbeApp(): IdlingGame | null {
    if (this.zombieBaseline) {
      const still = this.rt.session.idling.find((g) => g.appid === this.zombieBaseline!.appid);
      if (still) return still;
    }
    return this.rt.session.idling.find((g) => !this.unprobeableAppIds.has(g.appid)) ?? null;
  }

  // Mitigation B: confirm the server's playtime is actually climbing for a
  // continuously-idled app. If a full window passes with no increase, commits are
  // silently dying (zombie session) → alert + force a relog. Self-reschedules.
  async runZombieCheck(): Promise<void> {
    const rt = this.rt;
    if (isFrozen(rt) || rt.isInEditMode || rt.isShuttingDown || rt.selfInitiatedRelog || !rt.client.isConnected) {
      return;
    }
    if (rt.session.idling.length === 0) {
      this.zombieBaseline = null;
      return;
    }

    const probe = this.pickProbeApp();
    if (!probe) {
      this.zombieBaseline = null;
      return;
    }

    let playtime: number | null;
    try {
      playtime = await rt.client.getPlaytimeForever(probe.appid);
    } catch {
      return; // transient fetch error — keep the baseline, try again next tick
    }
    // State may have moved while the probe was in flight (disconnect, edit mode,
    // shutdown); a relog must not fire into any of those.
    if (isFrozen(rt) || rt.isInEditMode || rt.isShuttingDown || rt.selfInitiatedRelog || !rt.client.isConnected) {
      return;
    }
    if (playtime === null) {
      // Inconclusive (app absent from the owned-apps response, e.g. family-shared).
      // Remember it so the next tick probes a different game instead of this one
      // forever.
      this.unprobeableAppIds.add(probe.appid);
      this.zombieBaseline = null;
      return;
    }

    const now = Date.now();

    if (!this.zombieBaseline || this.zombieBaseline.appid !== probe.appid) {
      this.zombieBaseline = { appid: probe.appid, playtime, at: now };
      this.lastGoodPlaytime = { appid: probe.appid, playtime };
      this.zombieStrike = 0;
      return;
    }

    if (playtime > this.zombieBaseline.playtime) {
      this.zombieBaseline = { appid: probe.appid, playtime, at: now };
      this.lastGoodPlaytime = { appid: probe.appid, playtime };
      this.zombieStrike = 0;
      return;
    }

    // Same app, continuously idling, a full window with no server-side increase.
    if (this.zombieStrike === 0) {
      // First strike: a healthy session may just be slow to commit. Force a flush
      // relog (which commits) and re-check next window before alarming. Keep the
      // baseline so the next probe compares against the same value.
      this.zombieStrike = 1;
      this.forceRelog();
      return;
    }

    // Second strike: a forced relog already failed to produce a commit → real
    // zombie. Alert and force another reconnect, then reset.
    rt.discord.send('⚠️ Zombie session — playtime not committing after a relog. Forcing reconnect.');
    this.zombieStrike = 0;
    this.zombieBaseline = null;
    this.forceRelog();
  }

  // Runs the zombie check every ZOMBIE_CHECK_INTERVAL_MS, re-arming after each run
  private scheduleZombieCheck(): void {
    this.rt.timers.timeout('zombie', async () => {
      await this.runZombieCheck();
      this.scheduleZombieCheck();
    }, ZOMBIE_CHECK_INTERVAL_MS);
  }
}
