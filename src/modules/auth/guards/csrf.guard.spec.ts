import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ConfigService } from '@/core/config/config.service';

import { RECEIPT_HEADER_KEY } from '../decorators/receipt.decorator';
import { AuthAuditService } from '../services/auth-audit.service';
import { CsrfGuard } from './csrf.guard';

const TRUSTED = 'https://app.example.com';

class SampleController {
  handler(): void {}
}
const handler = (SampleController.prototype as { handler: () => void }).handler;

function build(trusted = TRUSTED) {
  const config = { get: () => trusted };
  const audit = { warn: jest.fn() };
  const guard = new CsrfGuard(
    config as unknown as ConfigService,
    audit as unknown as AuthAuditService,
    new Reflector(),
  );
  return { guard, audit };
}

function contextFor(
  method: string,
  headers: Record<string, string> = {},
): ExecutionContext {
  const request = {
    method,
    id: 'req-1',
    protocol: 'https',
    headers: { host: 'api.example.com', ...headers },
  };
  return {
    getHandler: () => handler,
    getClass: () => SampleController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  describe('receipt-guarded route', () => {
    afterEach(() =>
      Reflect.defineMetadata(RECEIPT_HEADER_KEY, undefined, handler),
    );
    const crossOrigin = { origin: 'https://evil.test' };

    it('skips the check when the receipt header is present', () => {
      Reflect.defineMetadata(RECEIPT_HEADER_KEY, 'deletion-receipt', handler);
      const { guard, audit } = build();

      expect(
        guard.canActivate(
          contextFor('DELETE', { ...crossOrigin, 'deletion-receipt': 'abc' }),
        ),
      ).toBe(true);
      expect(audit.warn).not.toHaveBeenCalled();
    });

    it('still enforces CSRF when the receipt header is absent', () => {
      Reflect.defineMetadata(RECEIPT_HEADER_KEY, 'deletion-receipt', handler);
      const { guard } = build();

      expect(() =>
        guard.canActivate(contextFor('DELETE', crossOrigin)),
      ).toThrow(ForbiddenException);
    });
  });

  it('lets safe methods through', () => {
    const { guard } = build();

    expect(
      guard.canActivate(contextFor('GET', { origin: 'https://evil.test' })),
    ).toBe(true);
  });

  it('lets a request without an Origin header through', () => {
    const { guard } = build();

    expect(guard.canActivate(contextFor('POST'))).toBe(true);
  });

  it('lets a same-origin POST through without the custom header', () => {
    const { guard } = build();

    expect(
      guard.canActivate(
        contextFor('POST', { origin: 'https://api.example.com' }),
      ),
    ).toBe(true);
  });

  it('accepts the exact trusted origin with X-CSRF-Protection: 1', () => {
    const { guard } = build();

    expect(
      guard.canActivate(
        contextFor('POST', { origin: TRUSTED, 'x-csrf-protection': '1' }),
      ),
    ).toBe(true);
  });

  it.each([
    ['the header is missing', { origin: TRUSTED }],
    [
      'the header value is wrong',
      { origin: TRUSTED, 'x-csrf-protection': '0' },
    ],
    [
      'the origin is untrusted',
      { origin: 'https://evil.test', 'x-csrf-protection': '1' },
    ],
    [
      'the origin only starts like the trusted one',
      { origin: `${TRUSTED}.evil.test`, 'x-csrf-protection': '1' },
    ],
    ['the origin is "null"', { origin: 'null', 'x-csrf-protection': '1' }],
  ])('answers 403 csrf_rejected when %s', (_name, headers) => {
    const { guard, audit } = build();

    let error: unknown;
    try {
      guard.canActivate(contextFor('POST', headers));
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      statusCode: 403,
      code: 'csrf_rejected',
    });
    expect(audit.warn).toHaveBeenCalledWith(
      'csrf.rejected',
      expect.objectContaining({ requestId: 'req-1' }),
    );
  });

  it('rejects every cross-origin POST when no trusted origin is configured', () => {
    const { guard } = build('');

    expect(() =>
      guard.canActivate(
        contextFor('POST', { origin: TRUSTED, 'x-csrf-protection': '1' }),
      ),
    ).toThrow(ForbiddenException);
  });
});
