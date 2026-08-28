// Verify that embywatch uses the IPv4-only undici agent (no proxy) vs ProxyAgent (proxy set).
// The IPv4 agent guards against Happy Eyeballs wasting the connect timeout on broken
// IPv6 routes in container environments.

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
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn(),
    }),
  },
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../db/database';
import { runEmbywatch } from '../jobs/embywatch';

const baseConfig = { username: 'user', password: 'pass', playDuration: 1 };

// Key-aware settings mock: returns a row only for the given keys, so e.g. the
// proxies JSON is never misread as a device-name template. `run` covers the
// device-name persistence path.
function mockSettings(settings: Record<string, string> = {}) {
  vi.mocked(db.prepare).mockReturnValue({
    get: vi.fn((key: string) => (key in settings ? { value: settings[key] } : undefined)),
    run: vi.fn(),
  } as any);
}

// Each test only needs to verify which dispatcher is used on the first request (auth).
// We let it fail after that -- no need to simulate full playback.

beforeEach(() => {
  vi.clearAllMocks();
  mockSettings();
  mockUndiciFetch.mockRejectedValue(
    Object.assign(new Error('net'), { cause: { code: 'ECONNREFUSED' } }),
  );
});

describe('embywatch fetch routing', () => {
  it('uses the IPv4 agent (not ProxyAgent) when no proxy is configured', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server');

    expect(mockUndiciFetch).toHaveBeenCalled();
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    // Should be the ipv4Agent instance (MockAgent), not a ProxyAgent
    expect(MockProxyAgent).not.toHaveBeenCalled();
    expect(dispatcher).toBeInstanceOf(MockAgent);
  });

  it('uses ProxyAgent when a proxy URL is resolved', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'p1', name: 'My Proxy', url: 'http://proxy.local:3128' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'p1' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).toHaveBeenCalledWith('http://proxy.local:3128');
    const dispatcher = (mockUndiciFetch.mock.calls[0][1] as any)?.dispatcher;
    expect(dispatcher).toBeInstanceOf(MockProxyAgent);
  });

  it('falls back to IPv4 agent when proxyId does not match any stored proxy', async () => {
    mockSettings({
      proxies: JSON.stringify([{ id: 'other', url: 'http://x' }]),
    });

    await expect(runEmbywatch('https://emby.example.com', { ...baseConfig, proxyId: 'missing' }))
      .rejects.toThrow('Cannot reach Emby server');

    expect(MockProxyAgent).not.toHaveBeenCalled();
  });

  it('wraps network errors with the full request URL and cause', async () => {
    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Cannot reach Emby server at https://emby.example.com/Users/AuthenticateByName — ECONNREFUSED');
  });

  it('sanitises whitespace in DeviceId but keeps the display device name', async () => {
    mockSettings({ default_device_name: 'Macbook Pro' });

    await expect(runEmbywatch('https://emby.example.com', baseConfig)).rejects.toThrow();

    const headers = (mockUndiciFetch.mock.calls[0][1] as any)?.headers;
    expect(headers['X-Emby-Authorization']).toContain('DeviceId="Macbook-Pro"');
    expect(headers['X-Emby-Authorization']).toContain('Device="Macbook Pro"');
  });

  it('surfaces HTTP error status and Emby JSON message on non-2xx response', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue(JSON.stringify({ Message: 'Invalid credentials' })),
    });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('Invalid credentials');
  });
});

// A one-chunk ReadableStream reader, as the probe path consumes responses via
// getReader rather than buffering them. `bytes` of 0 models an unreadable file.
function streamOf(bytes: number) {
  let sent = false;
  return {
    read: vi.fn(() => {
      if (sent || bytes === 0) return Promise.resolve({ done: true, value: undefined });
      sent = true;
      return Promise.resolve({ done: false, value: new Uint8Array(bytes) });
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
}

// Routes mock responses by request URL so we can simulate auth + item pick +
// stream probe independently.
function routeFetch(
  streamStatus: number,
  opts: {
    directStreamUrl?: string;
    directStatus?: number;
    stoppedStatus?: number;
    playingStatus?: number;
    playingMessage?: string;
    /** An item query that comes back empty, as it does for a user who can see no library. */
    noItems?: boolean;
  } = {},
) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const probeRes = (status: number) => ({
    status,
    body: { cancel: vi.fn(), getReader: () => streamOf(status === 200 || status === 206 ? 1024 : 0) },
  });
  let stoppedFailed = false;
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/PlaybackInfo')) {
      return Promise.resolve(jsonRes({
        MediaSources: [{ Id: 's1', DirectStreamUrl: opts.directStreamUrl }],
      }));
    }
    // DirectStreamUrl probe (the /videos/{id}/original.{container} form)
    if (url.includes('/original.')) {
      return Promise.resolve(probeRes(opts.directStatus ?? 404));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      return Promise.resolve(probeRes(streamStatus));
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: opts.noItems
          ? []
          : [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }],
      }));
    }
    // Fails only the pre-flight Stopped (the first one), leaving the end-of-segment
    // report to succeed as a real server's would.
    if (opts.stoppedStatus && url.endsWith('/Sessions/Playing/Stopped') && !stoppedFailed) {
      stoppedFailed = true;
      return Promise.resolve({
        ok: false,
        status: opts.stoppedStatus,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue(''),
      });
    }
    if (opts.playingStatus && url.endsWith('/Sessions/Playing')) {
      return Promise.resolve({
        ok: false,
        status: opts.playingStatus,
        statusText: 'Internal Server Error',
        text: vi.fn().mockResolvedValue(JSON.stringify({ Message: opts.playingMessage ?? 'start refused' })),
      });
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch playability verification', () => {
  it('skips reporting when the media is offline (stream probe fails)', async () => {
    routeFetch(404);

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');

    // No playback should have been reported.
    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Sessions/Playing'),
    );
    expect(reported).toBe(false);
  });

  it('names the status the stream refused with, so a 403 is not read as a dead disk', async () => {
    routeFetch(403);

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('"Ep" → HTTP 403');
  });

  it('says so when the server returns no items at all, which is not an offline file', async () => {
    routeFetch(206, { noItems: true });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('the server returned no items for this user');
  });

  it('sends the token as a header on the stream probe as well as in the url', async () => {
    routeFetch(206);
    await runEmbywatch('https://emby.example.com', baseConfig);

    const probe = mockUndiciFetch.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('/Videos/') && c[0].includes('/stream'),
    );
    expect((probe?.[1] as any)?.headers['X-Emby-Authorization']).toContain('Token="tok"');
  });

  it('reports playback when the stream probe succeeds', async () => {
    routeFetch(206);

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    const reported = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing'),
    );
    expect(reported).toBe(true);
  });

  it('accepts an item when the static probe fails but the PlaybackInfo DirectStreamUrl works', async () => {
    // Mirrors proxies that only route the DirectStreamUrl form and reject /stream
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 206 });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');

    // The DirectStreamUrl succeeded, so the static /stream fallback is never probed
    const staticProbed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream?'),
    );
    expect(staticProbed).toBe(false);
  });

  it('skips reporting when both the DirectStreamUrl and static probes fail', async () => {
    routeFetch(500, { directStreamUrl: '/videos/i1/original.mkv?api_key=tok', directStatus: 500 });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('No streamable items found');
  });

  it('plays through a proxy that only accepts the /Videos/ path and a capitalised MediaSourceId', async () => {
    // A reverse proxy in front of Emby matched the path and query key exactly: the lowercase
    // /videos/ form PlaybackInfo advertises answered 404, and mediaSourceId answered 400.
    const accepted: string[] = [];
    mockUndiciFetch.mockImplementation((url: string) => {
      const json = (body: unknown) => Promise.resolve({
        ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      });
      if (url.includes('/Users/AuthenticateByName')) {
        return json({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } });
      }
      if (url.includes('/PlaybackInfo')) {
        return json({ MediaSources: [{ Id: 's1', DirectStreamUrl: '/videos/i1/stream?MediaSourceId=s1&api_key=tok' }] });
      }
      if (url.includes('/Items')) {
        return json({ Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }] });
      }
      if (url.includes('/stream')) {
        const ok = url.includes('/Videos/') && url.includes('MediaSourceId=');
        if (ok) accepted.push(url);
        return Promise.resolve({
          status: ok ? 206 : url.includes('/Videos/') ? 400 : 404,
          body: { cancel: vi.fn(), getReader: () => streamOf(ok ? 1024 : 0) },
        });
      }
      return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
    });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('stops reading after the first chunk when the server ignores Range and returns the whole file', async () => {
    // A proxy fronting Emby may answer 200 with the entire movie instead of a 206
    // range. Buffering that would pull the whole file into memory and OOM the process,
    // so the probe must take one chunk and cancel.
    const reader = {
      read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(65_536) }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    mockUndiciFetch.mockImplementation((url: string) => {
      if (url.includes('/Users/AuthenticateByName')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } })) });
      }
      if (url.includes('/PlaybackInfo')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ MediaSources: [{ Id: 's1' }] })) });
      }
      if (url.includes('/Videos/') && url.includes('/stream')) {
        // 200 rather than 206: Range ignored, body is the entire file
        return Promise.resolve({ status: 200, body: { cancel: vi.fn(), getReader: () => reader } });
      }
      if (url.includes('/Items')) {
        return Promise.resolve({ ok: true, status: 200, statusText: 'OK', text: vi.fn().mockResolvedValue(JSON.stringify({ Items: [{ Id: 'i1', Name: 'Ep', Type: 'Episode', RunTimeTicks: 6000_000_000, MediaSources: [{ Id: 's1' }] }] })) });
      }
      return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
    });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');
    // The endless body was read once and abandoned, never drained.
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.cancel).toHaveBeenCalled();
  });

  it('does not probe the stream when verifyPlayable is false', async () => {
    routeFetch(404);

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.title).toBe('Ep');

    const probed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(probed).toBe(false);
  });
});

/**
 * Serves auth, item pick, a 1-byte size probe and ranged data reads (via a
 * getReader stream) so Real Watch can pull and count real bytes. The options
 * cover the shapes proxied servers return: no size header, no direct play,
 * transcode-only, HLS, and stream URLs that reject every read.
 */
function routeRealWatch(
  opts: {
    /** Total size the probe advertises; null serves no Content-Range at all. */
    size?: number | null;
    /** MediaSources[0] on the picked item; null strips it entirely. */
    source?: any;
    /** Status for the static /Videos/{id}/stream route. */
    staticStatus?: number;
    directStreamUrl?: string;
    transcodingUrl?: string;
    /** URL fragment → m3u8 body, for the HLS transcode path. */
    playlists?: Record<string, string>;
    /** Status for data (non-probe) reads on non-static media URLs. */
    dataStatus?: number;
    /** 416 any read that starts past byte 0, as a short file would. */
    rejectOffsets?: boolean;
  } = {},
) {
  const size = opts.size === undefined ? 60_000_000 : opts.size;
  const source = opts.source === undefined ? { Id: 's1', Size: 60_000_000, Bitrate: 800_000 } : opts.source;
  const staticStatus = opts.staticStatus ?? 206;
  const dataStatus = opts.dataStatus ?? 206;

  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  const textRes = (body: string) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: { cancel: vi.fn() },
    text: vi.fn().mockResolvedValue(body),
  });
  const probeRes = (status: number) => ({
    status,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === 'content-range' && size != null ? `bytes 0-0/${size}` : null,
    },
    body: { cancel: vi.fn() },
  });
  const dataRes = (status: number) => {
    let read = 0;
    const reader = {
      read: vi.fn(() =>
        read++ === 0
          ? Promise.resolve({ done: false, value: new Uint8Array(4096) })
          : Promise.resolve({ done: true, value: undefined }),
      ),
      cancel: vi.fn(),
    };
    return { status, headers: { get: () => null }, body: { getReader: () => reader, cancel: vi.fn() } };
  };
  const isProbe = (init: any) => (init?.headers?.Range ?? '') === 'bytes=0-0';
  const offsetRejected = (init: any) =>
    opts.rejectOffsets === true && !/^bytes=0-/.test(init?.headers?.Range ?? '');

  mockUndiciFetch.mockImplementation((url: string, init: any) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/PlaybackInfo')) {
      return Promise.resolve(jsonRes({
        MediaSources: [{ Id: 's1', DirectStreamUrl: opts.directStreamUrl, TranscodingUrl: opts.transcodingUrl }],
      }));
    }
    for (const [fragment, body] of Object.entries(opts.playlists ?? {})) {
      if (url.includes(fragment)) return Promise.resolve(textRes(body));
    }
    if (url.includes('/Videos/') && url.includes('/stream')) {
      if (isProbe(init)) return Promise.resolve(probeRes(staticStatus));
      if (offsetRejected(init)) return Promise.resolve(dataRes(416));
      return Promise.resolve(dataRes(opts.dataStatus ?? staticStatus));
    }
    if (url.includes('/videos/') || url.endsWith('.ts')) {
      return Promise.resolve(isProbe(init) ? probeRes(200) : dataRes(dataStatus));
    }
    if (url.includes('/Items')) {
      return Promise.resolve(jsonRes({
        Items: [{
          Id: 'i1',
          Name: 'Ep',
          Type: 'Episode',
          RunTimeTicks: 6000_000_000,
          MediaSources: source ? [source] : [],
        }],
      }));
    }
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

const realWatchConfig = { ...baseConfig, realWatch: true, verifyPlayable: false };

// Data reads carrying a Range that isn't the 1-byte size probe.
function dataReads() {
  return mockUndiciFetch.mock.calls.filter(
    c =>
      typeof c[0] === 'string' &&
      (c[1] as any)?.headers?.Range &&
      !(c[1] as any).headers.Range.includes('0-0'),
  );
}

describe('embywatch Real Watch', () => {
  it('streams actual media bytes with a position-following Range request', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();

    // A ranged data read (not the 1-byte size probe) hit the static stream URL,
    // carrying the play session so the transfer ties to the reported session.
    const dataFetch = dataReads().find(
      c => (c[0] as string).includes('/stream') && (c[0] as string).includes('PlaySessionId='),
    );
    expect(dataFetch).toBeTruthy();
    // Size known, so the range is bounded at both ends
    expect((dataFetch![1] as any).headers.Range).toMatch(/^bytes=\d+-\d+$/);
  });

  it('does not stream bytes when Real Watch is off', async () => {
    routeRealWatch();

    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false });
    expect(result.streamedBytes).toBeUndefined();

    const streamed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/stream'),
    );
    expect(streamed).toBe(false);
  });

  it('streams open-ended when the server exposes no size or bitrate', async () => {
    // Proxied servers often answer without Content-Range and strip Size/Bitrate
    routeRealWatch({ size: null, source: { Id: 's1' } });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();

    const dataFetch = dataReads()[0];
    expect((dataFetch[1] as any).headers.Range).toMatch(/^bytes=\d+-$/);
  });

  it('falls back to the transcode stream when no direct play is offered', async () => {
    routeRealWatch({
      size: null,
      staticStatus: 404,
      source: { Id: 's1' },
      transcodingUrl: '/videos/i1/stream.mkv?api_key=tok',
    });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchTranscoded).toBe(true);
    expect(dataReads().some(c => (c[0] as string).includes('stream.mkv'))).toBe(true);
  });

  it('drains HLS segments when the transcode stream is a playlist', async () => {
    routeRealWatch({
      size: null,
      staticStatus: 404,
      source: { Id: 's1' },
      transcodingUrl: '/videos/i1/master.m3u8?api_key=tok',
      playlists: {
        'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nmain.m3u8?api_key=tok\n',
        'main.m3u8': '#EXTM3U\n#EXTINF:6.0,\nhls1/main/0.ts\n#EXTINF:6.0,\nhls1/main/1.ts\n',
      },
    });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchTranscoded).toBe(true);
    expect(mockUndiciFetch.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes('hls1/main/0.ts'))).toBe(true);
  });

  it('retries from the start when an estimated offset lands past the end of the file', async () => {
    routeRealWatch({ size: null, source: { Id: 's1' }, rejectOffsets: true });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBeGreaterThan(0);
    expect(result.realWatchNote).toBeUndefined();
    expect(dataReads().some(c => (c[1] as any).headers.Range === 'bytes=0-')).toBe(true);
  });

  it('records why nothing streamed when the server serves no stream at all', async () => {
    routeRealWatch({ staticStatus: 404, source: { Id: 's1' } });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBe(0);
    expect(result.realWatchNote).toBe('no-stream-url');
  });

  it('records a stream failure when the resolved URL rejects every read', async () => {
    // The size probe succeeds, then the server 403s the actual data reads
    routeRealWatch({ dataStatus: 403 });

    const result = await runEmbywatch('https://emby.example.com', realWatchConfig);
    expect(result.streamedBytes).toBe(0);
    expect(result.realWatchNote).toBe('stream-failed');
  });
});

// Configurable Sequence Play backend: a resume list, a series episode list, and
// generic session endpoints. Runtimes are short so segments finish in one tick.
function routeSequence(opts: {
  resume?: any[];
  nextUp?: any[];
  episodes?: any[];
} = {}) {
  const jsonRes = (body: unknown) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  });
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.resume ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: opts.nextUp ?? [] }));
    if (url.includes('/Episodes')) return Promise.resolve(jsonRes({ Items: opts.episodes ?? [] }));
    if (url.includes('/Items?SortBy=Random')) {
      return Promise.resolve(jsonRes({ Items: [{ Id: 'rand', Name: 'Random', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] }));
    }
    // Playing / Progress / Stopped / PlayedItems
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

const ep = (id: string, index: number, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `Ep ${index}`,
  Type: 'Episode',
  SeriesId: 'series1',
  SeriesName: 'Show',
  IndexNumber: index,
  RunTimeTicks: 10_000_000, // 1s runtime so a segment finishes in one tick
  MediaSources: [{ Id: `${id}-s` }],
  ...extra,
});

describe('embywatch Sequence Play', () => {
  const seqConfig = { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 5 };

  it('resumes from the last position and chains to the next episode', async () => {
    // e1 resumes near its end; episode list lets it advance to e2, then e3.
    routeSequence({
      resume: [ep('e1', 1, { UserData: { PlaybackPositionTicks: 0 } })],
      episodes: [ep('e1', 1), ep('e2', 2), ep('e3', 3)],
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);

    expect(result.sequencePlay).toBe(true);
    // playDuration 5s over 1s episodes: e1, e2, e3 all finish (series ends at e3)
    expect(result.episodesCompleted).toBe(3);

    // Every played episode is recalled, in order, with its own watch window.
    expect(result.episodes?.map(e => e.title)).toEqual(['Ep 1', 'Ep 2', 'Ep 3']);
    expect(result.episodes?.every(e => e.watchedSeconds === 1)).toBe(true);
    expect(result.episodes?.every(e => e.markedWatched)).toBe(true);
    const total = result.episodes!.reduce((s, e) => s + e.watchedSeconds, 0);
    expect(result.watchedSeconds).toBe(total);

    const marked = mockUndiciFetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].includes('/PlayedItems/'),
    );
    // Each finished episode is marked watched
    expect(marked.length).toBe(result.episodesCompleted);

    const resumed = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items/Resume'),
    );
    expect(resumed).toBe(true);
  });

  it('falls back to Next Up when nothing is resuming', async () => {
    routeSequence({
      resume: [],
      nextUp: [ep('n1', 4)],
      episodes: [ep('n1', 4)], // last in series, no chaining
    });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Ep 4');
    expect(result.episodesCompleted).toBe(1);

    const usedNextUp = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Shows/NextUp'),
    );
    expect(usedNextUp).toBe(true);
  });

  it('falls back to a random item when nothing is resuming or up next', async () => {
    routeSequence({ resume: [], nextUp: [] });

    const result = await runEmbywatch('https://emby.example.com', seqConfig);
    expect(result.title).toBe('Random');

    const usedRandom = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].includes('/Items?SortBy=Random'),
    );
    expect(usedRandom).toBe(true);
  });
});

// Model an Emby server behind optional ID-aliasing. ParentId is honoured only for
// browsing a library's Series/Movies (SortBy=Random). The global Resume/NextUp and
// whole-server random are unscoped. Library membership is derived primarily from the
// item's Ancestors chain (real Emby returns the CollectionFolder view id there); when
// Ancestors is unavailable (aliasing proxy → 404) it falls back to the series'
// ParentId. Distinguishes the query shapes the code issues.
const jsonRes = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: vi.fn().mockResolvedValue(JSON.stringify(body)),
});
function routeProxy(opts: {
  views: any[];
  librarySample?: any[]; // Items?ParentId&IncludeItemTypes=Series,Movie&SortBy=Random
  episodes?: Record<string, any[]>; // /Shows/{seriesId}/Episodes
  wholeResume?: any[]; // /Items/Resume (unscoped global Continue Watching)
  ancestors?: Record<string, string[]>; // itemId -> ancestor ids (real Emby membership signal)
  seriesParent?: Record<string, string>; // seriesId -> library id (aliasing-proxy fallback)
  wholeRandom?: any[]; // /Items?SortBy=Random&IncludeItemTypes=Episode,Movie (unscoped)
  offlineIds?: string[]; // ids whose stream probe fails
}) {
  mockUndiciFetch.mockImplementation((url: string) => {
    if (url.includes('/Users/AuthenticateByName')) {
      return Promise.resolve(jsonRes({ AccessToken: 'tok', User: { Id: 'u1', Name: 'Tester' } }));
    }
    if (url.includes('/Views')) return Promise.resolve(jsonRes({ Items: opts.views }));
    if (url.includes('/PlaybackInfo')) return Promise.resolve(jsonRes({ MediaSources: [{ Id: 's' }] }));
    const vid = url.match(/\/Videos\/([^/]+)\/stream/);
    if (vid) {
      const bad = (opts.offlineIds ?? []).includes(vid[1]);
      return Promise.resolve({ status: bad ? 404 : 206, body: { cancel: vi.fn(), getReader: () => streamOf(bad ? 0 : 1024) } });
    }
    // Ancestors chain: /Items/{id}/Ancestors — real Emby's membership signal.
    // Return the configured chain, or 404 (like an aliasing proxy) so the code
    // falls back to the series ParentId signal.
    const anc = url.match(/\/Items\/([^/?]+)\/Ancestors/);
    if (anc) {
      const chain = opts.ancestors?.[anc[1]];
      if (!chain) return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: vi.fn().mockResolvedValue('') });
      return Promise.resolve(jsonRes(chain.map(id => ({ Id: id }))));
    }
    // Series ParentId lookup: /Users/u1/Items/{seriesId}?Fields=ParentId
    const sl = url.match(/\/Items\/([^/?]+)\?Fields=ParentId/);
    if (sl && sl[1] !== 'Resume') {
      return Promise.resolve(jsonRes({ Id: sl[1], Type: 'Series', ParentId: opts.seriesParent?.[sl[1]] }));
    }
    if (url.includes('/Items/Resume')) return Promise.resolve(jsonRes({ Items: opts.wholeResume ?? [] }));
    if (url.includes('IncludeItemTypes=Series,Movie')) return Promise.resolve(jsonRes({ Items: opts.librarySample ?? [] }));
    const eps = url.match(/\/Shows\/([^/]+)\/Episodes/);
    if (eps) return Promise.resolve(jsonRes({ Items: opts.episodes?.[eps[1]] ?? [] }));
    if (url.includes('/Shows/NextUp')) return Promise.resolve(jsonRes({ Items: [] }));
    if (url.includes('SortBy=Random')) return Promise.resolve(jsonRes({ Items: opts.wholeRandom ?? [] }));
    return Promise.resolve({ ok: true, status: 204, statusText: 'No Content', text: vi.fn().mockResolvedValue('') });
  });
}

describe('embywatch library scoping', () => {
  const views = [{ Id: 'lib-movies', Name: 'Movies' }, { Id: 'lib-tv', Name: 'TV Shows' }];
  const series = (id: string, name: string) => ({ Id: id, Name: name, Type: 'Series', MediaSources: [{ Id: `${id}-s` }] });
  const urls = () => mockUndiciFetch.mock.calls.map(c => c[0] as string).filter(u => typeof u === 'string');

  it('scopes the random pick to the library by name, via a bounded Series/Movie browse', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'tv shows' });
    expect(result.title).toBe('Ep 1');
    const browse = urls().find(u => u.includes('IncludeItemTypes=Series,Movie'));
    expect(browse).toContain('ParentId=lib-tv');
    // Bounded: no full enumeration (small Limit, no paging).
    expect(browse).toContain('Limit=12');
    expect(urls().some(u => /Limit=(?:[5-9]\d\d|\d{4,})/.test(u) || u.includes('StartIndex='))).toBe(false);
  });

  it('scopes to a library by its 1-based index', async () => {
    routeProxy({ views, librarySample: [series('sA', 'InLibShow')], episodes: { sA: [ep('e1', 1)] } });
    await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: '1' });
    expect(urls().find(u => u.includes('IncludeItemTypes=Series,Movie'))).toContain('ParentId=lib-movies');
  });

  it('ignores an unknown library and uses the whole server', async () => {
    routeProxy({ views, wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }] });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: false, playDuration: 1, library: 'Nope' });
    expect(result.title).toBe('Whole');
    // No library browse happened.
    expect(urls().some(u => u.includes('IncludeItemTypes=Series,Movie'))).toBe(false);
  });

  it('resumes the in-library Continue Watching item (Ancestors signal) and chains the next episode', async () => {
    // Real-Emby shape: the library view sits above physical folders, so membership
    // comes from the Ancestors chain, not the series ParentId. Global Continue
    // Watching holds an out-of-library drama and an in-library anime; Sequence Play
    // must resume the anime, then keep playing the next episode in the same show.
    const drama = { Id: 'drama', Name: 'E29', SeriesName: 'Drama', Type: 'Episode', SeriesId: 'sDrama', RunTimeTicks: 600_000_000, UserData: { PlaybackPositionTicks: 100_000_000 }, MediaSources: [{ Id: 'd-s' }] };
    // Short runtimes keep the real-timed watch fast: Ep 5 resumes near its end
    // (1s left), then Ep 6 (1s) plays and completes.
    const anime = { Id: 'anime5', Name: 'Ep 5', SeriesName: 'Anime', Type: 'Episode', SeriesId: 'sAnime', IndexNumber: 5, RunTimeTicks: 20_000_000, UserData: { PlaybackPositionTicks: 10_000_000 }, MediaSources: [{ Id: 'a-s' }] };
    const anime6 = { Id: 'anime6', Name: 'Ep 6', SeriesName: 'Anime', Type: 'Episode', SeriesId: 'sAnime', IndexNumber: 6, RunTimeTicks: 10_000_000, MediaSources: [{ Id: 'a6-s' }] };
    routeProxy({
      views,
      wholeResume: [drama, anime], // drama first, but it is out-of-library
      // Real Emby: physical parent chain differs from the view id; Ancestors carries it.
      ancestors: { drama: ['folderD', 'lib-movies', 'root'], anime5: ['folderA', 'lib-tv', 'root'] },
      episodes: { sAnime: [anime, anime6] },
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 5, library: 'TV Shows' });

    expect(result.sequencePlay).toBe(true);
    expect(result.episodes?.[0].title).toBe('Ep 5'); // resumed the in-library anime
    expect(result.episodes?.[0].startSeconds).toBe(1); // from its stored position (1s)
    expect(result.episodes?.[1].title).toBe('Ep 6'); // sequence play chained the next episode
    expect((result.episodes ?? []).some(e => e.title === 'E29')).toBe(false); // never the drama
    // No random library browse was needed since resume succeeded.
    expect(urls().some(u => u.includes('IncludeItemTypes=Series,Movie'))).toBe(false);
  });

  it('starts a random in-library title when nothing in the library is resuming', async () => {
    // Only out-of-library resume exists → skip it, start a random in-library show.
    const drama = { Id: 'drama', Name: 'E29', Type: 'Episode', SeriesId: 'sDrama', RunTimeTicks: 600_000_000, UserData: { PlaybackPositionTicks: 100_000_000 }, MediaSources: [{ Id: 'd-s' }] };
    routeProxy({
      views,
      wholeResume: [drama],
      seriesParent: { sDrama: 'lib-movies' },
      librarySample: [series('sA', 'InLibShow')],
      episodes: { sA: [ep('e1', 1)] },
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 1, library: 'TV Shows' });
    expect(result.episodes?.[0].title).toBe('Ep 1'); // in-library random start
    expect((result.episodes ?? []).some(e => e.title === 'E29')).toBe(false);
  });

  it('falls back to the whole server when the library has nothing to play', async () => {
    routeProxy({
      views,
      wholeResume: [],
      librarySample: [], // empty library
      wholeRandom: [{ Id: 'w1', Name: 'Whole', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 's' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, sequencePlay: true, verifyPlayable: false, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('Whole');
  });

  it('falls back to the whole server when the library item is offline', async () => {
    routeProxy({
      views,
      librarySample: [series('sA', 'InLibShow')],
      // The stream probe keys on item id in /Videos/{id}/stream, so mark by item id.
      episodes: { sA: [{ ...ep('e1', 1), Id: 'offline', MediaSources: [{ Id: 'offline-s' }] }] },
      offlineIds: ['offline'],
      wholeRandom: [{ Id: 'good', Name: 'GoodOnServer', Type: 'Movie', RunTimeTicks: 20_000_000, MediaSources: [{ Id: 'good' }] }],
    });
    const result = await runEmbywatch('https://emby.example.com', { ...baseConfig, verifyPlayable: true, playDuration: 1, library: 'TV Shows' });
    expect(result.title).toBe('GoodOnServer');
  });
});

/** Parsed bodies of every /Sessions/Playing/Stopped report, in call order. */
function stoppedBodies(): any[] {
  return mockUndiciFetch.mock.calls
    .filter(c => typeof c[0] === 'string' && (c[0] as string).endsWith('/Sessions/Playing/Stopped'))
    .map(c => JSON.parse((c[1] as any).body));
}

describe('embywatch session cleanup', () => {
  it('clears a stale session with Stopped before reporting playback', async () => {
    routeFetch(206);

    await runEmbywatch('https://emby.example.com', baseConfig);

    const urls = mockUndiciFetch.mock.calls
      .map(c => (typeof c[0] === 'string' ? c[0] : ''))
      .filter(u => u.includes('/Sessions/Playing'));
    expect(urls[0]).toMatch(/\/Sessions\/Playing\/Stopped$/);
    expect(urls[1]).toMatch(/\/Sessions\/Playing$/);
  });

  it('reports playback even when clearing the stale session fails', async () => {
    routeFetch(206, { stoppedStatus: 500 });

    const result = await runEmbywatch('https://emby.example.com', baseConfig);
    expect(result.title).toBe('Ep');
  });

  // Servers that key a session on (user, device, item) only honour a Stopped
  // report that names no play session, so the pre-flight clear must omit it --
  // otherwise the stale row survives and holds one of the account's stream slots.
  it('omits PlaySessionId on the pre-flight clear and sends it on the real stop', async () => {
    routeFetch(206);

    await runEmbywatch('https://emby.example.com', baseConfig);

    const stops = stoppedBodies();
    expect(stops.length).toBeGreaterThanOrEqual(2);
    expect(stops[0].PlaySessionId).toBeUndefined();
    expect(stops[stops.length - 1].PlaySessionId).toMatch(/^bemby-/);
  });

  it('releases the session when the start report itself fails', async () => {
    routeFetch(206, {
      playingStatus: 500,
      playingMessage: 'duplicate key value violates unique constraint "idx_session_user_device_item"',
    });

    await expect(runEmbywatch('https://emby.example.com', baseConfig))
      .rejects.toThrow('idx_session_user_device_item');

    // Pre-flight clear, then the release for the row the failed start left behind.
    const stops = stoppedBodies();
    expect(stops).toHaveLength(2);
    expect(stops[1].PlaySessionId).toBeUndefined();
  });
});

describe('embywatch cancellation', () => {
  it('aborts before contacting the server when already cancelled', async () => {
    routeFetch(206);
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(runEmbywatch('https://emby.example.com', baseConfig, ctrl.signal))
      .rejects.toThrow('Job cancelled');
    expect(mockUndiciFetch).not.toHaveBeenCalled();
  });

  it('stops mid-playback and still reports Stopped so Emby clears the session', async () => {
    routeFetch(206);
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    await expect(
      runEmbywatch('https://emby.example.com', { ...baseConfig, playDuration: 60 }, ctrl.signal),
    ).rejects.toThrow('Job cancelled');

    const stopped = mockUndiciFetch.mock.calls.some(
      c => typeof c[0] === 'string' && c[0].endsWith('/Sessions/Playing/Stopped'),
    );
    expect(stopped).toBe(true);
  });
});
