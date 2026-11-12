import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:public';

/**
 * Explicitly declares a route (or controller) as public: no access token or
 * RBAC check. Every route must be public or carry `@RequirePermission`.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
