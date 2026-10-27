import { Module } from '@nestjs/common';
import { ThrottlerModule as NestThrottlerModule } from '@nestjs/throttler';

import { ConfigModule } from '@/core/config/config.module';
import { ConfigService } from '@/core/config/config.service';

@Module({
  imports: [
    NestThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ttl = Number(config.get('THROTTLE_GLOBAL_TTL'));
        const limit = Number(config.get('THROTTLE_GLOBAL_LIMIT'));

        return [
          {
            name: 'default',
            ttl,
            limit,
          },
          {
            name: 'registration',
            ttl: Number(config.get('REGISTRATION_THROTTLE_TTL')),
            limit: Number(config.get('REGISTRATION_THROTTLE_LIMIT')),
          },
        ];
      },
    }),
  ],
  exports: [NestThrottlerModule],
})
export class ThrottlerModule {}
