import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

import { SlidingWindow } from '../../profile/utils/sliding-window';

/**
 * Limits of `GET /admin/users`, in memory (per process, reset on restart):
 * 60 requests per actor and 120 per IP in each minute. A request is counted
 * only when both limits have room, so a refused call costs nothing.
 */
@Injectable()
export class AdminUsersLimiter {
  private readonly actors = new SlidingWindow();
  private readonly ips = new SlidingWindow();

  constructor(private readonly config: ConfigService) {}

  /** Counts one request; returns the seconds to wait, 0 when allowed. */
  hit(actorUserId: string, ip: string): number {
    const windowMs = Number(this.config.get('ADMIN_USERS_LIST_WINDOW_MS'));
    const retryAfter = Math.max(
      this.actors.retryAfter(
        actorUserId,
        Number(this.config.get('ADMIN_USERS_LIST_ACTOR_LIMIT')),
        windowMs,
      ),
      this.ips.retryAfter(
        ip,
        Number(this.config.get('ADMIN_USERS_LIST_IP_LIMIT')),
        windowMs,
      ),
    );
    if (retryAfter > 0) return retryAfter;
    this.actors.record(actorUserId, windowMs);
    this.ips.record(ip, windowMs);
    return 0;
  }
}
