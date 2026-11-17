import { type LiveEvent, listenEvents, type Pool } from "@hookline/db";

type Listener = (e: LiveEvent) => void;

/**
 * One LISTEN connection per API process, fanned out to every SSE client and relay session.
 * The connection is opened on the first subscriber and closed after the last one leaves.
 */
export class EventHub {
  private listeners = new Set<Listener>();
  private stop: (() => Promise<void>) | null = null;
  private starting: Promise<void> | null = null;

  constructor(private pool: Pool) {}

  async subscribe(fn: Listener): Promise<() => void> {
    this.listeners.add(fn);
    if (!this.stop && !this.starting) {
      this.starting = listenEvents(this.pool, (e) => {
        for (const l of this.listeners) l(e);
      }).then((s) => {
        this.stop = s;
        this.starting = null;
      });
    }
    await this.starting;
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.stop) {
        const s = this.stop;
        this.stop = null;
        void s();
      }
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
    await this.starting;
    if (this.stop) await this.stop();
    this.stop = null;
  }
}
