import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { SessionModule } from '@/modules/auth/session.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { ConvertController } from './controllers/convert.controller';
import { TextConvertersService } from './services/text-converters.service';

/** `POST /convert`, `GET /convert/formats`: CSV, JSON, XML and YAML conversions. */
@Module({
  imports: [TransformationsModule, SessionModule, RbacModule, AuthModule],
  controllers: [ConvertController],
  providers: [TextConvertersService, CsrfGuard],
})
export class TextFormatsModule {}
