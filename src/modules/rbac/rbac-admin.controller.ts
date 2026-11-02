import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { GrantDto } from './dto/grant.dto';
import { PermissionDto } from './dto/permission.dto';
import { RoleDto } from './dto/role.dto';
import { UserRolesDto } from './dto/user-roles.dto';
import { RbacAuditInterceptor } from './rbac-audit.interceptor';
import {
  GrantResponse,
  PermissionResponse,
  RbacAdminService,
  RoleResponse,
  UserRolesResponse,
} from './rbac-admin.service';
import { Audit, RequirePermission } from './rbac.decorators';
import { RBAC_MANAGE_ACTION, RBAC_PERMISSION } from './rbac.constants';

const uuid = () => new ParseUUIDPipe();

/** Every route needs `rbac@manage`, checked before the handler and before any lookup. */
@ApiTags('admin/rbac')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Missing, invalid or expired session.',
})
@ApiForbiddenResponse({ description: 'Missing rbac@manage.' })
@ApiBadRequestResponse({ description: 'Invalid id or body.' })
@ApiServiceUnavailableResponse({
  description: 'Policy or storage is unavailable.',
})
@Controller('admin/rbac')
@RequirePermission(RBAC_PERMISSION, RBAC_MANAGE_ACTION)
@UseInterceptors(RbacAuditInterceptor)
export class RbacAdminController {
  constructor(private readonly admin: RbacAdminService) {}

  /* ---------------------------------- roles --------------------------------- */

  @Get('roles')
  @ApiOperation({ summary: 'List roles' })
  listRoles(): Promise<RoleResponse[]> {
    return this.admin.listRoles();
  }

  @Get('roles/:id')
  @ApiOperation({ summary: 'Get a role' })
  @ApiNotFoundResponse({ description: 'Role not found.' })
  getRole(@Param('id', uuid()) id: string): Promise<RoleResponse> {
    return this.admin.getRole(id);
  }

  @Post('roles')
  @Audit('role', 'create')
  @ApiOperation({ summary: 'Create a role' })
  @ApiConflictResponse({ description: 'Name is already in use.' })
  createRole(@Body() dto: RoleDto): Promise<RoleResponse> {
    return this.admin.createRole(dto);
  }

  @Put('roles/:id')
  @Audit('role', 'replace')
  @ApiOperation({ summary: 'Replace a role' })
  @ApiNotFoundResponse({ description: 'Role not found.' })
  @ApiConflictResponse({
    description: 'Name conflict or last rbac@manage holder.',
  })
  updateRole(
    @Param('id', uuid()) id: string,
    @Body() dto: RoleDto,
  ): Promise<RoleResponse> {
    return this.admin.updateRole(id, dto);
  }

  @Delete('roles/:id')
  @Audit('role', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a role without grants or users' })
  @ApiNotFoundResponse({ description: 'Role not found.' })
  @ApiConflictResponse({ description: 'Role is still in use.' })
  deleteRole(@Param('id', uuid()) id: string): Promise<void> {
    return this.admin.deleteRole(id);
  }

  /* ------------------------------- permissions ------------------------------ */

  @Get('permissions')
  @ApiOperation({ summary: 'List permissions' })
  listPermissions(): Promise<PermissionResponse[]> {
    return this.admin.listPermissions();
  }

  @Get('permissions/:id')
  @ApiOperation({ summary: 'Get a permission' })
  @ApiNotFoundResponse({ description: 'Permission not found.' })
  getPermission(@Param('id', uuid()) id: string): Promise<PermissionResponse> {
    return this.admin.getPermission(id);
  }

  @Post('permissions')
  @Audit('permission', 'create')
  @ApiOperation({ summary: 'Create a permission with its actions' })
  @ApiConflictResponse({ description: 'Name is already in use.' })
  createPermission(@Body() dto: PermissionDto): Promise<PermissionResponse> {
    return this.admin.createPermission(dto);
  }

  @Put('permissions/:id')
  @Audit('permission', 'replace')
  @ApiOperation({ summary: 'Replace a permission' })
  @ApiNotFoundResponse({ description: 'Permission not found.' })
  @ApiConflictResponse({
    description: 'Name conflict, action in use or last rbac@manage holder.',
  })
  updatePermission(
    @Param('id', uuid()) id: string,
    @Body() dto: PermissionDto,
  ): Promise<PermissionResponse> {
    return this.admin.updatePermission(id, dto);
  }

  @Delete('permissions/:id')
  @Audit('permission', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a permission without grants' })
  @ApiNotFoundResponse({ description: 'Permission not found.' })
  @ApiConflictResponse({ description: 'Permission is referenced by grants.' })
  deletePermission(@Param('id', uuid()) id: string): Promise<void> {
    return this.admin.deletePermission(id);
  }

  /* --------------------------------- grants --------------------------------- */

  @Get('grants')
  @ApiOperation({ summary: 'List grants' })
  listGrants(): Promise<GrantResponse[]> {
    return this.admin.listGrants();
  }

  @Get('grants/:id')
  @ApiOperation({ summary: 'Get a grant' })
  @ApiNotFoundResponse({ description: 'Grant not found.' })
  getGrant(@Param('id', uuid()) id: string): Promise<GrantResponse> {
    return this.admin.getGrant(id);
  }

  @Post('grants')
  @Audit('grant', 'create')
  @ApiOperation({
    summary: 'Grant actions of a permission to a role',
    description:
      'Omit actions (or send []) to grant all current and future actions.',
  })
  @ApiNotFoundResponse({ description: 'Role or permission not found.' })
  @ApiConflictResponse({ description: 'The role already has this grant.' })
  createGrant(@Body() dto: GrantDto): Promise<GrantResponse> {
    return this.admin.createGrant(dto);
  }

  @Put('grants/:id')
  @Audit('grant', 'replace')
  @ApiOperation({ summary: 'Replace a grant' })
  @ApiNotFoundResponse({ description: 'Grant, role or permission not found.' })
  @ApiConflictResponse({
    description: 'Duplicate pair or last rbac@manage holder.',
  })
  updateGrant(
    @Param('id', uuid()) id: string,
    @Body() dto: GrantDto,
  ): Promise<GrantResponse> {
    return this.admin.updateGrant(id, dto);
  }

  @Delete('grants/:id')
  @Audit('grant', 'delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a grant' })
  @ApiNotFoundResponse({ description: 'Grant not found.' })
  @ApiConflictResponse({ description: 'Last rbac@manage holder.' })
  deleteGrant(@Param('id', uuid()) id: string): Promise<void> {
    return this.admin.deleteGrant(id);
  }

  /* -------------------------------- user roles ------------------------------ */

  @Get('users/:userId/roles')
  @ApiOperation({ summary: "Get a user's role ids" })
  @ApiNotFoundResponse({ description: 'User not found.' })
  getUserRoles(
    @Param('userId', uuid()) userId: string,
  ): Promise<UserRolesResponse> {
    return this.admin.getUserRoles(userId);
  }

  @Put('users/:userId/roles')
  @Audit('user-roles', 'replace')
  @ApiOperation({
    summary: "Replace a user's roles",
    description: 'An empty list removes all access.',
  })
  @ApiNotFoundResponse({ description: 'User not found.' })
  @ApiConflictResponse({ description: 'Last rbac@manage holder.' })
  setUserRoles(
    @Param('userId', uuid()) userId: string,
    @Body() dto: UserRolesDto,
  ): Promise<UserRolesResponse> {
    return this.admin.setUserRoles(userId, dto.roleIds);
  }
}
