import { isFrozen } from '../runtime.js';
import type { Runtime } from '../runtime.js';
import type { IdlingGame } from '../types/index.js';

const MINUTE_MS = 60_000;
// Steam commits a session's playtime when the session ends cleanly, so a
// relog this often bounds what a session that dies unnoticed can lose
const FLUSH_EVERY_MS = 4 * 60 * MINUTE_MS;
// How often the committed playtime is checked for growth. Steam's commits are
// about 30 minutes apart, so a shorter window would raise false alarms.
const CHECK_EVERY_MS = 90 * MINUTE_MS;
// After a takeover, wait this long before reading back what Steam kept
const DRIFT_CHECK_DELAY_MS = 2 * MINUTE_MS;

// A committed playtime reading for one app
interface Reading {
  appid: number;
  playtime: number;
}

// Two guards on Steam actually counting the idle time
// (docs/steam-playtime-research.md): a relog every 4 hours that commits the
// running session, and a check that the committed playtime keeps growing,
// which relogs a session that stopped counting. Built inert; start() arms
// both once idling has begun.
export class Flush {
  // The reading the next check compares against (null: take a new one)
  private baseline: Reading | null = null;
  // The last reading that showed growth, the "before" of a takeover report
  private lastGood: Reading | null = null;
  // A takeover happened; report what Steam kept once the session is back
  private driftReportDue = false;
  // A flat check relogs first; only a second flat check in a row means the
  // session is really dead
  private flatChecks = 0;
  // Apps Steam's owned-apps answer leaves out (family-shared, unvetted). They
  // cannot be probed, and probing one for ever would switch the check off.
  private readonly unprobeable = new Set<number>();

  constructor(private readonly rt: Runtime) {}

  // Arms the relog and the check
  start(): void {
    this.armFlush();
    this.armCheck();
  }

  // Playtime stands still during a block; a baseline from before it would
  // count as a flat check right after
  resetBaseline(): void {
    this.baseline = null;
    this.flatChecks = 0;
  }

  // Called on a takeover: once back, report how much of the time before it
  // Steam kept (only when there is a good reading to compare with)
  noteTakeover(): void {
    if (this.lastGood) this.driftReportDue = true;
  }

  // Called by restoreIdling once the session is back
  afterResume(): void {
    if (!this.driftReportDue) return;
    this.driftReportDue = false;
    if (this.lastGood) this.reportDrift(this.lastGood);
  }

  // One delayed reading of the app's committed playtime against the last good
  // one, sent to Discord. Information only: a failed probe is dropped.
  private reportDrift(before: Reading): void {
    const rt = this.rt;
    rt.timers.timeout(
      'takeoverDrift',
      async () => {
        try {
          const after = await rt.client.getPlaytimeForever(before.appid);
          if (after === null) return;
          const delta = after - before.playtime;
          const name = rt.library.byId.get(before.appid)?.name ?? `App ${before.appid}`;
          rt.discord.send(
            `📊 Post-takeover commit check (${name}): last-known ${before.playtime}m → now ${after}m (Δ${delta >= 0 ? '+' : ''}${delta}m).`
          );
        } catch {
          // A probe that fails here is not worth a message
        }
      },
      DRIFT_CHECK_DELAY_MS
    );
  }

  // Logs off and on to make Steam commit the running session (also used to
  // replace a dead one). The disconnect and logon handlers restore idling and
  // clear selfInitiatedRelog. steamID stays set until Steam answers the logOff,
  // so isConnected cannot tell a relog in flight: the flag is what stops a
  // second one when the flush and the check fire close together.
  forceRelog(): void {
    const rt = this.rt;
    if (!rt.client.isConnected || rt.selfInitiatedRelog) return;
    rt.selfInitiatedRelog = true;
    try {
      rt.client.relog();
    } catch {
      rt.selfInitiatedRelog = false;
    }
  }

  // Every FLUSH_EVERY_MS: relog, when games are idling and nothing else owns the session
  private armFlush(): void {
    this.rt.timers.timeout(
      'flush',
      () => {
        const rt = this.rt;
        const quiet = !rt.isWaitingForResume && !rt.isInEditMode && !rt.isShuttingDown && !rt.session.blocked;
        if (quiet && rt.session.idling.length > 0) this.forceRelog();
        this.armFlush();
      },
      FLUSH_EVERY_MS
    );
  }

  // The game to read: the baseline's game while it still idles, so readings
  // compare like with like; otherwise the first idling game that can be read
  // (which then starts a new baseline instead of counting as flat)
  private probeTarget(): IdlingGame | null {
    const { idling } = this.rt.session;
    const same = this.baseline && idling.find((g) => g.appid === this.baseline?.appid);
    return same || (idling.find((g) => !this.unprobeable.has(g.appid)) ?? null);
  }

  // Nothing may relog while the session is down, being edited, stopping or
  // already relogging
  private mustSkip(): boolean {
    const rt = this.rt;
    return isFrozen(rt) || rt.isInEditMode || rt.isShuttingDown || rt.selfInitiatedRelog || !rt.client.isConnected;
  }

  // Reads the committed playtime of one idling game. Growth since the last
  // reading is healthy. A full window without growth relogs once; a second
  // in a row alerts Discord and relogs again.
  async runZombieCheck(): Promise<void> {
    const rt = this.rt;
    if (this.mustSkip()) return;
    const target = this.probeTarget();
    if (!target) {
      this.baseline = null;
      return;
    }

    let playtime: number | null;
    try {
      playtime = await rt.client.getPlaytimeForever(target.appid);
    } catch {
      // A failed request says nothing; keep the baseline for the next window
      return;
    }
    // The state may have changed while the request ran
    if (this.mustSkip()) return;
    if (playtime === null) {
      // Steam left the app out: read another game next time
      this.unprobeable.add(target.appid);
      this.baseline = null;
      return;
    }

    const reading = { appid: target.appid, playtime };
    if (this.baseline?.appid !== target.appid || playtime > this.baseline.playtime) {
      this.baseline = reading;
      this.lastGood = reading;
      this.flatChecks = 0;
      return;
    }

    // No growth over a whole window for a game that idled all along
    this.flatChecks += 1;
    if (this.flatChecks === 1) {
      // Maybe just a slow commit: a relog commits for sure, and the next
      // window compares against the same baseline
      this.forceRelog();
      return;
    }
    rt.discord.send('⚠️ Zombie session — playtime not committing after a relog. Forcing reconnect.');
    this.flatChecks = 0;
    this.baseline = null;
    this.forceRelog();
  }

  // Runs the check every CHECK_EVERY_MS. A shutdown that cleared the timers
  // while a check was running must not see it armed again.
  private armCheck(): void {
    this.rt.timers.timeout(
      'zombie',
      async () => {
        await this.runZombieCheck();
        if (!this.rt.isShuttingDown) this.armCheck();
      },
      CHECK_EVERY_MS
    );
  }
}
