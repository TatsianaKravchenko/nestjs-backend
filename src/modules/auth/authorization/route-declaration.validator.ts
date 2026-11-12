import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { authorizationUnavailable } from '../errors/auth.errors';
import { declarationProblem, readDeclaration } from './route-declaration';

/**
 * Fails closed at startup: every HTTP operation must be `@Public()`, carry
 * one `@RequirePermission`, or add `@AllowReceipt` to that pair. Undeclared,
 * conflicting (`@Public()` with a pair or receipt) and malformed declarations
 * abort bootstrap, so the application never becomes ready with a bad route.
 */
@Injectable()
export class RouteDeclarationValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteDeclarationValidator.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const invalid = this.findInvalid();
    if (invalid.length > 0) {
      this.logger.error({
        event: 'authorization.routes.invalid',
        category: 'route_configuration',
        status: 503,
        routes: invalid,
      });
      throw authorizationUnavailable();
    }
  }

  /** `Controller.handler: problem` for each HTTP route with a bad declaration. */
  findInvalid(): string[] {
    const invalid: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | null;
      const metatype = wrapper.metatype as (new () => object) | null;
      if (!instance || !metatype) continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, () => unknown>)[name];
        if (
          this.reflector.get<string | undefined>('path', handler) === undefined
        ) {
          continue; // not an HTTP route
        }
        const problem = declarationProblem(
          readDeclaration(this.reflector, [handler, metatype]),
        );
        if (problem) invalid.push(`${metatype.name}.${name}: ${problem}`);
      }
    }
    return invalid;
  }
}
