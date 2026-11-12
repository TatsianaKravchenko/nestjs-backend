import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

export type ProfileScope = 'self' | 'foreign';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const SWEEP_THRESHOLD = 10_000;

/**
 * Sliding-window limiter per actor and scope: own profile/photo reads and
 * foreign ones are counted separately (120 and 60 per minute by default).
 * State is in memory: per process, reset on restart.
 */
@Injectable()
export class ProfileRateLimiter {
  /** `${scope}:${actorUserId}` -> timestamps of requests inside the window */
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  hit(actorUserId: string, scope: ProfileScope): RateLimitDecision {
    const now = Date.now();
    const windowMs = Number(this.config.get('PROFILE_READ_WINDOW_MS'));
    const limit = Number(
      this.config.get(
        scope === 'self'
          ? 'PROFILE_READ_OWN_LIMIT'
          : 'PROFILE_READ_FOREIGN_LIMIT',
      ),
    );
    const key = `${scope}:${actorUserId}`;
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => at > now - windowMs,
    );

    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((recent[0] + windowMs - now) / 1000),
        ),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(now, windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number, windowMs: number): void {
    for (const [key, stamps] of this.hits) {
      if (stamps.every((at) => at <= now - windowMs)) this.hits.delete(key);
    }
  }
}
