import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from './entities/user.entity';

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

  findByEmail(email: string): Promise<User | null> {
    return this.users.findOne({
      where: { email: UsersService.normalizeEmail(email) },
    });
  }
}
