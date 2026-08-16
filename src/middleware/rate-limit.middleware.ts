/**
 * Token bucket rate limiting for MCP tool calls.
 *
 * Why token bucket rather than a fixed window: a fixed window permits twice the
 * nominal rate across a boundary, because a client can spend its entire budget in
 * the last moment of one window and again in the first moment of the next. A token
 * bucket has no boundary to exploit, and it naturally allows a short burst up to
 * capacity, which is what interactive traffic actually looks like.
 *
 * Why per-tool budgets: a uniform limit is either too loose for the expensive tool
 * or too tight for the cheap one. A tool that hits a paid API and a tool that reads a
 * local file do not belong on the same budget.
 */

export interface RateLimitRule {
  /** Sustained rate. Refill happens continuously, not in discrete ticks. */
  requestsPerMinute: number;
  /**
   * Bucket capacity, which is the maximum burst.
   *
   * Defaults to requestsPerMinute, meaning a client may spend a full minute of
   * budget at once and then refill. Lower it to smooth traffic, raise it to tolerate
   * bursty callers.
   */
  burst?: number;
}

export interface RateLimitConfig {
  default: RateLimitRule;
  /** Overrides keyed by tool name. */
  perTool?: Record<string, RateLimitRule>;
  /**
   * Derives the identity a budget applies to.
   *
   * Returning a constant makes the limit global, which is occasionally correct (a
   * shared upstream quota) but usually a mistake: one noisy client would then starve
   * everyone else.
   */
  identify: (context: { toolName: string; userId?: string }) => string;
  /**
   * Idle buckets evicted after this long. Defaults to 10 minutes.
   *
   * Without eviction the bucket map grows once per distinct identity forever, which
   * is an unbounded memory leak keyed on user input.
   */
  idleEvictionMs?: number;
}

export type RateLimitDecision =
  | { allowed: true; remaining: number; capacity: number }
  | { allowed: false; retryAfterMs: number; limit: number; windowMs: number };

interface Bucket {
  /** Fractional tokens. Continuous refill requires sub-integer state. */
  tokens: number;
  capacity: number;
  /** Tokens added per millisecond. */
  refillRate: number;
  lastRefill: number;
  lastAccess: number;
}

const MS_PER_MINUTE = 60_000;
const DEFAULT_IDLE_EVICTION_MS = 600_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly config: RateLimitConfig;
  private readonly idleEvictionMs: number;

  private stats = { allowed: 0, rejected: 0, evicted: 0 };

  constructor(config: RateLimitConfig) {
    this.validateRule('default', config.default);

    for (const [tool, rule] of Object.entries(config.perTool ?? {})) {
      this.validateRule(tool, rule);
    }

    this.config = config;
    this.idleEvictionMs = config.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS;
  }

  /**
   * Consume one token.
   *
   * Check and consume are a single operation on purpose. Splitting them creates a
   * race where two concurrent calls both observe an available token and both
   * proceed, which is precisely the overrun the limiter exists to prevent.
   */
  check(toolName: string, userId?: string, now: number = Date.now()): RateLimitDecision {
    const identity = this.config.identify({
      toolName,
      ...(userId !== undefined ? { userId } : {}),
    });

    // Budgets are per identity AND per tool. Keying on identity alone would let a
    // cheap tool consume the budget an expensive tool needed.
    const key = `${identity}::${toolName}`;
    const rule = this.config.perTool?.[toolName] ?? this.config.default;

    this.evictIdle(now);

    let bucket = this.buckets.get(key);

    if (!bucket) {
      const capacity = rule.burst ?? rule.requestsPerMinute;
      bucket = {
        // A new identity starts full. Starting empty would rate-limit a client's
        // very first request, which reads as an outage rather than a limit.
        tokens: capacity,
        capacity,
        refillRate: rule.requestsPerMinute / MS_PER_MINUTE,
        lastRefill: now,
        lastAccess: now,
      };
      this.buckets.set(key, bucket);
    }

    this.refill(bucket, now);
    bucket.lastAccess = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.stats.allowed++;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        capacity: bucket.capacity,
      };
    }

    this.stats.rejected++;

    // Told exactly when to come back. A client informed only that it was rate
    // limited retries immediately and compounds the problem.
    const deficit = 1 - bucket.tokens;
    return {
      allowed: false,
      retryAfterMs: Math.ceil(deficit / bucket.refillRate),
      limit: rule.requestsPerMinute,
      windowMs: MS_PER_MINUTE,
    };
  }

  /**
   * Return a token after a call that should not have counted.
   *
   * Used when a tool fails for a reason the caller did not cause, such as an
   * upstream 503. Charging a client for the server's own failure means an outage
   * also rate-limits everyone who was affected by it.
   */
  refund(toolName: string, userId?: string): void {
    const identity = this.config.identify({
      toolName,
      ...(userId !== undefined ? { userId } : {}),
    });

    const bucket = this.buckets.get(`${identity}::${toolName}`);
    if (!bucket) return;

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + 1);
  }

  /** Non-consuming inspection, for a headers-only or dry-run path. */
  peek(toolName: string, userId?: string, now: number = Date.now()): {
    remaining: number;
    capacity: number;
    refillsFullyInMs: number;
  } {
    const identity = this.config.identify({
      toolName,
      ...(userId !== undefined ? { userId } : {}),
    });

    const rule = this.config.perTool?.[toolName] ?? this.config.default;
    const capacity = rule.burst ?? rule.requestsPerMinute;
    const bucket = this.buckets.get(`${identity}::${toolName}`);

    if (!bucket) return { remaining: capacity, capacity, refillsFullyInMs: 0 };

    // A copy, so peeking cannot mutate the live bucket. The refill maths needs
    // current state, and doing it in place would make an inspection call
    // observable.
    const projected = { ...bucket };
    this.refill(projected, now);

    const missing = projected.capacity - projected.tokens;

    return {
      remaining: Math.floor(projected.tokens),
      capacity: projected.capacity,
      refillsFullyInMs: missing <= 0 ? 0 : Math.ceil(missing / projected.refillRate),
    };
  }

  getStats(): {
    allowed: number;
    rejected: number;
    rejectionRate: number;
    activeBuckets: number;
    evicted: number;
  } {
    const total = this.stats.allowed + this.stats.rejected;

    return {
      allowed: this.stats.allowed,
      rejected: this.stats.rejected,
      rejectionRate: total > 0 ? this.stats.rejected / total : 0,
      activeBuckets: this.buckets.size,
      evicted: this.stats.evicted,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.stats = { allowed: 0, rejected: 0, evicted: 0 };
  }

  /**
   * Continuous refill based on elapsed time.
   *
   * Time-based rather than tick-based, so no timer is needed. A background interval
   * would keep the process alive and complicate shutdown, and the bucket only has to
   * be correct at the moment it is read.
   */
  private refill(bucket: Bucket, now: number): void {
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);
    bucket.lastRefill = now;
  }

  /**
   * Drop buckets untouched for longer than the eviction window.
   *
   * A full bucket is safe to forget: recreating it yields the same full bucket. The
   * eviction window must exceed the time to refill from empty, otherwise a
   * throttled client could be evicted while still in deficit and return to a full
   * bucket, bypassing the limit entirely.
   */
  private evictIdle(now: number): void {
    if (this.buckets.size === 0) return;

    const cutoff = now - this.idleEvictionMs;

    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess > cutoff) continue;

      // Only evict a bucket that has refilled. Evicting one in deficit would hand
      // back a full bucket and let a throttled client escape the limit.
      this.refill(bucket, now);
      if (bucket.tokens < bucket.capacity) continue;

      this.buckets.delete(key);
      this.stats.evicted++;
    }
  }

  private validateRule(label: string, rule: RateLimitRule): void {
    if (!Number.isFinite(rule.requestsPerMinute) || rule.requestsPerMinute <= 0) {
      throw new Error(
        `Rate limit "${label}" has requestsPerMinute=${rule.requestsPerMinute}. It must ` +
          'be a positive finite number. Zero would block every call, which is better ' +
          'expressed by denying the tool in the permission gate.',
      );
    }

    if (rule.burst !== undefined) {
      if (!Number.isFinite(rule.burst) || rule.burst < 1) {
        throw new Error(
          `Rate limit "${label}" has burst=${rule.burst}. A burst below 1 means no ` +
            'request can ever be admitted, because a single call costs one token.',
        );
      }
    }
  }
}
