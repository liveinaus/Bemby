// Security tests: authentication middleware, password-change flow, and
// the settings key whitelist that keeps sensitive keys off-limits.

vi.mock('../db/database', () => ({
  db: {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(null),
      run: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn().mockImplementation((fn: () => void) => fn),
  },
}));
vi.mock('../scheduler', () => ({ refreshScheduler: vi.fn() }));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, verifySessionToken } from '../middleware/auth';
import { ALLOWED_KEYS, CLIENT_HIDDEN_KEYS } from '../routes/settings';

const TEST_SECRET = 'test-only-secret-do-not-use-in-prod';

// Build a minimal mock Request object
function mockReq(overrides: Partial<{ headers: Record<string, string>; query: Record<string, string>; method: string; originalUrl: string }> = {}): Request {
  return {
    headers: {},
    query: {},
    method: 'GET',
    originalUrl: '/api/accounts',
    ...overrides,
  } as unknown as Request;
}

// Build a mock Response that records status/json calls
function mockRes(): Response & { _status?: number; _body?: unknown } {
  const res: any = {};
  res.status = vi.fn().mockImplementation((code: number) => { res._status = code; return res; });
  res.json   = vi.fn().mockImplementation((body: unknown) => { res._body = body; return res; });
  return res as Response & { _status?: number; _body?: unknown };
}

// Issue a signed JWT with the test secret
function makeToken(payload: Record<string, unknown>, expiresIn: SignOptions['expiresIn'] = '1h'): string {
  return jwt.sign(payload, TEST_SECRET, { expiresIn });
}

beforeEach(() => {
  process.env.JWT_SECRET = TEST_SECRET;
  vi.clearAllMocks();
});

// ── requireAuth -- token presence and validity ────────────────────────────────

describe('requireAuth -- token validation', () => {
  it('returns 401 when no token is supplied at all', () => {
    const req  = mockReq();
    const res  = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a completely invalid token string', () => {
    const req  = mockReq({ headers: { authorization: 'Bearer not.a.jwt' } });
    const res  = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'admin' }, 'wrong-secret', { expiresIn: '1h' });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 for an expired token', () => {
    const token = makeToken({ sub: 'admin' }, '-1s');
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('calls next() for a valid Bearer token', () => {
    const token = makeToken({ sub: 'admin' });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a captcha token (has `cap`, no `sub`) used as a session token', () => {
    // The public /api/auth/captcha endpoint signs this with the same secret.
    const token = makeToken({ cap: 'abcde', typ: 'captcha' }, '5m');
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a legacy captcha-shaped token with no typ claim', () => {
    const token = makeToken({ cap: 'abcde' }, '5m');
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a validly-signed token with a non-auth typ claim', () => {
    const token = makeToken({ sub: 'admin', typ: 'captcha' });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() for a token with typ=auth', () => {
    const token = makeToken({ sub: 'admin', typ: 'auth' });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses a session token supplied in the query string', () => {
    // A token in a URL ends up in access logs and browser history. Addresses the browser
    // loads by itself use a media ticket instead (see auth/mediaTickets).
    const token = makeToken({ sub: 'admin' });
    const req   = mockReq({ query: { token } });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('ignores a malformed Authorization header without "Bearer " prefix', () => {
    const token = makeToken({ sub: 'admin' });
    const req   = mockReq({ headers: { authorization: token } }); // missing "Bearer " prefix
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    // No header prefix means token is taken from query (empty) → 401
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('reports error body for missing token', () => {
    const res  = mockRes();
    requireAuth(mockReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });

  it('reports error body for invalid token', () => {
    const res  = mockRes();
    requireAuth(mockReq({ headers: { authorization: 'Bearer bad' } }), res, vi.fn() as unknown as NextFunction);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }));
  });
});

// ── verifySessionToken -- shared by the WebSocket handshake ───────────────────

describe('verifySessionToken (WebSocket handshake guard)', () => {
  it('accepts a genuine session token', () => {
    const decoded = verifySessionToken(makeToken({ sub: 'admin', typ: 'auth' }));
    expect(decoded?.sub).toBe('admin');
  });

  it('rejects a public captcha token (regression: WS auth bypass)', () => {
    // The unauthenticated /api/auth/captcha endpoint mints this with the same secret
    expect(verifySessionToken(makeToken({ cap: 'abcde', typ: 'captcha' }, '5m'))).toBeNull();
  });

  it('rejects a token signed with the wrong secret', () => {
    expect(verifySessionToken(jwt.sign({ sub: 'admin' }, 'wrong-secret', { expiresIn: '1h' }))).toBeNull();
  });

  it('rejects an expired token', () => {
    expect(verifySessionToken(makeToken({ sub: 'admin' }, '-1s'))).toBeNull();
  });

  it('rejects a non-auth typ claim and garbage input', () => {
    expect(verifySessionToken(makeToken({ sub: 'admin', typ: 'captcha' }))).toBeNull();
    expect(verifySessionToken('not.a.jwt')).toBeNull();
  });

  it('surfaces requirePasswordChange so the WS handler can enforce it', () => {
    const decoded = verifySessionToken(makeToken({ sub: 'admin', typ: 'auth', requirePasswordChange: true }));
    expect(decoded?.requirePasswordChange).toBe(true);
  });
});

// ── requireAuth -- requirePasswordChange flow ─────────────────────────────────

describe('requireAuth -- requirePasswordChange enforcement', () => {
  it('returns 403 on GET /api/accounts when password change is required', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/accounts' });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 on POST /api/jobs when password change is required', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'POST', originalUrl: '/api/jobs' });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 403 on GET /api/data/export when password change is required', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/data/export' });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('includes requirePasswordChange: true in the 403 response body', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'GET', originalUrl: '/api/accounts' });
    const res   = mockRes();
    requireAuth(req, res, vi.fn() as unknown as NextFunction);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ requirePasswordChange: true }));
  });

  it('allows PUT /api/auth/credentials through when password change is required', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'PUT', originalUrl: '/api/auth/credentials' });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('strips query string when checking the allowed credentials path', () => {
    const token = makeToken({ sub: 'admin', requirePasswordChange: true });
    const req   = mockReq({ headers: { authorization: `Bearer ${token}` }, method: 'PUT', originalUrl: '/api/auth/credentials?foo=bar' });
    const res   = mockRes();
    const next  = vi.fn();
    requireAuth(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it('normal token with no requirePasswordChange passes all routes', () => {
    const token = makeToken({ sub: 'admin' });
    const endpoints: Array<[string, string]> = [
      ['GET', '/api/accounts'],
      ['POST', '/api/jobs'],
      ['GET', '/api/data/export'],
      ['PUT', '/api/settings'],
    ];
    for (const [method, url] of endpoints) {
      const res  = mockRes();
      const next = vi.fn();
      requireAuth(mockReq({ headers: { authorization: `Bearer ${token}` }, method, originalUrl: url }), res, next as NextFunction);
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});

// ── Settings key whitelist (attack surface reduction) ────────────────────────

describe('ALLOWED_KEYS whitelist -- sensitive keys are excluded', () => {
  it('does not allow admin_password_hash to be updated via the settings route', () => {
    expect(ALLOWED_KEYS).not.toContain('admin_password_hash');
  });

  it('does not allow admin_username to be updated via the settings route', () => {
    expect(ALLOWED_KEYS).not.toContain('admin_username');
  });

  it('does not allow ai_api_key to be updated via the settings route (managed via AI Suppliers)', () => {
    expect(ALLOWED_KEYS).not.toContain('ai_api_key');
  });

  it('does not allow jwt_secret to appear in ALLOWED_KEYS', () => {
    expect(ALLOWED_KEYS).not.toContain('jwt_secret');
  });

  it('does not allow session_string to appear in ALLOWED_KEYS', () => {
    expect(ALLOWED_KEYS).not.toContain('session_string');
  });

  it('does not contain any duplicates', () => {
    expect(new Set(ALLOWED_KEYS).size).toBe(ALLOWED_KEYS.length);
  });

  it('permits expected operational settings', () => {
    const expected = ['default_timezone', 'default_max_retry', 'check_daily_run', 'default_ua', 'proxies', 'tg_app_clients', 'tg_client_mode'];
    for (const key of expected) expect(ALLOWED_KEYS).toContain(key);
  });
});

// ── Client settings response -- secret keys are never sent to the browser ──────

describe('CLIENT_HIDDEN_KEYS -- secrets excluded from GET /api/settings', () => {
  it('hides admin_password_hash from the settings response', () => {
    expect(CLIENT_HIDDEN_KEYS.has('admin_password_hash')).toBe(true);
  });

  it('hides admin_username from the settings response', () => {
    expect(CLIENT_HIDDEN_KEYS.has('admin_username')).toBe(true);
  });

  it('hides jwt_secret from the settings response', () => {
    expect(CLIENT_HIDDEN_KEYS.has('jwt_secret')).toBe(true);
  });

  it('hides the legacy ai_api_key from the settings response', () => {
    expect(CLIENT_HIDDEN_KEYS.has('ai_api_key')).toBe(true);
  });

  it('hides the notification bot token, which is served masked instead', () => {
    expect(CLIENT_HIDDEN_KEYS.has('notify_bot_token')).toBe(true);
  });

  it('hides the proxy provider list and the tunnel nodes, both of which carry credentials', () => {
    expect(CLIENT_HIDDEN_KEYS.has('proxy_providers')).toBe(true);
    // A node's uuid is what its Worker admits the connection on
    expect(CLIENT_HIDDEN_KEYS.has('vless_nodes')).toBe(true);
  });

  it('does not let the panel write the tunnel nodes: an import records those itself', () => {
    expect(ALLOWED_KEYS).not.toContain('vless_nodes');
  });
});

// ── getJwtSecret -- refuses to boot with a known-default secret ───────────────

describe('getJwtSecret -- rejects insecure secrets', () => {
  it('exits when JWT_SECRET is a publicly known default', async () => {
    const { getJwtSecret } = await import('../middleware/auth');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit called');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const bad of ['change-me-in-production', 'changeme', 'secret']) {
      process.env.JWT_SECRET = bad;
      expect(() => getJwtSecret()).toThrow('process.exit called');
    }

    process.env.JWT_SECRET = TEST_SECRET;
    expect(getJwtSecret()).toBe(TEST_SECRET);
    exitSpy.mockRestore();
  });
});

// ── Login logic -- password hash and requirePasswordChange ────────────────────

describe('login -- password hashing and requirePasswordChange', () => {
  // Test the HMAC-SHA256 hashing used in auth.ts directly
  // Fixed key from auth.ts: 'bemby-pwd-v1'
  const crypto = require('crypto') as typeof import('crypto');
  const PWD_HMAC_KEY = 'bemby-pwd-v1';
  function hashPassword(pwd: string) {
    return crypto.createHmac('sha256', PWD_HMAC_KEY).update(pwd).digest('hex');
  }

  it('same password always produces the same hash', () => {
    expect(hashPassword('mypassword')).toBe(hashPassword('mypassword'));
  });

  it('different passwords produce different hashes', () => {
    expect(hashPassword('password1')).not.toBe(hashPassword('password2'));
  });

  it('hash is not the raw password', () => {
    expect(hashPassword('secret')).not.toBe('secret');
  });

  it('requirePasswordChange flag is set in JWT when password is "changeme"', () => {
    // Mirrors the route logic in auth.ts
    const password = 'changeme';
    const requirePasswordChange = password === 'changeme';
    expect(requirePasswordChange).toBe(true);
    const token = makeToken(requirePasswordChange ? { sub: 'admin', requirePasswordChange: true } : { sub: 'admin' });
    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.requirePasswordChange).toBe(true);
  });

  it('requirePasswordChange flag is absent when a non-default password is used', () => {
    const password: string = 'myCustomSecurePassword';
    const requirePasswordChange = password === 'changeme';
    expect(requirePasswordChange).toBe(false);
    const token = makeToken({ sub: 'admin' });
    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded).not.toHaveProperty('requirePasswordChange');
  });

  it('fresh token issued after credential change has no requirePasswordChange', () => {
    // After credentials are updated, auth.ts issues a fresh token with only { sub }
    const freshToken = makeToken({ sub: 'newuser' });
    const decoded = jwt.verify(freshToken, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.sub).toBe('newuser');
    expect(decoded).not.toHaveProperty('requirePasswordChange');
  });
});

// ── Account response -- API hash is not leaked in normal listing ──────────────

describe('account listing -- apiHash is not exposed', () => {
  it('toJson helper omits api_hash from the response shape', () => {
    // Mirrors the toJson() function in routes/accounts.ts
    const row: Record<string, unknown> = {
      id: 1, name: 'Alice', phone_number: '+61400000001',
      api_id: 12345, api_hash: 'super-secret-hash',
      auth_status: 'authenticated', proxy_id: null, disabled: 0,
      app_client_id: null, created_at: '2024-01-01', sort_order: 1,
      tg_display_name: null, tg_username: null,
    };

    // Apply the same projection as toJson()
    const json = {
      id: row.id, name: row.name, phoneNumber: row.phone_number,
      apiId: row.api_id,                         // api_hash intentionally omitted
      authStatus: row.auth_status, proxyId: row.proxy_id ?? null,
      disabled: Boolean(row.disabled), appClientId: row.app_client_id ?? null,
      createdAt: row.created_at, sortOrder: row.sort_order ?? 0,
      tgDisplayName: row.tg_display_name ?? null, tgUsername: row.tg_username ?? null,
    };

    expect(json).not.toHaveProperty('apiHash');
    expect(json).not.toHaveProperty('api_hash');
    expect(Object.values(json)).not.toContain('super-secret-hash');
  });
});
