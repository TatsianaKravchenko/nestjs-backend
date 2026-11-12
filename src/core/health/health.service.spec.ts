import { HealthCheckService } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';

import { RbacPolicyHealthIndicator } from '@/modules/rbac/rbac-policy.health';

import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  const healthCheckService = { check: jest.fn() };
  const rbacPolicy = { check: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: HealthCheckService, useValue: healthCheckService },
        { provide: RbacPolicyHealthIndicator, useValue: rbacPolicy },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns an empty ok response', () => {
    expect(service.getEmptyResponse()).toEqual({ status: 'ok', details: {} });
  });

  it('delegates checkHealth to HealthCheckService with no indicators', async () => {
    const result = { status: 'ok', info: {}, error: {}, details: {} };
    healthCheckService.check.mockResolvedValue(result);

    await expect(service.checkHealth()).resolves.toBe(result);
    expect(healthCheckService.check).toHaveBeenCalledWith([]);
  });

  it('readiness runs the RBAC policy indicator', async () => {
    const result = { status: 'error', info: {}, error: {}, details: {} };
    healthCheckService.check.mockImplementation(
      (indicators: Array<() => unknown>) => {
        indicators.forEach((run) => run());
        return Promise.resolve(result);
      },
    );

    await expect(service.checkReadiness()).resolves.toBe(result);
    expect(rbacPolicy.check).toHaveBeenCalledTimes(1);
  });
});
