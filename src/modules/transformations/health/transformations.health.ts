import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { DataSource } from 'typeorm';

import { Permission } from '@/modules/rbac/entities/permission.entity';
import { Role } from '@/modules/rbac/entities/role.entity';
import {
  DEFAULT_ROLE,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';

import { TempStorageService } from '../services/temp-storage.service';

/**
 * Readiness of the transformations module: the default `user` role exists (the
 * permission cannot be granted without it), the `transformations` permission is
 * registered, and the private temp area is writable.
 */
@Injectable()
export class TransformationsReadinessIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly dataSource: DataSource,
    private readonly temp: TempStorageService,
  ) {}

  async check(key = 'transformations'): Promise<HealthIndicatorResult> {
    const session = this.indicators.check(key);
    try {
      if (
        !(await this.dataSource.manager.existsBy(Role, { name: DEFAULT_ROLE }))
      ) {
        return session.down({ message: 'The default user role is missing' });
      }
      if (
        !(await this.dataSource.manager.existsBy(Permission, {
          name: TRANSFORMATIONS_PERMISSION,
        }))
      ) {
        return session.down({
          message: 'The transformations permission is not registered',
        });
      }
    } catch {
      return session.down({ message: 'Policy data is unavailable' });
    }
    return (await this.temp.probe())
      ? session.up()
      : session.down({ message: 'The temporary area is not writable' });
  }
}
