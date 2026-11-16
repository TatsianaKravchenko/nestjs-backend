import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';

import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';

import { User } from '../../entities/user.entity';
import { PHOTO_STORAGE, type PhotoStorage } from '../../storage/photo-storage';
import type { EraseResult, UserEraser } from './user-eraser';
import { UserEraserRegistry } from './user-eraser.registry';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** All challenge tables of a user; used by the eraser and the finalization. */
export async function deleteChallenges(
  manager: Queryable,
  userId: string,
): Promise<void> {
  for (const table of [
    'registration_attempts',
    'login_attempts',
    'email_change_challenges',
    'deletion_challenges',
  ]) {
    await manager.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }
}

/**
 * Deletes the profile photo object itself (a missing object is success). The
 * finalization only runs after this succeeded, and checks it once more.
 */
@Injectable()
export class PhotoEraser implements UserEraser, OnModuleInit {
  readonly store = 'users.photo';

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: UserEraserRegistry,
    @Inject(PHOTO_STORAGE) private readonly storage: PhotoStorage,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async erase(userId: string): Promise<EraseResult> {
    if (!isUUID(userId)) return { status: 'succeeded' };
    const user = await this.dataSource.getRepository(User).findOne({
      where: { id: userId },
      select: { id: true, photoKey: true },
    });
    const key = user?.photoKey;
    if (!key) return { status: 'succeeded' };
    const result = await this.storage.delete(key);
    return result === 'unavailable'
      ? { status: 'retryable_failure', code: 'storage_unavailable' }
      : { status: 'succeeded' };
  }
}

/** Deletes every pending registration, login, email change and deletion challenge. */
@Injectable()
export class ChallengeEraser implements UserEraser, OnModuleInit {
  readonly store = 'auth.challenges';

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: UserEraserRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async erase(userId: string): Promise<EraseResult> {
    await this.dataSource.transaction((manager) =>
      deleteChallenges(manager, userId),
    );
    return { status: 'succeeded' };
  }
}

/** Removes the role assignments (and bumps the policy version when some existed). */
@Injectable()
export class RoleEraser implements UserEraser, OnModuleInit {
  readonly store = 'rbac.roles';

  constructor(
    private readonly dataSource: DataSource,
    private readonly registry: UserEraserRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async erase(userId: string): Promise<EraseResult> {
    await this.dataSource.transaction(async (manager) => {
      await lockPolicyVersion(manager);
      const removed = await manager
        .createQueryBuilder()
        .delete()
        .from('user_roles')
        .where('user_id = :userId', { userId })
        .execute();
      if ((removed.affected ?? 0) > 0) await bumpPolicyVersion(manager);
    });
    return { status: 'succeeded' };
  }
}
