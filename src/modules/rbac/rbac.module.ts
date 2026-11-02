import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DefaultRoleService } from './default-role.service';
import { Permission } from './entities/permission.entity';
import { PolicyState } from './entities/policy-state.entity';
import { RoleGrant } from './entities/role-grant.entity';
import { Role } from './entities/role.entity';
import { UserRole } from './entities/user-role.entity';
import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacAdminController } from './rbac-admin.controller';
import { RbacAdminService } from './rbac-admin.service';
import { RbacAuditInterceptor } from './rbac-audit.interceptor';
import { RbacBootstrapService } from './rbac-bootstrap.service';
import { RbacGuard } from './rbac.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Role,
      Permission,
      RoleGrant,
      UserRole,
      PolicyState,
    ]),
  ],
  controllers: [RbacAdminController],
  providers: [
    PolicySnapshotService,
    RbacAdminService,
    RbacBootstrapService,
    DefaultRoleService,
    RbacGuard,
    RbacAuditInterceptor,
  ],
  /** `RbacGuard` and the snapshot are exported so other modules can protect routes. */
  exports: [PolicySnapshotService, RbacGuard, DefaultRoleService],
})
export class RbacModule {}
