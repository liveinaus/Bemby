// A "one time job" switches itself off the first time a run succeeds. Both the
// scheduler and a manual run go through recordJobSuccess, so this covers both.

let testDb!: InstanceType<typeof Database>;

vi.mock('../db/database', () => ({ get db() { return testDb; } }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { recordJobSuccess } from '../jobs/jobSuccess';
import type { Job } from '../types';

const SCHEMA = `
  CREATE TABLE jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL DEFAULT 'Job',
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_success_at TEXT,
    one_time        INTEGER NOT NULL DEFAULT 0
  );
`;

function makeJob(oneTime: boolean): Job {
  const id = Number(
    testDb
      .prepare("INSERT INTO jobs (name, one_time) VALUES ('Job', ?)")
      .run(oneTime ? 1 : 0).lastInsertRowid,
  );
  return { id, name: 'Job', oneTime } as Job;
}

function readJob(id: number) {
  return testDb.prepare('SELECT enabled, last_success_at FROM jobs WHERE id = ?').get(id) as {
    enabled: number;
    last_success_at: string | null;
  };
}

describe('recordJobSuccess', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(SCHEMA);
  });

  it('stamps the success and leaves an ordinary job running', () => {
    const job = makeJob(false);
    const disabled = recordJobSuccess(job, '2024-06-15T10:00:00.000Z');
    expect(disabled).toBe(false);
    expect(readJob(job.id)).toEqual({ enabled: 1, last_success_at: '2024-06-15T10:00:00.000Z' });
  });

  it('switches a one-time job off once it succeeds', () => {
    const job = makeJob(true);
    const disabled = recordJobSuccess(job, '2024-06-15T10:00:00.000Z');
    expect(disabled).toBe(true);
    expect(readJob(job.id)).toEqual({ enabled: 0, last_success_at: '2024-06-15T10:00:00.000Z' });
  });

  it('reports no change when a one-time job is already off', () => {
    const job = makeJob(true);
    testDb.prepare('UPDATE jobs SET enabled = 0 WHERE id = ?').run(job.id);
    expect(recordJobSuccess(job, '2024-06-15T10:00:00.000Z')).toBe(false);
  });

  it('never rewinds the stamp when a slow run lands after a later one', () => {
    const job = makeJob(false);
    recordJobSuccess(job, '2024-06-15T12:00:00.000Z');
    recordJobSuccess(job, '2024-06-15T10:00:00.000Z');
    expect(readJob(job.id).last_success_at).toBe('2024-06-15T12:00:00.000Z');
  });
});
