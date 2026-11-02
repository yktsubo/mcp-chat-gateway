import { Ratelimit } from '@upstash/ratelimit';
import { redisClient } from './store';

// Per-user chat rate limit over a sliding 1-minute window (CHAT_RATE_LIMIT_PER_MINUTE, default 10).
// Disabled when Redis is not configured.
let limiter: Ratelimit | undefined;

type LimitResult = { success: true } | { success: false; retryAfterSeconds: number };

export async function checkChatLimit(user: string): Promise<LimitResult> {
  const redis = redisClient();
  if (!redis) return { success: true };
  limiter ??= new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE) || 10, '1 m'),
    prefix: 'ratelimit:chat',
  });
  const { success, reset } = await limiter.limit(user);
  return success ? { success } : { success, retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)) };
}

/** For tests: resets the limiter */
export function resetChatLimiter() {
  limiter = undefined;
}
