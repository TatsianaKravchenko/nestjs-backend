import { Controller, Get } from '@nestjs/common';
import { HealthCheck } from '@nestjs/terminus';

import { Public } from '@/modules/auth/decorators/public.decorator';
import { HealthService } from './health.service';
import { ConfigService } from '@/core/config/config.service';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @HealthCheck()
  async check() {
    const healthCheckEnabled = this.configService.get('HEALTH_CHECK_ENABLED');

    if (!healthCheckEnabled) {
      return this.healthService.getEmptyResponse();
    }

    return this.healthService.checkHealth();
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.healthService.checkReadiness();
  }
}
