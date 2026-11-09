import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';

import { AccessTokenGuard } from '@/modules/auth/guards/access-token.guard';

import { AUDIT_KEY, REQUIRED_PERMISSION_KEY } from './rbac.constants';
import { RbacGuard } from './rbac.guard';
import type { AuditMetadata, RequiredPermission } from './rbac.types';

/**
 * Requires `permission@action` for the route. Permission and action are fixed
 * by the handler, never by the client. The access token is verified first
 * (it sets `request.user`); without a valid session the route answers 401,
 * without the permission, 403.
 */
export const RequirePermission = (permission: string, action: string) =>
  applyDecorators(
    SetMetadata(REQUIRED_PERMISSION_KEY, {
      permission,
      action,
    } satisfies RequiredPermission),
    UseGuards(AccessTokenGuard, RbacGuard),
  );

/** Marks an admin write so the audit interceptor logs its outcome. */
export const Audit = (
  entityType: AuditMetadata['entityType'],
  operation: AuditMetadata['operation'],
) => SetMetadata(AUDIT_KEY, { entityType, operation } satisfies AuditMetadata);
