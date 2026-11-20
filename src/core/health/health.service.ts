import { Injectable } from '@nestjs/common';
import { HealthCheckService, HealthCheckResult } from '@nestjs/terminus';

import { RbacPolicyHealthIndicator } from '@/modules/rbac/rbac-policy.health';
import { TransformationsReadinessIndicator } from '@/modules/transformations/health/transformations.health';
import { UserListCursorHealthIndicator } from '@/modules/users/admin-list/health/user-list-cursor.health';
import { DeletionReadinessIndicator } from '@/modules/users/deletion/health/deletion.health';
import { EmailChangeKeyHealthIndicator } from '@/modules/users/profile/health/email-change-key.health';

@Injectable()
export class HealthService {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly rbacPolicy: RbacPolicyHealthIndicator,
    private readonly emailChangeKey: EmailChangeKeyHealthIndicator,
    private readonly deletion: DeletionReadinessIndicator,
    private readonly userListCursor: UserListCursorHealthIndicator,
    private readonly transformations: TransformationsReadinessIndicator,
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

  /** Readiness: always enforced; fails (503) until the RBAC policy is loaded and the email change and deletion keys are valid and every user data store has an eraser, the user list cursor keys are valid, and the transformations setup is complete (default `user` role, `transformations` permission, writable temp area). */
  checkReadiness() {
    return this.healthCheckService.check([
      () => this.rbacPolicy.check(),
      () => this.emailChangeKey.check(),
      () => this.deletion.checkKey(),
      () => this.deletion.checkErasers(),
      () => this.userListCursor.check(),
      () => this.transformations.check(),
    ]);
  }
}
