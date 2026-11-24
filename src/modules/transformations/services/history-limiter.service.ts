import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';
import { SlidingWindow } from '@/modules/users/profile/utils/sliding-window';

/**
 * Limit of both history endpoints, in memory (per process, reset on restart):
 * 60 requests per user in each minute. The bucket belongs to the authenticated
 * actor and is shared by the self and the administrator route. A refused call
 * is not counted.
 */
@Injectable()
export class HistoryLimiter {
  private readonly actors = new SlidingWindow();

  constructor(private readonly config: ConfigService) {}

  /** Counts one request; returns the seconds to wait, 0 when allowed. */
  hit(actorUserId: string): number {
    const limit = Number(this.config.get('TRANSFORM_HISTORY_RATE_LIMIT'));
    const windowMs = Number(
      this.config.get('TRANSFORM_HISTORY_RATE_WINDOW_MS'),
    );
    const retryAfter = this.actors.retryAfter(actorUserId, limit, windowMs);
    if (retryAfter > 0) return retryAfter;
    this.actors.record(actorUserId, windowMs);
    return 0;
  }
}
