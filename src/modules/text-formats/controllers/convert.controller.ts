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
import { TransformationService } from '@/modules/transformations/services/transformation.service';

import {
  ConvertFieldsDto,
  FormatDirectionDto,
} from '../dto/convert-fields.dto';
import { TextConvertersService } from '../services/text-converters.service';
import { detectSource, readUpload } from '../utils/convert-upload';

const problem = (status: number, description: string) =>
  ApiResponse({
    status,
    description,
    content: { 'application/problem+json': { schema: PROBLEM_DETAILS_SCHEMA } },
  });

/**
 * Check order: AccessTokenGuard (401, also an inactive user) -> CsrfGuard (403)
 * -> RbacGuard `transformations@convert` (403) -> multipart, extension and MIME
 * type (400/415) -> the shared pipeline: size limit (413), parsing (400),
 * timeout (504), history (503). The file is not read before the guards pass.
 */
@ApiTags('convert')
@ApiCookieAuth('access_token')
@problem(401, 'Missing, invalid or expired session, or user is not active.')
@problem(403, 'Missing transformations@convert, or CSRF check failed.')
@Controller('convert')
@RequirePermission(TRANSFORMATIONS_PERMISSION, TRANSFORMATIONS_CONVERT_ACTION)
export class ConvertController {
  constructor(
    private readonly transformations: TransformationService,
    private readonly converters: TextConvertersService,
  ) {}

  @Get('formats')
  @ApiOperation({ summary: 'Supported text conversions (12 directions)' })
  @ApiOkResponse({ type: [FormatDirectionDto] })
  formats(): FormatDirectionDto[] {
    return this.converters.formats();
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Convert a CSV, JSON, XML or YAML file to another of these formats',
    description:
      'Multipart body; `targetFormat`, `save` and `file` may come in any order. ' +
      'The source format comes from the file extension ' +
      '(.csv, .json, .xml, .yaml, .yml).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['targetFormat', 'file'],
      properties: {
        targetFormat: { type: 'string', enum: ['csv', 'json', 'xml', 'yaml'] },
        save: { type: 'string', enum: ['true', 'false'] },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOkResponse({
    description: 'The converted file (`converted.<ext>`).',
    content: {
      'text/csv': {},
      'application/json': {},
      'application/xml': {},
      'application/yaml': {},
    },
  })
  @problem(400, 'Empty file, invalid syntax or encoding, invalid parameters.')
  @problem(413, 'The file or the result exceeds the size limit.')
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
    } = await readUpload(request, this.converters.maxInputBytes);
    if (file.truncated) {
      throw payloadTooLarge('The file exceeds the size limit');
    }
    const source = detectSource(file.filename, file.mimetype);
    if (violation) {
      // The file was read, so the attempt is recorded: as an error, never as
      // a success.
      await this.transformations.rejectAttempt(
        {
          requestId,
          userId,
          sourceFormat: source,
          targetFormat: raw['targetFormat'] ?? '',
          inputSize: file.data.length,
          startedAt,
        },
        'invalid_input',
      );
    }
    const fields = this.parseFields(raw, source);

    const result = await this.transformations.convert({
      requestId,
      userId,
      sourceFormat: source,
      targetFormat: fields.targetFormat,
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
      .header('x-save-status', result.saveStatus)
      .send(result.stream);
  }

  private parseFields(
    raw: Record<string, string>,
    source: string,
  ): ConvertFieldsDto {
    const dto = plainToInstance(ConvertFieldsDto, raw);
    if (validateSync(dto).length > 0) {
      throw invalidRequest('The file or the parameters are invalid');
    }
    if (dto.targetFormat.trim().toLowerCase() === source) {
      throw invalidRequest('targetFormat must differ from the source format');
    }
    return dto;
  }
}
