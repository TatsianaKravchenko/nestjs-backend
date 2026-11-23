import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'stream';

import {
  invalidRequest,
  payloadTooLarge,
  PROBLEM_DETAILS_SCHEMA,
} from '@/modules/auth/errors/auth.errors';
import {
  TRANSFORMATIONS_CONVERT_ACTION,
  TRANSFORMATIONS_PERMISSION,
} from '@/modules/rbac/rbac.constants';
import { RequirePermission } from '@/modules/rbac/rbac.decorators';
import type { RbacRequest } from '@/modules/rbac/rbac.types';
import { TransformationType } from '@/modules/transformations/entities/transformation.entity';
import { TransformationService } from '@/modules/transformations/services/transformation.service';
import { normalizeFormat } from '@/modules/transformations/utils/formats';

import {
  ImageConvertFieldsDto,
  OPTIONS_FIELD_MAX_LENGTH,
} from '../dto/image-convert-fields.dto';
import { ImageConvertersService } from '../services/image-converters.service';
import { parseImageOptions } from '../utils/image-options';
import { detectImageSource, readImageUpload } from '../utils/image-upload';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

class FormatDirection {
  source!: string;
  target!: string[];
}

/**
 * Check order: AccessTokenGuard (401, also an inactive user) -> CsrfGuard (403)
 * -> RbacGuard `transformations@convert` (403) -> multipart, extension and MIME
 * type (400/415) -> unsupported pair (415) -> options (400) -> the shared
 * pipeline: size limit (413), image content, pixel limits (400/413), timeout
 * (504), history (503). The file is not read before the guards pass.
 */
@ApiTags('images')
@ApiCookieAuth('access_token')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@convert, or CSRF check failed.')
@Controller('images/convert')
@RequirePermission(TRANSFORMATIONS_PERMISSION, TRANSFORMATIONS_CONVERT_ACTION)
export class ImageConvertController {
  constructor(
    private readonly transformations: TransformationService,
    private readonly converters: ImageConvertersService,
  ) {}

  @Get('formats')
  @ApiOperation({ summary: 'Supported image conversions' })
  @ApiOkResponse({ type: [FormatDirection] })
  formats(): { source: string; target: string[] }[] {
    return this.converters.formats();
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Convert PNG, JPEG or SVG to PNG or JPEG',
    description:
      'Multipart body; `targetFormat`, `options`, `save` and `file` may come in any order. ' +
      'The source format comes from the file extension (.png, .jpg, .jpeg, .svg). ' +
      '`options` is a JSON object: `quality` (1-100, default 85) and `background` ' +
      '(#RRGGBB, default #ffffff) only for a jpeg target; `width` and `height` ' +
      '(1-4096) only for an svg source. The result carries no metadata.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['targetFormat', 'file'],
      properties: {
        targetFormat: { type: 'string', enum: ['png', 'jpeg'] },
        options: { type: 'string', example: '{"quality":85}' },
        save: { type: 'string', enum: ['true', 'false'] },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({
    description: 'The converted image (`converted.<ext>`).',
    content: { 'image/png': {}, 'image/jpeg': {} },
  })
  @problem(400, 'Corrupt file, unsafe SVG, invalid or unknown options.')
  @problem(413, 'The file exceeds the size or the pixel limit.')
  @problem(415, 'Unsupported direction, extension or MIME type.')
  @problem(503, 'History or temporary storage unavailable.')
  @problem(504, 'The conversion did not finish in 30 seconds.')
  async convert(
    @Req() request: RbacRequest & FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const startedAt = new Date();
    const requestId = String(request.id);
    // Set by AccessTokenGuard; the guards guarantee it is present here.
    const userId = request.user?.id ?? '';

    const {
      fields: raw,
      file,
      violation,
    } = await readImageUpload(request, this.converters.maxInputBytes);
    if (file.truncated) {
      throw payloadTooLarge('The file exceeds the size limit');
    }
    const source = detectImageSource(file.filename, file.mimetype);
    if (violation) {
      await this.transformations.rejectAttempt(
        {
          requestId,
          userId,
          sourceFormat: source,
          targetFormat: raw['targetFormat'] ?? '',
          inputSize: file.data.length,
          startedAt,
          type: TransformationType.IMAGE,
        },
        'invalid_input',
      );
    }
    const fields = this.parseFields(raw);
    const target = normalizeFormat(fields.targetFormat);

    // An unsupported pair (raster -> svg, same format) is a 415 from the
    // pipeline; options are only meaningful, and checked, for a real direction.
    const params = this.converters.isSupported(source, target)
      ? parseImageOptions(fields.options, source, target)
      : {};

    const result = await this.transformations.convert({
      requestId,
      userId,
      sourceFormat: source,
      targetFormat: target,
      params,
      input: Readable.from([file.data]),
      save: fields.save === 'true',
    });

    void reply
      .status(200)
      .header('content-type', result.contentType)
      .header('content-length', result.size)
      .header(
        'content-disposition',
        `attachment; filename="converted.${result.extension}"`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .header('x-transformation-id', result.transformationId)
      .header('x-storage-status', result.storageStatus ?? 'none')
      .send(result.stream);
  }

  private parseFields(raw: Record<string, string>): ImageConvertFieldsDto {
    const dto = plainToInstance(ImageConvertFieldsDto, raw);
    if (
      validateSync(dto).length > 0 ||
      (dto.options?.length ?? 0) > OPTIONS_FIELD_MAX_LENGTH
    ) {
      throw invalidRequest('The file or the parameters are invalid');
    }
    return dto;
  }
}
