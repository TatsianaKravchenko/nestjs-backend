import { Module } from '@nestjs/common';

import { ConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { ThrottlerModule } from '@/core/throttler/throttler.module';

/**
 *
 * Application modules
 *
 */
import { AuthModule } from '@/modules/auth/auth.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { AdminUsersModule } from '@/modules/users/admin-list/admin-users.module';
import { DeletionModule } from '@/modules/users/deletion/deletion.module';
import { TransformationsModule } from '@/modules/transformations/transformations.module';
import { UserProfileModule } from '@/modules/users/profile/user-profile.module';
import { UsersModule } from '@/modules/users/users.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    ThrottlerModule,
    /**
     *
     * Application modules
     *
     */
    UsersModule,
    RbacModule,
    AuthModule,
    UserProfileModule,
    DeletionModule,
    AdminUsersModule,
    TransformationsModule,
  ],
})
export class AppModule {}
