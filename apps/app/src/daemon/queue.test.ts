import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LockHeldError, acquireLock, pidAlive } from './lock.js';
import { SerialQueue } from './queue.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('SerialQueue', () => {
  it('runs one job at a time, in order', async () => {
    const q = new SerialQueue(() => {});
    const log: string[] = [];
    const a = deferred();
    q.enqueue({
      key: 'a',
      run: async () => {
        log.push('a start');
        await a.promise;
        log.push('a end');
      },
    });
    q.enqueue({ key: 'b', run: () => Promise.resolve(void log.push('b')) });
    await Promise.resolve();
    expect(q.running).toBe('a');
    expect(q.pending()).toEqual(['b']);
    expect(log).toEqual(['a start']);
    a.resolve();
    await q.idle();
    expect(log).toEqual(['a start', 'a end', 'b']);
  });

  it('does not queue a key twice while it waits, but does once it is running', async () => {
    const q = new SerialQueue(() => {});
    const gate = deferred();
    const runs: string[] = [];
    const job = (key: string) => ({
      key,
      run: async () => {
        runs.push(key);
        await gate.promise;
      },
    });
    expect(q.enqueue(job('lineup'))).toBe(true); // starts running
    expect(q.enqueue(job('lineup'))).toBe(true); // waits
    expect(q.enqueue(job('lineup'))).toBe(false); // already waiting
    gate.resolve();
    await q.idle();
    expect(runs).toEqual(['lineup', 'lineup']);
  });

  it('a throwing job is reported and the next still runs (§24.8)', async () => {
    const errors: string[] = [];
    const q = new SerialQueue((key, err) => errors.push(`${key}: ${(err as Error).message}`));
    const ran: string[] = [];
    q.enqueue({ key: 'bad', run: () => Promise.reject(new Error('boom')) });
    q.enqueue({ key: 'good', run: () => Promise.resolve(void ran.push('good')) });
    await q.idle();
    expect(errors).toEqual(['bad: boom']);
    expect(ran).toEqual(['good']);
  });

  it('stop lets the running job finish, drops the waiting ones and refuses new ones', async () => {
    const q = new SerialQueue(() => {});
    const gate = deferred();
    const ran: string[] = [];
    let aborted = false;
    q.enqueue({
      key: 'long',
      run: async (signal) => {
        await gate.promise;
        aborted = signal.aborted;
        ran.push('long');
      },
    });
    q.enqueue({ key: 'next', run: () => Promise.resolve(void ran.push('next')) });
    const stopped = q.stop();
    expect(q.enqueue({ key: 'late', run: () => Promise.resolve() })).toBe(false);
    gate.resolve();
    await stopped;
    expect(ran).toEqual(['long']);
    expect(aborted).toBe(false);
  });
});

describe('process lock (§3.2)', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('one holder at a time; release frees it', () => {
    dir = mkdtempSync(join(tmpdir(), 'fha-lock-'));
    const path = join(dir, 'data', 'fha.lock');
    const lock = acquireLock(path, { pid: 111, isAlive: () => true });
    expect(readFileSync(path, 'utf-8').trim()).toBe('111');
    expect(() => acquireLock(path, { pid: 222, isAlive: () => true })).toThrow(LockHeldError);
    lock.release();
    expect(existsSync(path)).toBe(false);
    acquireLock(path, { pid: 222, isAlive: () => true }).release();
  });

  it('takes over a stale lock whose process is gone', () => {
    dir = mkdtempSync(join(tmpdir(), 'fha-lock-'));
    const path = join(dir, 'fha.lock');
    writeFileSync(path, '999999\n');
    const lock = acquireLock(path, { pid: 333, isAlive: (pid) => pid !== 999999 });
    expect(readFileSync(path, 'utf-8').trim()).toBe('333');
    // Releasing a lock someone else has since taken leaves theirs alone.
    writeFileSync(path, '444\n');
    lock.release();
    expect(readFileSync(path, 'utf-8').trim()).toBe('444');
  });

  it('pidAlive: this process is alive, nonsense PIDs are not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
  });
});
