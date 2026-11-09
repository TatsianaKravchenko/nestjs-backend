import { Injectable } from '@nestjs/common';

import { ConfigService } from '@/core/config/config.service';

/**
 * Failed login checks per key (email pseudonym + IP) inside a sliding window.
 * State is in memory: it is per process and resets on restart.
 */
@Injectable()
export class LoginFailureLimiter {
  //key - email_hash|client_ip, value - arr of timestamps of password fails
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly config: ConfigService) {}

  isBlocked(key: string): boolean {
    return (
      this.recent(key).length >= Number(this.config.get('LOGIN_FAILURE_LIMIT'))
    );
  }

  recordFailure(key: string): void {
    this.failures.set(key, [...this.recent(key), Date.now()]);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  /*key - `${subject}|${ctx.ip}`; subject - email hash, ctx.ip - client ip;
    failures check within 15 min;
    return arr of failures timestamps;
  */
  private recent(key: string): number[] {
    const windowStart =
      Date.now() - Number(this.config.get('LOGIN_FAILURE_WINDOW_MS'));
    const recent = (this.failures.get(key) ?? []).filter(
      (at) => at > windowStart,
    );
    if (recent.length === 0) {
      this.failures.delete(key);
    } else {
      this.failures.set(key, recent);
    }
    return recent;
  }
}
