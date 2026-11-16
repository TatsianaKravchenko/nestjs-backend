import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { SlidingWindow } from '../../profile/utils/sliding-window';

/**
 * Limits of the deletion routes, in memory (per process, reset on restart):
 * challenge emails per user (5 per hour) and status reads per IP (60 per minute).
 */
@Injectable()
export class DeletionLimiter {
  private readonly emails = new SlidingWindow();
  private readonly statuses = new SlidingWindow();

  constructor(private readonly config: ConfigService) {}

  /** Seconds until another email may be sent; 0 when allowed. */
  emailRetryAfter(userId: string): number {
    return this.emails.retryAfter(
      userId,
      Number(this.config.get('DELETION_EMAIL_HOURLY_LIMIT')),
      Number(this.config.get('DELETION_EMAIL_WINDOW_MS')),
    );
  }

  recordEmail(userId: string): void {
    this.emails.record(
      userId,
      Number(this.config.get('DELETION_EMAIL_WINDOW_MS')),
    );
  }

  /** Counts one status read; returns the seconds to wait, 0 when allowed. */
  hitStatus(ip: string): number {
    const windowMs = Number(this.config.get('DELETION_STATUS_WINDOW_MS'));
    const retryAfter = this.statuses.retryAfter(
      ip,
      Number(this.config.get('DELETION_STATUS_LIMIT')),
      windowMs,
    );
    if (retryAfter === 0) this.statuses.record(ip, windowMs);
    return retryAfter;
  }
}
