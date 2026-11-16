import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { SlidingWindow } from '../utils/sliding-window';
import type { RateLimitDecision } from './profile-rate-limiter.service';

/**
 * Limits of the update operations: profile/photo mutations (30 per hour) and
 * emails sent for an email change (5 per hour), both per acting user.
 */
@Injectable()
export class MutationLimiter {
  private readonly mutations = new SlidingWindow();
  private readonly emails = new SlidingWindow();

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
