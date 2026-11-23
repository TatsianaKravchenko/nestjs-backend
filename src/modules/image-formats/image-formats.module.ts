import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { SessionModule } from '@/modules/auth/session.module';
import { RbacModule } from '@/modules/rbac/rbac.module';
import { TransformationsModule } from '@/modules/transformations/transformations.module';

import { ImageConvertController } from './controllers/image-convert.controller';
import { ImageConvertersService } from './services/image-converters.service';

/** `POST /images/convert`, `GET /images/convert/formats`: PNG, JPEG and SVG conversions. */
@Module({
  imports: [TransformationsModule, SessionModule, RbacModule, AuthModule],
  controllers: [ImageConvertController],
  providers: [ImageConvertersService, CsrfGuard],
})
export class ImageFormatsModule {}
