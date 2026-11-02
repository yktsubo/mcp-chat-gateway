import { afterEach, describe, expect, it, vi } from 'vitest';

const redis = {
  hgetall: vi.fn(),
  hdel: vi.fn(),
  del: vi.fn(),
  multi: vi.fn(),
};
const fromEnv = vi.fn(() => redis);
vi.mock('@upstash/redis', () => ({ Redis: { fromEnv: () => fromEnv() } }));

const { FieldCipher, MemoryStore, getStore, redisClient, setStore } = await import('./store');

afterEach(() => {
  setStore(undefined);
  vi.clearAllMocks();
});

describe('MemoryStore', () => {
  it('reads, merges and removes fields', async () => {
    const store = new MemoryStore();
    expect(await store.get('k')).toEqual({});

    await store.set('k', { a: 1, b: { c: 2 } });
    await store.set('k', { d: 'x' });
    expect(await store.get('k')).toEqual({ a: 1, b: { c: 2 }, d: 'x' });

    await store.remove('k', ['a', 'd']);
    expect(await store.get('k')).toEqual({ b: { c: 2 } });
    await store.remove('missing', ['a']);

    await store.delete('k');
    expect(await store.get('k')).toEqual({});
  });

  it('returns copies, so callers cannot change what is stored', async () => {
    const store = new MemoryStore();
    await store.set('k', { b: { c: 2 } });
    const read = await store.get('k');
    (read.b as { c: number }).c = 99;
    expect(await store.get('k')).toEqual({ b: { c: 2 } });
  });
});

describe('getStore', () => {
  it('has no Redis client without connection details', () => {
    expect(redisClient({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('uses memory when Redis is not configured (local development)', () => {
    const store = getStore({} as NodeJS.ProcessEnv);
    expect(store).toBeInstanceOf(MemoryStore);
    expect(getStore({} as NodeJS.ProcessEnv)).toBe(store);
  });

  it('requires NEXTAUTH_SECRET to encrypt Redis values', () => {
    expect(() => getStore({ KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /NEXTAUTH_SECRET/,
    );
  });

  it('refuses to run on Vercel without Redis', () => {
    expect(() => getStore({ VERCEL: '1' } as NodeJS.ProcessEnv)).toThrow(/Redis is not configured/);
  });

  it.each([
    { KV_REST_API_URL: 'https://kv', KV_REST_API_TOKEN: 't', NEXTAUTH_SECRET: 'secret' },
    { UPSTASH_REDIS_REST_URL: 'https://kv', UPSTASH_REDIS_REST_TOKEN: 't', NEXTAUTH_SECRET: 'secret' },
  ])('uses Upstash Redis when its connection details are set (%o)', async (env) => {
    const exec = vi.fn();
    const expire = vi.fn(() => ({ exec }));
    const hset = vi.fn((_key: string, _fields: Record<string, string>) => ({ expire }));
    redis.multi.mockReturnValue({ hset });

    const store = getStore(env as unknown as NodeJS.ProcessEnv);
    expect(fromEnv).toHaveBeenCalled();

    await store.set('k', { tokens: { access_token: 'a' }, state: 's' }, 60);
    const written = hset.mock.calls[0][1];
    expect(hset.mock.calls[0][0]).toBe('k');
    expect(written.tokens).toMatch(/^v1\./);
    expect(JSON.stringify(written)).not.toContain('access_token');

    redis.hgetall.mockResolvedValueOnce(written).mockResolvedValueOnce(null);
    expect(await store.get('k')).toEqual({ tokens: { access_token: 'a' }, state: 's' });
    expect(await store.get('k')).toEqual({});
    expect(expire).toHaveBeenCalledWith('k', 60);
    expect(exec).toHaveBeenCalled();

    await store.remove('k', ['state', 'verifier']);
    expect(redis.hdel).toHaveBeenCalledWith('k', 'state', 'verifier');

    await store.delete('k');
    expect(redis.del).toHaveBeenCalledWith('k');
    expect(redisClient(env as unknown as NodeJS.ProcessEnv)).toBe(redis);
  });
});

describe('FieldCipher', () => {
  const cipher = new FieldCipher('secret');

  it('round-trips values with a random IV', () => {
    const a = cipher.encrypt('k', 'tokens', { access_token: 'a' });
    expect(a).not.toBe(cipher.encrypt('k', 'tokens', { access_token: 'a' }));
    expect(cipher.decrypt('k', 'tokens', a)).toEqual({ access_token: 'a' });
  });

  it('rejects values moved to another key or field, tampered, unencrypted, or encrypted with another secret', () => {
    const a = cipher.encrypt('mcp:u1:s', 'tokens', { access_token: 'a' });
    expect(cipher.decrypt('mcp:u2:s', 'tokens', a)).toBeUndefined();
    expect(cipher.decrypt('mcp:u1:s', 'client', a)).toBeUndefined();
    expect(cipher.decrypt('mcp:u1:s', 'tokens', a.slice(0, -2) + (a.endsWith('A') ? 'BB' : 'AA'))).toBeUndefined();
    expect(cipher.decrypt('mcp:u1:s', 'tokens', { access_token: 'a' })).toBeUndefined();
    expect(cipher.decrypt('mcp:u1:s', 'tokens', 'plain')).toBeUndefined();
    expect(new FieldCipher('other').decrypt('mcp:u1:s', 'tokens', a)).toBeUndefined();
  });
});
