import { HealthCheckService } from '@nestjs/terminus';
import { Test, TestingModule } from '@nestjs/testing';

import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  const healthCheckService = { check: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: HealthCheckService, useValue: healthCheckService },
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
});
