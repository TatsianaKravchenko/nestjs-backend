import { Inject, Injectable } from '@nestjs/common';
import type { Readable } from 'stream';

import { ConfigService } from '@/core/config/config.service';
import {
  notFound,
  serviceUnavailable,
} from '@/modules/auth/errors/auth.errors';
import { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import { UserProfileDto } from '../dto/user-profile.dto';
import { PHOTO_STORAGE, type PhotoStorage } from '../storage/photo-storage';
import { hasServablePhoto, toUserProfile } from '../user-profile.projector';
import { UsersService } from '../users.service';
import type { ProfileScope } from './profile-rate-limiter.service';

export interface ReadContext {
  requestId: string;
  actorUserId: string;
  targetUserId: string;
}

/**
 * Profile and photo reads. Called only after the guards passed, so the target
 * is looked up strictly after authentication, `users@read`, and for foreign
 * ids `users@read_any`. Audit events carry ids, scope, result and duration
 * only: never email, display name, photo url/key, bytes or tokens.
 */
@Injectable()
export class UserProfileService {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuthAuditService,
    private readonly config: ConfigService,
    @Inject(PHOTO_STORAGE) private readonly storage: PhotoStorage,
  ) {}

  async getProfile(ctx: ReadContext): Promise<UserProfileDto> {
    const started = Date.now();
    const log = this.logger('profile.read', ctx, started);

    const row = await this.lookup(log, () =>
      this.users.findProfile(ctx.targetUserId),
    );
    if (!row) {
      log.warn('users.not_found', 'not_found', 404);
      throw notFound('User not found');
    }
    const profile = toUserProfile(row, this.publicBaseUrl());
    if (log.scope === 'foreign') log.info('users.read', 'success');
    return profile;
  }

  /** Streams the photo; the object is never buffered. */
  async getPhoto(ctx: ReadContext): Promise<Readable> {
    const started = Date.now();
    const log = this.logger('photo.read', ctx, started);

    const row = await this.lookup(log, () =>
      this.users.findPhotoRef(ctx.targetUserId),
    );
    // No photo, or deleting/deleted: no storage call.
    if (!row || !hasServablePhoto(row) || !row.photoKey) {
      log.warn('users.not_found', 'not_found', 404);
      throw notFound('Photo not found');
    }

    const result = await this.storage.read(row.photoKey);
    if (result.status === 'unavailable') {
      log.error('users.storage_unavailable', 'storage_unavailable');
      throw serviceUnavailable('Photo storage is temporarily unavailable');
    }
    if (result.status === 'not_found') {
      // The row points at an object that does not exist: a consistency fault.
      log.error('users.photo_object_missing', 'photo_object_missing');
      throw serviceUnavailable('Photo is temporarily unavailable');
    }
    if (log.scope === 'foreign') log.info('users.read', 'success');
    return result.stream;
  }

  private publicBaseUrl(): string {
    return (
      this.config.get('API_PUBLIC_URL') ||
      `http://localhost:${this.config.get('PORT')}`
    );
  }

  private async lookup<T>(
    log: ReturnType<UserProfileService['logger']>,
    query: () => Promise<T>,
  ): Promise<T> {
    try {
      return await query();
    } catch {
      log.error('users.database_unavailable', 'database_unavailable');
      throw serviceUnavailable();
    }
  }

  private logger(operation: string, ctx: ReadContext, started: number) {
    const scope: ProfileScope =
      ctx.actorUserId === ctx.targetUserId ? 'self' : 'foreign';
    const fields = (result: string, status?: number) => ({
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      operation,
      scope,
      // Allowed here: the lookup gate (authn, users@read, users@read_any) passed.
      targetUserId: ctx.targetUserId,
      result,
      ...(status ? { status } : {}),
      durationMs: Date.now() - started,
    });
    return {
      scope,
      info: (event: string, result: string) =>
        this.audit.info(event, fields(result)),
      warn: (event: string, result: string, status: number) =>
        this.audit.warn(event, fields(result, status)),
      error: (event: string, result: string) =>
        this.audit.error(event, fields(result, 503)),
    };
  }
}
