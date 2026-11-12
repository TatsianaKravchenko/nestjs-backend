import { Controller, Get } from '@nestjs/common';

import { AccessTokenGuard } from '@/modules/auth/guards/access-token.guard';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';

import { RequirePermission } from './rbac.decorators';
import { RbacGuard } from './rbac.guard';

@Controller('x')
class Sample {
  @Get()
  @RequirePermission('things', 'read')
  read() {}
}

describe('RequirePermission', () => {
  it('runs access token, then CSRF, then RBAC', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      (Sample.prototype as { read: () => void }).read,
    ) as unknown[];
    expect(guards).toEqual([AccessTokenGuard, CsrfGuard, RbacGuard]);
  });
});
