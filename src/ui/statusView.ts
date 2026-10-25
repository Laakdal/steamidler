import type { Runtime } from '../runtime.js';
import type { DisplayLoop } from '../steam/resume.js';
import { showIdlingStatus } from './display.js';

// The terminal status table and its 60 s refresh tick; Resume stops and
// restarts the tick around a disconnect.
export class StatusView implements DisplayLoop {
  // Takes the shared runtime the table is drawn from
  constructor(private readonly rt: Runtime) {}

  // Renders the status table from current state. Every state change repaints
  // through here, so it also asks the Discord status box for a prompt update.
  render(): void {
    const rt = this.rt;
    showIdlingStatus(rt.session.idling, rt.session.paused, {
      waitingReason: rt.isWaitingForResume ? rt.waitingReason : null,
      playingBlocked: rt.session.blocked,
      showKeyHints: !rt.isHeadless,
    });
    rt.statusPanel?.nudge();
  }

  // (Re)starts the 60s tick that refreshes the table. On a non-TTY
  // (systemd/journald) nothing is printed, instead of ~35 lines every minute.
  start(): void {
    const rt = this.rt;
    rt.timers.interval('display', () => {
      if (!rt.idlingStartedAt || rt.isInEditMode) return;
      if (process.stdout.isTTY) this.render();
    }, 60000);
  }

  // Stops the 60s tick
  stop(): void {
    this.rt.timers.clear('display');
  }
}
