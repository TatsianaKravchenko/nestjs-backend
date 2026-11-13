import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';

import { ConfigService } from '@/core/config/config.service';
import {
  notFound,
  serviceUnavailable,
  userStateConflict,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { UserProfileDto } from '../../dto/user-profile.dto';
import {
  StorageCleanupJob,
  StorageCleanupReason,
  StorageCleanupStatus,
} from '../../entities/storage-cleanup-job.entity';
import { User, UserStatus } from '../../entities/user.entity';
import { ImageNormalizer } from '../../photo/image-normalizer';
import { PHOTO_STORAGE, type PhotoStorage } from '../../storage/photo-storage';
import { toUserProfile } from '../../user-profile.projector';
import {
  LOCK,
  MutationContext,
  publicBaseUrl,
  withDb,
} from '../utils/profile-support';

export interface UploadedFile {
  data: Buffer;
  mimetype: string;
}

/** Opaque key: 192 random bits, no user id, no file name. */
export const newPhotoKey = (): string =>
  `${randomBytes(24).toString('base64url')}.webp`;

/**
 * Photo upload and removal. The object is written under a new key before the
 * database changes; the reference switch and the cleanup job for the old key
 * commit together. Logs carry ids and results only: never bytes, names or keys.
 */
@Injectable()
export class UserPhotoService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly normalizer: ImageNormalizer,
    private readonly audit: AuthAuditService,
    private readonly config: ConfigService,
    @Inject(PHOTO_STORAGE) private readonly storage: PhotoStorage,
  ) {}

  async replace(
    ctx: MutationContext,
    file: UploadedFile,
  ): Promise<UserProfileDto> {
    const log = this.fields(ctx, 'users.photo.upload');
    let normalized: Buffer;
    try {
      normalized = await this.normalizer.normalize(file.data, file.mimetype);
    } catch (error) {
      this.audit.warn('users.photo.rejected', {
        ...log,
        result: 'invalid_file',
        status: error instanceof HttpException ? error.getStatus() : 400,
      });
      throw error;
    }

    const key = newPhotoKey();
    try {
      await this.storage.write(key, normalized);
    } catch {
      this.audit.error('users.storage_unavailable', {
        ...log,
        result: 'storage_unavailable',
        status: 503,
      });
      throw serviceUnavailable('Photo storage is temporarily unavailable');
    }

    let outcome: { user: User; jobId?: string };
    try {
      outcome = await withDb(this.audit, ctx, () =>
        this.dataSource.transaction((manager) =>
          this.switchKey(manager, ctx, key),
        ),
      );
    } catch (error) {
      // The new object is unreferenced; the hourly sweep catches a failed delete.
      await this.storage.delete(key);
      this.audit.warn('users.photo.rejected', {
        ...log,
        result: 'rolled_back',
        status: error instanceof HttpException ? error.getStatus() : 503,
      });
      throw error;
    }

    this.audit.info('users.photo.uploaded', {
      ...log,
      result: outcome.jobId ? 'replaced' : 'created',
      ...(outcome.jobId ? { cleanupJobId: outcome.jobId } : {}),
    });
    return toUserProfile(outcome.user, publicBaseUrl(this.config));
  }

  async clear(ctx: MutationContext): Promise<void> {
    const log = this.fields(ctx, 'users.photo.clear');
    const jobId = await withDb(this.audit, ctx, () =>
      this.dataSource.transaction(async (manager) => {
        const user = await this.lockTarget(manager, ctx);
        if (!user.photoKey) return null;
        await manager.update(User, { id: user.id }, { photoKey: null });
        return this.enqueue(
          manager,
          user.photoKey,
          StorageCleanupReason.PHOTO_CLEARED,
        );
      }),
    );
    this.audit.info('users.photo.cleared', {
      ...log,
      result: jobId ? 'cleared' : 'unchanged',
      ...(jobId ? { cleanupJobId: jobId } : {}),
    });
  }

  private async switchKey(
    manager: EntityManager,
    ctx: MutationContext,
    key: string,
  ): Promise<{ user: User; jobId?: string }> {
    const user = await this.lockTarget(manager, ctx);
    const previous = user.photoKey;
    await manager.update(User, { id: user.id }, { photoKey: key });
    const jobId = previous
      ? await this.enqueue(
          manager,
          previous,
          StorageCleanupReason.PHOTO_REPLACED,
        )
      : undefined;
    return {
      user: await manager.findOneByOrFail(User, { id: user.id }),
      jobId,
    };
  }

  /** 404 for a missing target, 409 unless it is active or blocked. */
  private async lockTarget(
    manager: EntityManager,
    ctx: MutationContext,
  ): Promise<User> {
    const user = isUUID(ctx.targetUserId)
      ? await manager.findOne(User, {
          where: { id: ctx.targetUserId },
          lock: LOCK,
        })
      : null;
    if (!user) throw notFound('User not found');
    if (
      user.status !== UserStatus.ACTIVE &&
      user.status !== UserStatus.BLOCKED
    ) {
      throw userStateConflict();
    }
    return user;
  }

  private async enqueue(
    manager: EntityManager,
    objectKey: string,
    reason: StorageCleanupReason,
  ): Promise<string> {
    const job = await manager.save(
      manager.create(StorageCleanupJob, {
        objectKey,
        reason,
        status: StorageCleanupStatus.QUEUED,
        attempts: 0,
        nextAttemptAt: new Date(),
        lastErrorCode: null,
      }),
    );
    return job.id;
  }

  private fields(ctx: MutationContext, operation: string) {
    return {
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      targetUserId: ctx.targetUserId,
      operation,
    };
  }
}
