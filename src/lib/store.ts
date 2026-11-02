import { Redis } from '@upstash/redis';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

// Server-side storage: Upstash Redis, or process memory for local development without Redis.
// Values are hashes read and written per field. Each field is encrypted in Redis with a key derived from NEXTAUTH_SECRET.
export interface HashStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(key: string, fields: Record<string, unknown>, ttlSeconds: number): Promise<void>;
  remove(key: string, fields: string[]): Promise<void>;
  delete(key: string): Promise<void>;
}

const CIPHER_VERSION = 'v1';

/**
 * Encrypts field values with AES-256-GCM. Format: `v1.<IV>.<ciphertext+tag>` (base64url).
 * The key and field name are bound as AAD, so a value cannot be decrypted under another key or field.
 */
export class FieldCipher {
  private key: Buffer;

  constructor(secret: string) {
    this.key = Buffer.from(hkdfSync('sha256', secret, 'mcp-chat', 'redis field encryption v1', 32));
  }

  encrypt(key: string, field: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${key}\0${field}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return [CIPHER_VERSION, iv.toString('base64url'), data.toString('base64url')].join('.');
  }

  /** Returns undefined for values that cannot be decrypted (unencrypted, other secret, or tampered) */
  decrypt(key: string, field: string, stored: unknown): unknown {
    if (typeof stored !== 'string') return undefined;
    const [version, iv, data] = stored.split('.');
    if (version !== CIPHER_VERSION || !iv || !data) return undefined;
    try {
      const bytes = Buffer.from(data, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(`${key}\0${field}`));
      decipher.setAuthTag(bytes.subarray(-16));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString('utf8'));
    } catch {
      return undefined;
    }
  }
}

class RedisStore implements HashStore {
  constructor(
    private redis: Redis,
    private cipher: FieldCipher,
  ) {}

  async get(key: string) {
    const stored = (await this.redis.hgetall<Record<string, unknown>>(key)) ?? {};
    const fields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(stored)) {
      const plain = this.cipher.decrypt(key, field, value);
      if (plain !== undefined) fields[field] = plain;
    }
    return fields;
  }

  async set(key: string, fields: Record<string, unknown>, ttlSeconds: number) {
    const encrypted = Object.fromEntries(
      Object.entries(fields).map(([field, value]) => [field, this.cipher.encrypt(key, field, value)]),
    );
    await this.redis.multi().hset(key, encrypted).expire(key, ttlSeconds).exec();
  }

  async remove(key: string, fields: string[]) {
    await this.redis.hdel(key, ...fields);
  }

  async delete(key: string) {
    await this.redis.del(key);
  }
}

export class MemoryStore implements HashStore {
  private data = new Map<string, Record<string, unknown>>();

  async get(key: string) {
    return structuredClone(this.data.get(key) ?? {});
  }

  async set(key: string, fields: Record<string, unknown>) {
    this.data.set(key, { ...this.data.get(key), ...structuredClone(fields) });
  }

  async remove(key: string, fields: string[]) {
    const current = this.data.get(key);
    if (current) for (const field of fields) delete current[field];
  }

  async delete(key: string) {
    this.data.delete(key);
  }
}

const hasRedis = (env: NodeJS.ProcessEnv) =>
  !!(env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL) && !!(env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN);

let redis: Redis | undefined;

/** Upstash Redis client, or undefined if Redis is not configured */
export function redisClient(env: NodeJS.ProcessEnv = process.env): Redis | undefined {
  if (!redis && hasRedis(env)) redis = Redis.fromEnv();
  return redis;
}

let store: HashStore | undefined;

export function getStore(env: NodeJS.ProcessEnv = process.env): HashStore {
  if (store) return store;
  const client = redisClient(env);
  if (client) {
    if (!env.NEXTAUTH_SECRET) throw new Error('NEXTAUTH_SECRET is not set');
    store = new RedisStore(client, new FieldCipher(env.NEXTAUTH_SECRET));
  } else if (env.VERCEL) {
    // Memory is not shared between Vercel function instances
    throw new Error('Redis is not configured: connect Upstash Redis to this project in Vercel (Storage)');
  } else {
    store = new MemoryStore();
  }
  return store;
}

/** For tests: replaces the store */
export function setStore(next: HashStore | undefined) {
  store = next;
  redis = undefined;
}
