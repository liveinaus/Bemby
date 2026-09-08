// Emby front-ends that put a gateway in front of the server can refuse a
// self-invented play session, and gate the playback reports on the session's
// stream actually being read. These cover both, and that a plain Emby server
// (which does neither) is unaffected.

const { mockUndiciFetch, MockProxyAgent, MockAgent } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
  MockProxyAgent: vi.fn(),
  MockAgent: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: mockUndiciFetch,
  ProxyAgent: MockProxyAgent,
  Agent: MockAgent,
}));

vi.mock('node:dns', () => ({ lookup: vi.fn() }));

vi.mock('../db/database', () => ({
  db: { prepare: vi.fn().mockReturnValue({ get: vi.fn(), run: vi.fn() }) },
}));

vi.mock('../tg/proxyHealth', () => ({ checkedProxyUrl: vi.fn().mockResolvedValue(undefined) }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEmbywatch } from '../jobs/embywatch';

const BASE = 'https://emby.example.com';
const ITEM_ID = '4321';
const MEDIA_SOURCE_ID = `mediasource_${ITEM_ID}`;
const RUNTIME_TICKS = 100 * 10_000_000; // 100s, so the run needs one progress interval

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; bytes?: number };

function respond(reply: Reply) {
  const status = reply.status;
  const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
  const headers = new Map(Object.entries(reply.headers ?? {}));
  let remaining = reply.bytes ?? 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    text: () => Promise.resolve(text),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: {
      cancel: () => Promise.resolve(),
      getReader: () => ({
        read: () => {
          if (remaining <= 0) return Promise.resolve({ done: true, value: undefined });
          const value = { byteLength: remaining };
          remaining = 0;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => Promise.resolve(),
      }),
    },
  };
}

/**
 * A stand-in Emby. `issuePlaySessionId` models a front-end that mints session
 * ids and refuses any other; `leaseGated` models one that only accepts a report
 * while the session's stream is being read.
 */
function fakeEmby(opts: { issuePlaySessionId?: boolean; leaseGated?: boolean } = {}) {
  const state = {
    issued: [] as string[],
    reports: [] as { path: string; playSessionId?: string }[],
    playbackInfoCalls: 0,
    streamReads: 0,
    leaseRevivals: 0,
  };
  let leaseActive = false;
  let counter = 0;

  const handler = (rawUrl: string, init: any = {}) => {
    const url = new URL(rawUrl);
    const path = url.pathname;
    const body = init.body ? JSON.parse(init.body) : {};

    if (path === '/Users/AuthenticateByName') {
      return respond({ status: 200, body: { AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } } });
    }

    if (path === '/Users/u1/Items') {
      return respond({
        status: 200,
        body: {
          Items: [{
            Id: ITEM_ID,
            Name: 'An Episode',
            Type: 'Episode',
            RunTimeTicks: RUNTIME_TICKS,
            MediaSources: [{ Id: MEDIA_SOURCE_ID, Size: 1_000_000 }],
          }],
        },
      });
    }

    if (path === `/Items/${ITEM_ID}/PlaybackInfo`) {
      state.playbackInfoCalls++;
      const playSessionId = `server-session-${++counter}`;
      if (opts.issuePlaySessionId) state.issued.push(playSessionId);
      return respond({
        status: 200,
        body: {
          ...(opts.issuePlaySessionId ? { PlaySessionId: playSessionId } : {}),
          MediaSources: [{
            Id: MEDIA_SOURCE_ID,
            Size: 1_000_000,
            DirectStreamUrl: `/videos/${ITEM_ID}/original.mkv?MediaSourceId=${MEDIA_SOURCE_ID}`
              + `&api_key=tok${opts.issuePlaySessionId ? `&PlaySessionId=${playSessionId}` : ''}`,
          }],
        },
      });
    }

    if (path.startsWith('/Sessions/Playing')) {
      const playSessionId: string | undefined = body.PlaySessionId ?? url.searchParams.get('PlaySessionId') ?? undefined;
      // A minted-id front-end refuses anything it did not issue
      if (opts.issuePlaySessionId && (!playSessionId || !state.issued.includes(playSessionId))) {
        return respond({ status: 400, body: { ErrorCode: 'invalid_request', Message: 'The request is invalid.' } });
      }
      if (opts.leaseGated && path !== '/Sessions/Playing' && !leaseActive) {
        return respond({
          status: 409,
          body: { ErrorCode: 'playback_lease_inactive', Message: 'The playback session is no longer active.' },
        });
      }
      leaseActive = false; // the lease lapses again until more bytes are read
      state.reports.push({ path, playSessionId });
      return respond({ status: 204 });
    }

    // Anything else is a stream read
    state.streamReads++;
    const range = init.headers?.Range ?? '';
    if (range === 'bytes=0-0') state.leaseRevivals++;
    leaseActive = true;
    // A static /Videos/{id}/stream route the gateway does not serve
    if (path.startsWith('/Videos/')) return respond({ status: 404 });
    return respond({
      status: 206,
      headers: { 'content-range': 'bytes 0-65535/1000000' },
      bytes: 65_536,
    });
  };

  return { state, handler };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUndiciFetch.mockReset();
});

const config = { username: 'user', password: 'pass', playDuration: 1, markWatched: false };

describe('runEmbywatch play sessions', () => {
  it('reports playback under the play session the server issued', async () => {
    const { state, handler } = fakeEmby({ issuePlaySessionId: true });
    mockUndiciFetch.mockImplementation(handler as any);

    const log = await runEmbywatch(BASE, config);

    expect(log.title).toBe('An Episode');
    const start = state.reports.find(r => r.path === '/Sessions/Playing');
    expect(start).toBeDefined();
    // The id must be one the server minted, not a locally generated one
    expect(state.issued).toContain(start?.playSessionId);
    for (const report of state.reports) expect(report.playSessionId).toBe(start?.playSessionId);
  });

  it('keeps its own play session when the server issues none', async () => {
    const { state, handler } = fakeEmby({ issuePlaySessionId: false });
    mockUndiciFetch.mockImplementation(handler as any);

    await runEmbywatch(BASE, config);

    const start = state.reports.find(r => r.path === '/Sessions/Playing');
    expect(start?.playSessionId).toMatch(/^bemby-\d+$/);
  });

  it('revives a lapsed playback lease with a ranged read, without Real Watch', async () => {
    const { state, handler } = fakeEmby({ issuePlaySessionId: true, leaseGated: true });
    mockUndiciFetch.mockImplementation(handler as any);

    const log = await runEmbywatch(BASE, { ...config, realWatch: false });

    expect(log.watchedSeconds).toBeGreaterThan(0);
    expect(state.leaseRevivals).toBeGreaterThan(0);
    // The lease-gated progress report went through rather than failing the run
    expect(state.reports.some(r => r.path === '/Sessions/Playing/Progress')).toBe(true);
    expect(state.reports.some(r => r.path === '/Sessions/Playing/Stopped')).toBe(true);
    // Real Watch stayed off, so no playback-paced streaming was reported
    expect(log.streamedBytes).toBeUndefined();
  });

  it('asks PlaybackInfo once per stream resolution rather than once per candidate URL', async () => {
    const { state, handler } = fakeEmby({ issuePlaySessionId: true });
    mockUndiciFetch.mockImplementation(handler as any);

    await runEmbywatch(BASE, { ...config, realWatch: true });

    // One for the playability probe, one to open the session the run reports under
    expect(state.playbackInfoCalls).toBe(2);
  });
});
