import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentName } from '@fha/core';
import { parseJson, parseLoose, type Clock, type Db } from '../db.js';

// ── snapshots (§9.3 step 1) ──────────────────────────────────────────────────────────────────

export interface SnapshotRecord {
  id: number;
  teamKey: string;
  date: string;
  /** Whatever the pipeline saved (roster, FAAB, waiver state); its shape is the caller's. */
  roster: unknown;
  /** Usually the planId the snapshot was taken before, so `fha undo` can find it. */
  reason: string;
  createdAt: string;
}

export interface SnapshotsRepo {
  save(teamKey: string, date: string, roster: unknown, reason: string): number;
  latest(reason: string): SnapshotRecord | undefined;
}

interface SnapshotRow {
  id: number;
  team_key: string;
  date: string;
  roster_json: string;
  reason: string;
  created_at: string;
}

export function snapshotsRepo(db: Db, now: Clock): SnapshotsRepo {
  const insert = db.prepare(
    `INSERT INTO snapshots (team_key, date, roster_json, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const latest = db.prepare('SELECT * FROM snapshots WHERE reason = ? ORDER BY id DESC LIMIT 1');
  return {
    save(teamKey, date, roster, reason) {
      const info = insert.run(teamKey, date, JSON.stringify(roster), reason, now().toISOString());
      return Number(info.lastInsertRowid);
    },
    latest(reason) {
      const r = latest.get(reason) as SnapshotRow | undefined;
      if (r === undefined) return undefined;
      return {
        id: r.id,
        teamKey: r.team_key,
        date: r.date,
        roster: parseLoose(r.roster_json),
        reason: r.reason,
        createdAt: r.created_at,
      };
    },
  };
}

// ── questions (§15: askBen) ──────────────────────────────────────────────────────────────────

export interface QuestionRecord {
  id: string;
  runId: string;
  agent: AgentName;
  question: string;
  options: string[];
  answer?: string;
  askedAt: string;
  answeredAt?: string;
}

export interface QuestionsRepo {
  ask(runId: string, agent: AgentName, question: string, options?: readonly string[]): string;
  /** Returns false when the id is unknown or the question was already answered: first answer wins. */
  answer(id: string, text: string): boolean;
  get(id: string): QuestionRecord | undefined;
  /** Oldest first. */
  unanswered(): QuestionRecord[];
}

interface QuestionRow {
  id: string;
  run_id: string;
  agent: AgentName;
  question: string;
  options_json: string;
  answer: string | null;
  asked_at: string;
  answered_at: string | null;
}

const Options = z.array(z.string());

function toQuestion(r: QuestionRow): QuestionRecord {
  return {
    id: r.id,
    runId: r.run_id,
    agent: r.agent,
    question: r.question,
    options: parseJson(Options, r.options_json, `questions[${r.id}].options_json`),
    ...(r.answer === null ? {} : { answer: r.answer }),
    askedAt: r.asked_at,
    ...(r.answered_at === null ? {} : { answeredAt: r.answered_at }),
  };
}

export function questionsRepo(db: Db, now: Clock): QuestionsRepo {
  const insert = db.prepare(
    `INSERT INTO questions (id, run_id, agent, question, options_json, asked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const answer = db.prepare(
    `UPDATE questions SET answer = ?, answered_at = ? WHERE id = ? AND answered_at IS NULL`,
  );
  const select = db.prepare('SELECT * FROM questions WHERE id = ?');
  const open = db.prepare(
    'SELECT * FROM questions WHERE answered_at IS NULL ORDER BY asked_at, rowid',
  );
  return {
    ask(runId, agent, question, options = []) {
      const id = randomUUID();
      insert.run(id, runId, agent, question, JSON.stringify(options), now().toISOString());
      return id;
    },
    answer: (id, text) => answer.run(text, now().toISOString(), id).changes === 1,
    get(id) {
      const r = select.get(id) as QuestionRow | undefined;
      return r === undefined ? undefined : toQuestion(r);
    },
    unanswered: () => (open.all() as QuestionRow[]).map(toQuestion),
  };
}

// ── strategy (weekly category weights, §13) ──────────────────────────────────────────────────

export interface StrategyRecord {
  week: number;
  /** Category abbreviation → weight. */
  weights: Record<string, number>;
  rationale: string;
  createdAt: string;
}

export interface StrategyRepo {
  /** Replaces the week's strategy. */
  set(week: number, weights: Record<string, number>, rationale: string): void;
  get(week: number): StrategyRecord | undefined;
}

interface StrategyRow {
  week: number;
  weights_json: string;
  rationale: string;
  created_at: string;
}

const Weights = z.record(z.string(), z.number().finite());

export function strategyRepo(db: Db, now: Clock): StrategyRepo {
  const upsert = db.prepare(
    `INSERT INTO strategy (week, weights_json, rationale, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (week) DO UPDATE SET weights_json = excluded.weights_json,
       rationale = excluded.rationale, created_at = excluded.created_at`,
  );
  const select = db.prepare('SELECT * FROM strategy WHERE week = ?');
  return {
    set(week, weights, rationale) {
      const checked = Weights.parse(weights);
      upsert.run(week, JSON.stringify(checked), rationale, now().toISOString());
    },
    get(week) {
      const r = select.get(week) as StrategyRow | undefined;
      if (r === undefined) return undefined;
      return {
        week: r.week,
        weights: parseJson(Weights, r.weights_json, `strategy[${r.week}].weights_json`),
        rationale: r.rationale,
        createdAt: r.created_at,
      };
    },
  };
}

// ── kv (small runtime flags, e.g. the `fha stop` kill switch) ───────────────────────────────

export interface KvRepo {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
}

export function kvRepo(db: Db, now: Clock): KvRepo {
  const select = db.prepare('SELECT value FROM kv WHERE key = ?');
  const upsert = db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare('DELETE FROM kv WHERE key = ?');
  return {
    get: (key) => (select.get(key) as { value: string } | undefined)?.value,
    set: (key, value) => void upsert.run(key, value, now().toISOString()),
    delete: (key) => remove.run(key).changes === 1,
  };
}
