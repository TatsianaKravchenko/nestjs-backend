import { HealthIndicatorService } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';

import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacPolicyHealthIndicator } from './rbac-policy.health';

describe('RbacPolicyHealthIndicator', () => {
  const policy = { version: null as number | null };
  let indicator: RbacPolicyHealthIndicator;

  beforeEach(async () => {
    policy.version = null;
    const module = await Test.createTestingModule({
      providers: [
        RbacPolicyHealthIndicator,
        HealthIndicatorService,
        { provide: PolicySnapshotService, useValue: policy },
      ],
    }).compile();
    indicator = module.get(RbacPolicyHealthIndicator);
  });

  it('is down until the snapshot is loaded', () => {
    expect(indicator.check()).toEqual({
      rbac_policy: {
        status: 'down',
        message: 'Policy snapshot is not loaded',
      },
    });
  });

  it('is up with the policy version once loaded', () => {
    policy.version = 3;
    expect(indicator.check()).toEqual({
      rbac_policy: { status: 'up', policyVersion: 3 },
    });
  });
});
