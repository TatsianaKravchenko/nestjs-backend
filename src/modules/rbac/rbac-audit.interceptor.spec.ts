import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, Observable, of, throwError } from 'rxjs';

import { PolicySnapshotService } from './policy-snapshot.service';
import { RbacAuditInterceptor } from './rbac-audit.interceptor';
import type { AuditMetadata } from './rbac.types';

function build(audit: AuditMetadata | undefined) {
  const reflector = { get: jest.fn().mockReturnValue(audit) };
  const policy = { version: 4 };
  const request = {
    id: 'req-1',
    user: { id: 'admin-1' },
    params: { id: 'role-1' },
    body: { name: 'secret-name', description: 'private text' },
    headers: { cookie: 'access_token=jwt' },
  };
  const context = {
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const interceptor = new RbacAuditInterceptor(
    reflector as unknown as Reflector,
    policy as unknown as PolicySnapshotService,
  );
  return { interceptor, context, request };
}

const audit: AuditMetadata = { entityType: 'role', operation: 'replace' };
const handler = (result: Observable<unknown>) =>
  ({ handle: () => result }) as CallHandler;

describe('RbacAuditInterceptor', () => {
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('logs a successful write with actor, entity and policy version', async () => {
    const { interceptor, context } = build(audit);

    await lastValueFrom(
      interceptor.intercept(context, handler(of({ id: 'role-1' }))),
    );

    expect(log).toHaveBeenCalledWith({
      event: 'rbac.admin',
      actorId: 'admin-1',
      operation: 'replace',
      entityType: 'role',
      operationId: 'req-1',
      entityId: 'role-1',
      policyVersion: 4,
      result: 'success',
    });
  });

  it('takes the entity id from the response when the route has no id', async () => {
    const { interceptor, context, request } = build({
      entityType: 'role',
      operation: 'create',
    });
    request.params = {} as never;

    await lastValueFrom(
      interceptor.intercept(context, handler(of({ id: 'new-1' }))),
    );

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'new-1', operation: 'create' }),
    );
  });

  it('uses the userId route param as the entity id', async () => {
    const { interceptor, context, request } = build({
      entityType: 'user-roles',
      operation: 'replace',
    });
    request.params = { userId: 'user-9' } as never;

    await lastValueFrom(interceptor.intercept(context, handler(of({}))));

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'user-9' }),
    );
  });

  it('uses the userId route param for a rejected write', async () => {
    const { interceptor, context, request } = build(audit);
    request.params = { userId: 'user-9' } as never;

    await lastValueFrom(
      interceptor.intercept(context, {
        handle: () => throwError(() => new ConflictException()),
      }),
    ).catch(() => undefined);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'user-9', status: 409 }),
    );
  });

  it('logs an unexpected error as a 500 rejection and rethrows', async () => {
    const { interceptor, context } = build(audit);
    const error = new Error('boom');

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'rejected', status: 500 }),
    );
  });

  it('logs a rejected write with its status and rethrows', async () => {
    const { interceptor, context } = build(audit);
    const error = new ConflictException('nope');

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => error),
        }),
      ),
    ).rejects.toBe(error);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'rejected',
        status: 409,
        actorId: 'admin-1',
        entityId: 'role-1',
      }),
    );
  });

  it('logs unexpected errors as 500', async () => {
    const { interceptor, context } = build(audit);

    await expect(
      lastValueFrom(
        interceptor.intercept(context, {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status: 500 }));
  });

  it('never logs bodies, descriptions, cookies or tokens', async () => {
    const { interceptor, context } = build(audit);

    await lastValueFrom(
      interceptor.intercept(
        context,
        handler(of({ id: 'role-1', description: 'private text' })),
      ),
    );

    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/secret-name|private text|access_token|jwt/);
  });

  it('ignores routes that are not marked for audit', async () => {
    const { interceptor, context } = build(undefined);

    await lastValueFrom(interceptor.intercept(context, handler(of('ok'))));

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
