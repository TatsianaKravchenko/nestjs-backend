import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { RbacModule } from '@/modules/rbac/rbac.module';
import { AdminUsersModule } from '@/modules/users/admin-list/admin-users.module';
import { DeletionModule } from '@/modules/users/deletion/deletion.module';
import { UserProfileModule } from '@/modules/users/profile/user-profile.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [
    TerminusModule,
    RbacModule,
    UserProfileModule,
    DeletionModule,
    AdminUsersModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
