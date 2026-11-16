import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  initializeTransactionalContext,
  StorageDriver,
} from 'typeorm-transactional';

import { AppModule } from '../src/core/app/app.module';

interface Operation {
  responses: Record<string, unknown>;
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
}

describe('Account deletion OpenAPI document (e2e)', () => {
  let app: NestFastifyApplication;
  let paths: Record<string, Record<string, Operation>>;
  let schemas: Record<string, unknown>;

  beforeAll(async () => {
    initializeTransactionalContext({ storageDriver: StorageDriver.AUTO });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('test').build(),
    );
    paths = document.paths as typeof paths;
    schemas = (document.components?.schemas ?? {}) as typeof schemas;
  });

  afterAll(async () => {
    await app.close();
  });

  const USER = '/users/{userId}';

  it.each([
    ['post', `${USER}/deletion-challenge`, ['202', '401', '403', '429', '503']],
    [
      'post',
      `${USER}/deletion-challenge/resend`,
      ['202', '400', '401', '403', '429'],
    ],
    [
      'post',
      `${USER}/deletion-confirm`,
      ['202', '400', '401', '403', '409', '429'],
    ],
    ['delete', USER, ['202', '401', '403', '404', '409']],
    ['get', `${USER}/deletion-status`, ['200', '403', '404', '429']],
  ])('documents %s %s with its responses', (method, path, codes) => {
    const operation = paths[path]?.[method];
    expect(operation).toBeDefined();
    for (const code of codes) {
      expect(operation.responses).toHaveProperty(code);
    }
  });

  it('documents the Idempotency-Key and Deletion-Receipt headers', () => {
    const confirm = paths[`${USER}/deletion-confirm`].post;
    expect(confirm.parameters).toContainEqual(
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }),
    );
    const status = paths[`${USER}/deletion-status`].get;
    expect(status.parameters).toContainEqual(
      expect.objectContaining({ name: 'Deletion-Receipt', in: 'header' }),
    );
  });

  it('documents the 403/409/429 outcomes of DELETE', () => {
    const remove = paths[USER].delete;
    for (const code of ['401', '403', '409', '429']) {
      expect(remove.responses).toHaveProperty(code);
    }
  });

  it('registers the response schemas', () => {
    for (const name of [
      'DeletionAcceptedDto',
      'DeletionStatusDto',
      'DeletionChallengeAcceptedDto',
      'ConfirmDeletionDto',
      'ResendDeletionDto',
    ]) {
      expect(schemas).toHaveProperty(name);
    }
  });
});
