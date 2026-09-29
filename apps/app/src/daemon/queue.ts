/**
 * The daemon's serial job queue (§3.2): one job at a time, in arrival order.
 *
 * Jobs are keyed (`lineup:<userId>`), and a key already waiting is not queued twice, so a burst
 * of injury events cannot stack five lineup runs. A running job is not a waiting one: the same
 * key enqueued while it runs queues once more, because the news that triggered it arrived after
 * the run read the league. A job never throws out of the queue (§24.8): a failure goes to
 * `onError` and the next job starts.
 */
export interface QueuedJob {
  key: string;
  run: (signal: AbortSignal) => Promise<void>;
}

export class SerialQueue {
  private readonly waiting: QueuedJob[] = [];
  private current: { key: string; done: Promise<void> } | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly onError: (key: string, err: unknown) => void) {}

  /** False when stopped, or when a job with this key is already waiting. */
  enqueue(job: QueuedJob): boolean {
    if (this.stopped || this.waiting.some((j) => j.key === job.key)) return false;
    this.waiting.push(job);
    if (this.current === undefined) void this.next();
    return true;
  }

  get running(): string | undefined {
    return this.current?.key;
  }

  pending(): string[] {
    return this.waiting.map((j) => j.key);
  }

  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void> {
    if (this.current === undefined && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Graceful stop: nothing new is accepted, waiting jobs are dropped, and the running job is
   * allowed to finish. `abortRunning` also signals it (a second SIGTERM).
   */
  async stop(opts: { abortRunning?: boolean } = {}): Promise<void> {
    this.stopped = true;
    this.waiting.length = 0;
    if (opts.abortRunning === true) this.abort.abort();
    await this.current?.done;
  }

  private async next(): Promise<void> {
    const job = this.waiting.shift();
    if (job === undefined) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
      return;
    }
    const done = this.runOne(job);
    this.current = { key: job.key, done };
    await done;
    this.current = undefined;
    await this.next();
  }

  private async runOne(job: QueuedJob): Promise<void> {
    try {
      await job.run(this.abort.signal);
    } catch (err) {
      try {
        this.onError(job.key, err);
      } catch {
        // The error reporter failing must not stop the queue.
      }
    }
  }
}
