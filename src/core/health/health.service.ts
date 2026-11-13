import { Injectable } from '@nestjs/common';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';

import { RbacPolicyHealthIndicator } from '@/modules/rbac/rbac-policy.health';
import { EmailChangeKeyHealthIndicator } from '@/modules/users/profile/health/email-change-key.health';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly rbacPolicy: RbacPolicyHealthIndicator,
    private readonly emailChangeKey: EmailChangeKeyHealthIndicator,
  ) {}

  getEmptyResponse(): HealthCheckResult {
    return {
      status: 'ok',
      details: {},
    };
  }

  checkHealth() {
    return this.healthCheckService.check([]);
  }

  /** Readiness: always enforced; fails (503) until the RBAC policy is loaded and the email change key is valid. */
  checkReadiness() {
    return this.healthCheckService.check([
      () => this.rbacPolicy.check(),
      () => this.emailChangeKey.check(),
    ]);
  }
}
