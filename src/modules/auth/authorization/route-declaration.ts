import { ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  NAME_PATTERN,
  REQUIRED_PERMISSION_KEY,
} from '@/modules/rbac/rbac.constants';
import type {
  RbacRequest,
  RequiredPermission,
} from '@/modules/rbac/rbac.types';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { RECEIPT_HEADER_KEY } from '../decorators/receipt.decorator';
import { authorizationUnavailable } from '../errors/auth.errors';

export interface RouteDeclaration {
  isPublic: boolean;
  permission?: RequiredPermission;
  receiptHeader?: string;
}

export type DeclarationProblem =
  | 'undeclared'
  | 'public_conflict'
  | 'receipt_without_permission'
  | 'invalid_permission_name';

type Target = Parameters<Reflector['get']>[1];

/** Handler metadata overrides controller metadata, per declaration kind. */
export function readDeclaration(
  reflector: Reflector,
  targets: Target[],
): RouteDeclaration {
  return {
    isPublic:
      reflector.getAllAndOverride<boolean | undefined>(
        IS_PUBLIC_KEY,
        targets,
      ) === true,
    permission: reflector.getAllAndOverride<RequiredPermission | undefined>(
      REQUIRED_PERMISSION_KEY,
      targets,
    ),
    receiptHeader: reflector.getAllAndOverride<string | undefined>(
      RECEIPT_HEADER_KEY,
      targets,
    ),
  };
}

/**
 * Exactly one of: public; one `permission@action`; a receipt together with
 * one `permission@action` (used when the receipt header is absent).
 */
export function declarationProblem(
  declaration: RouteDeclaration,
): DeclarationProblem | undefined {
  const { isPublic, permission, receiptHeader } = declaration;
  if (isPublic) {
    return permission || receiptHeader ? 'public_conflict' : undefined;
  }
  if (!permission) {
    return receiptHeader ? 'receipt_without_permission' : 'undeclared';
  }
  if (
    !NAME_PATTERN.test(permission.permission) ||
    !NAME_PATTERN.test(permission.action)
  ) {
    return 'invalid_permission_name';
  }
  return undefined;
}

export function operationName(context: ExecutionContext): string {
  return `${context.getClass().name}.${context.getHandler().name}`;
}

const logger = new Logger('AuthAudit');

/**
 * First step of the protected chain. Returns `receipt` when the declared
 * receipt header is present (access, user and RBAC checks are skipped), else
 * `chain`. An invalid declaration fails closed with 503 before anything runs.
 */
export function resolveAdmission(
  reflector: Reflector,
  context: ExecutionContext,
): 'receipt' | 'chain' {
  const declaration = readDeclaration(reflector, [
    context.getHandler(),
    context.getClass(),
  ]);
  const problem = declarationProblem(declaration);
  const request = context.switchToHttp().getRequest<RbacRequest>();
  if (problem) {
    logger.error({
      event: 'authorization.route_invalid',
      category: 'route_configuration',
      status: 503,
      problem,
      requestId: String(request.id),
      operation: operationName(context),
    });
    throw authorizationUnavailable();
  }
  return receiptPresent(declaration, request) ? 'receipt' : 'chain';
}

/** True when the route declares a receipt header and the request carries it. */
export function receiptPresent(
  declaration: RouteDeclaration,
  request: Pick<RbacRequest, 'headers'>,
): boolean {
  const header = declaration.receiptHeader;
  if (!header) return false;
  const value = request.headers[header];
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value);
}

/** Non-throwing check for guards that also run on public routes (CSRF). */
export function hasReceipt(
  reflector: Reflector,
  context: ExecutionContext,
): boolean {
  return receiptPresent(
    readDeclaration(reflector, [context.getHandler(), context.getClass()]),
    context.switchToHttp().getRequest<RbacRequest>(),
  );
}
