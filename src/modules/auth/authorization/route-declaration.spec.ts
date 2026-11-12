import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { declarationProblem, resolveAdmission } from './route-declaration';

const pair = { permission: 'users', action: 'read' };

describe('declarationProblem', () => {
  it.each([
    [{ isPublic: true }, undefined],
    [{ isPublic: false, permission: pair }, undefined],
    [
      { isPublic: false, permission: pair, receiptHeader: 'x-receipt' },
      undefined,
    ],
    [{ isPublic: false }, 'undeclared'],
    [{ isPublic: true, permission: pair }, 'public_conflict'],
    [{ isPublic: true, receiptHeader: 'x-receipt' }, 'public_conflict'],
    [
      { isPublic: false, receiptHeader: 'x-receipt' },
      'receipt_without_permission',
    ],
    [
      { isPublic: false, permission: { permission: 'Users', action: 'read' } },
      'invalid_permission_name',
    ],
  ])('%j -> %s', (declaration, expected) => {
    expect(declarationProblem(declaration)).toBe(expected);
  });
});

describe('resolveAdmission', () => {
  class Controller {
    handler(): void {}
  }
  const contextFor = (headers: object) =>
    ({
      getHandler: () =>
        (Controller.prototype as { handler: () => void }).handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => ({ id: 'r1', headers }) }),
    }) as unknown as ExecutionContext;

  it('treats an array header value as present', () => {
    Reflect.defineMetadata('rbac:required-permission', pair, Controller);
    Reflect.defineMetadata(
      'auth:receipt-header',
      'x-receipt',
      (Controller.prototype as { handler: () => void }).handler,
    );
    const reflector = new Reflector();

    expect(
      resolveAdmission(reflector, contextFor({ 'x-receipt': ['a'] })),
    ).toBe('receipt');
    expect(resolveAdmission(reflector, contextFor({}))).toBe('chain');
  });

  it('throws 503 for an undeclared handler', () => {
    class Bare {
      h(): void {}
    }
    const context = {
      getHandler: () => (Bare.prototype as { h: () => void }).h,
      getClass: () => Bare,
      switchToHttp: () => ({ getRequest: () => ({ id: 'r1', headers: {} }) }),
    } as unknown as ExecutionContext;

    expect(() => resolveAdmission(new Reflector(), context)).toThrow(
      ServiceUnavailableException,
    );
  });
});
