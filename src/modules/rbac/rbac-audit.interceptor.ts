import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, Observable, tap, throwError } from 'rxjs';

import { PolicySnapshotService } from './policy-snapshot.service';
import { AUDIT_KEY } from './rbac.constants';
import type { AuditMetadata, RbacRequest } from './rbac.types';

/**
 * Logs the outcome of admin writes: actor, operation, entity type and id,
 * policy version and result. Never logs bodies, descriptions, headers or tokens.
 * Guard denials (401/403) are logged by the guard itself.
 */
@Injectable()
export class RbacAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('RbacAudit');

  constructor(
    private readonly reflector: Reflector,
    private readonly policy: PolicySnapshotService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const audit = this.reflector.get<AuditMetadata | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    if (!audit) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RbacRequest>();
    const params = request.params as Record<string, string | undefined>;
    const base = {
      event: 'rbac.admin',
      actorId: request.user?.id,
      operation: audit.operation,
      entityType: audit.entityType,
      operationId: String(request.id),
    };

    return next.handle().pipe(
      tap((body) =>
        this.logger.log({
          ...base,
          entityId: params.id ?? params.userId ?? entityIdOf(body),
          policyVersion: this.policy.version,
          result: 'success',
        }),
      ),
      catchError((error: unknown) => {
        const status =
          error instanceof HttpException
            ? error.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;
        this.logger.warn({
          ...base,
          entityId: params.id ?? params.userId,
          policyVersion: this.policy.version,
          result: 'rejected',
          status,
        });
        return throwError(() => error);
      }),
    );
  }
}

function entityIdOf(body: unknown): string | undefined {
  const id = (body as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}
