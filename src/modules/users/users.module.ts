import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EmailChangeChallenge } from './entities/email-change-challenge.entity';
import { StorageCleanupJob } from './entities/storage-cleanup-job.entity';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, EmailChangeChallenge, StorageCleanupJob]),
  ],
  providers: [UsersService],
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule {}
