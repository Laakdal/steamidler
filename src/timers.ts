// Every timer the idler arms, held by name, so shutdown can clear them all in
// one place and a re-arm can never orphan the previous handle.
// Names: 'display', 'resume', 'resumeNotify', 'pauseNotify', 'midnight',
// 'flush', 'zombie', 'takeoverDrift'.
export class Timers {
  private handles = new Map<string, { kind: 'timeout' | 'interval'; handle: NodeJS.Timeout }>();

  // One-shot timer; clears a timer of the same name first. The entry is gone
  // before fn runs, so fn may re-arm its own name and has(name) reads false.
  timeout(name: string, fn: () => void, ms: number): void {
    this.clear(name);
    const handle = setTimeout(() => {
      if (this.handles.get(name)?.handle === handle) this.handles.delete(name);
      fn();
    }, ms);
    this.handles.set(name, { kind: 'timeout', handle });
  }

  // Repeating timer; clears a timer of the same name first. Pending until cleared.
  interval(name: string, fn: () => void, ms: number): void {
    this.clear(name);
    this.handles.set(name, { kind: 'interval', handle: setInterval(fn, ms) });
  }

  // Cancels the named timer; a no-op when none is pending
  clear(name: string): void {
    const entry = this.handles.get(name);
    if (!entry) return;
    if (entry.kind === 'interval') clearInterval(entry.handle);
    else clearTimeout(entry.handle);
    this.handles.delete(name);
  }

  // True while the named timer is pending (a fired timeout is no longer)
  has(name: string): boolean {
    return this.handles.has(name);
  }

  // Shutdown and crash paths: nothing may fire into a logged-off client
  clearAll(): void {
    for (const name of [...this.handles.keys()]) this.clear(name);
  }
}
