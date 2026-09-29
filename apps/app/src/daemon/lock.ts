import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The process lock (§3.2): `data/fha.lock` holds the daemon's PID, so two daemons never run the
 * same schedule (two lineup runs, two digests). Created with `wx`, which fails if the file
 * exists; a lock whose PID is no longer alive is stale (a crash or a SIGKILL) and is taken over.
 */
export class LockHeldError extends Error {
  override readonly name = 'LockHeldError';
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`${path} is held by running process ${pid}`);
  }
}

export interface Lock {
  path: string;
  release(): void;
}

/** True when a process with this PID exists (signal 0 checks without sending anything). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else, which still means "held".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireLock(
  path: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): Lock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx' });
      return { path, release: () => release(path, pid) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readPid(path);
    // Our own live PID counts as held too: a second daemon in this process is a bug.
    if (holder !== undefined && isAlive(holder)) throw new LockHeldError(path, holder);
    // Stale (the holder is gone, or the file is unreadable): take it over.
    try {
      unlinkSync(path);
    } catch {
      // Another process removed it first; the retry decides.
    }
  }
  throw new LockHeldError(path, readPid(path) ?? -1);
}

function readPid(path: string): number | undefined {
  try {
    const n = Number(readFileSync(path, 'utf-8').trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Only our own lock is removed: a lock taken over by another process is left alone. */
function release(path: string, pid: number): void {
  if (readPid(path) !== pid) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}
