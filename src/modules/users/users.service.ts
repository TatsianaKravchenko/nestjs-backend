import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';

import { User } from './entities/user.entity';
import type { PhotoRow, ProfileRow } from './user-profile.projector';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  /** Emails are compared and stored trimmed and lowercased. */
  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Only what an authentication check needs: the id and the status. */
  findAuthState(id: string): Promise<Pick<User, 'id' | 'status'> | null> {
    return this.users.findOne({
      where: { id },
      select: { id: true, status: true },
    });
  }

  /** Profile read: only the allow-listed columns are selected. */
  findProfile(id: string): Promise<ProfileRow | null> {
    // Ids are uuids: any other well-formed id cannot exist (and would make the query fail).
    if (!isUUID(id)) return Promise.resolve(null);
    return this.users.findOne({
      where: { id },
      select: {
        id: true,
        email: true,
        displayName: true,
        photoKey: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /** Photo read: id, status and the storage key only. */
  findPhotoRef(id: string): Promise<PhotoRow | null> {
    if (!isUUID(id)) return Promise.resolve(null);
    return this.users.findOne({
      where: { id },
      select: { id: true, status: true, photoKey: true },
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({
      where: { email: UsersService.normalizeEmail(email) },
    });
  }
}
