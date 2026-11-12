import {
  Controller,
  Get,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';

import { RequirePermission } from '@/modules/rbac/rbac.decorators';

import { Public } from '../decorators/public.decorator';
import { AllowReceipt } from '../decorators/receipt.decorator';
import { RouteDeclarationValidator } from './route-declaration.validator';

@Public()
@Controller('open')
class OpenController {
  @Get()
  list() {}
}

@Controller('mixed')
class MixedController {
  @Get()
  @Public()
  health() {}

  @Post()
  @RequirePermission('things', 'create')
  create() {}

  @Post('receipt')
  @AllowReceipt('Thing-Receipt')
  @RequirePermission('things', 'delete')
  receipt() {}

  @Get('secret')
  forgotten() {}

  helper() {}
}

@Controller('conflict')
class ConflictController {
  @Get('a')
  @Public()
  @RequirePermission('things', 'read')
  publicWithPermission() {}

  @Get('b')
  @Public()
  @AllowReceipt('Thing-Receipt')
  publicWithReceipt() {}

  @Get('c')
  @AllowReceipt('Thing-Receipt')
  receiptOnly() {}

  @Get('d')
  @RequirePermission('Bad Name', 'read')
  badName() {}
}

@Public()
@Controller('classpublic')
class ClassPublicController {
  @Get()
  @RequirePermission('things', 'read')
  protectedInsidePublic() {}
}

function build(...controllers: (new () => object)[]) {
  const discovery = {
    getControllers: () =>
      controllers.map(
        (metatype) =>
          ({
            instance: new metatype(),
            metatype,
          }) as unknown as InstanceWrapper,
      ),
  } as unknown as DiscoveryService;
  return new RouteDeclarationValidator(
    discovery,
    new MetadataScanner(),
    new Reflector(),
  );
}

describe('RouteDeclarationValidator', () => {
  it('accepts public controllers and protected handlers', () => {
    const validator = build(OpenController);
    expect(validator.findInvalid()).toEqual([]);
    expect(() => validator.onApplicationBootstrap()).not.toThrow();
  });

  it('skips providers that are not instantiated controllers', () => {
    const discovery = {
      getControllers: () => [
        { instance: null, metatype: OpenController },
        { instance: new OpenController(), metatype: null },
      ],
    } as unknown as DiscoveryService;
    const validator = new RouteDeclarationValidator(
      discovery,
      new MetadataScanner(),
      new Reflector(),
    );

    expect(validator.findInvalid()).toEqual([]);
  });

  it('accepts a receipt combined with one permission pair', () => {
    const invalid = build(MixedController).findInvalid();
    expect(invalid).not.toContain(expect.stringContaining('receipt'));
  });

  it('lists only undeclared HTTP routes (non-routes are ignored)', () => {
    expect(build(MixedController).findInvalid()).toEqual([
      'MixedController.forgotten: undeclared',
    ]);
  });

  it('rejects public combined with a permission, a receipt, or a receipt without permission', () => {
    expect(build(ConflictController).findInvalid()).toEqual([
      'ConflictController.publicWithPermission: public_conflict',
      'ConflictController.publicWithReceipt: public_conflict',
      'ConflictController.receiptOnly: receipt_without_permission',
      'ConflictController.badName: invalid_permission_name',
    ]);
  });

  it('rejects a protected handler inside a public controller', () => {
    expect(build(ClassPublicController).findInvalid()).toEqual([
      'ClassPublicController.protectedInsidePublic: public_conflict',
    ]);
  });

  it('aborts bootstrap with 503 authorization_unavailable', () => {
    let error: unknown;
    try {
      build(ConflictController).onApplicationBootstrap();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'authorization_unavailable',
    });
  });
});
