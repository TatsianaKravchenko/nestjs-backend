import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import type { RateLimitDecision } from './profile-rate-limiter.service';

const SWEEP_THRESHOLD = 10_000;

/** In-memory sliding window per key (per process, reset on restart). */
class Window {
  private readonly hits = new Map<string, number[]>();

  private recent(key: string, now: number, windowMs: number): number[] {
    return (this.hits.get(key) ?? []).filter((at) => at > now - windowMs);
  }

  retryAfter(key: string, limit: number, windowMs: number): number {
    const now = Date.now();
    const recent = this.recent(key, now, windowMs);
    return recent.length < limit
      ? 0
      : Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }

  record(key: string, windowMs: number): void {
    const now = Date.now();
    this.hits.set(key, [...this.recent(key, now, windowMs), now]);
    if (this.hits.size > SWEEP_THRESHOLD) {
      for (const [k, stamps] of this.hits) {
        if (stamps.every((at) => at <= now - windowMs)) this.hits.delete(k);
      }
    }
  }
}

/**
 * Limits of the update operations: profile/photo mutations (30 per hour) and
 * emails sent for an email change (5 per hour), both per acting user.
 */
@Injectable()
export class MutationLimiter {
  private readonly mutations = new Window();
  private readonly emails = new Window();

  constructor(private readonly config: ConfigService) {}

  /** Counts one mutation; denies once the window is full. */
  hitMutation(actorUserId: string): RateLimitDecision {
    const windowMs = Number(this.config.get('PROFILE_MUTATION_WINDOW_MS'));
    const limit = Number(this.config.get('PROFILE_MUTATION_LIMIT'));
    const retryAfterSeconds = this.mutations.retryAfter(
      actorUserId,
      limit,
      windowMs,
    );
    if (retryAfterSeconds > 0) return { allowed: false, retryAfterSeconds };
    this.mutations.record(actorUserId, windowMs);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Seconds until another email may be sent; 0 when allowed. */
  emailRetryAfter(userId: string): number {
    return this.emails.retryAfter(
      userId,
      Number(this.config.get('EMAIL_CHANGE_HOURLY_LIMIT')),
      Number(this.config.get('EMAIL_CHANGE_WINDOW_MS')),
    );
  }

  recordEmail(userId: string): void {
    this.emails.record(
      userId,
      Number(this.config.get('EMAIL_CHANGE_WINDOW_MS')),
    );
  }
}
