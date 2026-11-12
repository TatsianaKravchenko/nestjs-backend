import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { RbacModule } from '@/modules/rbac/rbac.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [TerminusModule, RbacModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
