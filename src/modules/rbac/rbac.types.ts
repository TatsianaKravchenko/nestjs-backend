import type { FastifyRequest } from 'fastify';

/**
 * The authenticated principal. Authentication (task 1.2) sets `request.user`
 * from the access token; RBAC only reads the id and never trusts token roles.
 */
export interface AuthenticatedUser {
  id: string;
}

export type RbacRequest = FastifyRequest & { user?: AuthenticatedUser };

export interface RequiredPermission {
  permission: string;
  action: string;
}

export interface AuditMetadata {
  entityType: string;
  operation: 'create' | 'replace' | 'delete';
}
