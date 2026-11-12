import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { PolicySnapshotService } from './policy-snapshot.service';

/** Readiness probe: down until the initial policy snapshot has been loaded. */
@Injectable()
export class RbacPolicyHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly policy: PolicySnapshotService,
  ) {}

  check(key = 'rbac_policy'): HealthIndicatorResult {
    const session = this.indicators.check(key);
    const version = this.policy.version;
    return version === null
      ? session.down({ message: 'Policy snapshot is not loaded' })
      : session.up({ policyVersion: version });
  }
}
