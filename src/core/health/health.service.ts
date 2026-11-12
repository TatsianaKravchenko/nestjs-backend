import { Injectable } from '@nestjs/common';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';

import { RbacPolicyHealthIndicator } from '@/modules/rbac/rbac-policy.health';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly rbacPolicy: RbacPolicyHealthIndicator,
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

  /** Readiness: always enforced; fails (503) until the RBAC policy snapshot is loaded. */
  checkReadiness() {
    return this.healthCheckService.check([() => this.rbacPolicy.check()]);
  }
}
