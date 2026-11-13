import { HttpException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { RbacRequest } from '@/modules/rbac/rbac.types';

import { UpdateUserDto } from '../dto/update-user.dto';
import { UsersMutationController } from './users-mutation.controller';

const TARGET = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const ACTOR = '9d1f2c3e-1111-4222-8333-444455556666';
const request = { id: 'req-7', user: { id: ACTOR } } as unknown as RbacRequest;
const context = {
  requestId: 'req-7',
  actorUserId: ACTOR,
  targetUserId: TARGET,
};

interface FakePart {
  type: 'file' | 'field';
  fieldname: string;
  mimetype?: string;
  toBuffer?: () => Promise<Buffer>;
}

const filePart = (
  fieldname = 'file',
  data = Buffer.from('bytes'),
): FakePart => ({
  type: 'file',
  fieldname,
  mimetype: 'image/png',
  toBuffer: () => Promise.resolve(data),
});

const multipart = (
  parts: FakePart[] | (() => AsyncGenerator<FakePart>),
): RbacRequest =>
  ({
    id: 'req-7',
    user: { id: ACTOR },
    isMultipart: () => true,
    parts:
      typeof parts === 'function'
        ? parts
        : async function* () {
            for (const part of parts) yield await Promise.resolve(part);
          },
  }) as unknown as RbacRequest;

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};

describe('UsersMutationController', () => {
  const updates = { update: jest.fn() };
  const emailChange = {
    start: jest.fn(),
    resend: jest.fn(),
    confirm: jest.fn(),
  };
  const photos = { replace: jest.fn(), clear: jest.fn() };
  const controller = new UsersMutationController(
    updates as never,
    emailChange as never,
    photos as never,
  );

  beforeEach(() => jest.resetAllMocks());

  describe('delegation', () => {
    it('PATCH passes the context and the validated body', async () => {
      const body = Object.assign(new UpdateUserDto(), { displayName: 'x' });
      updates.update.mockResolvedValue({ id: TARGET });

      await expect(controller.update(TARGET, body, request)).resolves.toEqual({
        id: TARGET,
      });
      expect(updates.update).toHaveBeenCalledWith(context, body);
    });

    it('email-change routes use the path user id as the acting user', async () => {
      const body = { newEmail: 'a@example.test' };
      emailChange.start.mockResolvedValue('started');
      emailChange.resend.mockResolvedValue('resent');
      emailChange.confirm.mockResolvedValue('confirmed');

      expect(await controller.startEmailChange(TARGET, body, request)).toBe(
        'started',
      );
      expect(
        await controller.resendEmailChange(
          TARGET,
          { challengeId: 'c' },
          request,
        ),
      ).toBe('resent');
      expect(
        await controller.confirmEmailChange(
          TARGET,
          { code: '123456' },
          request,
        ),
      ).toBe('confirmed');

      const expected = { requestId: 'req-7', userId: TARGET };
      expect(emailChange.start).toHaveBeenCalledWith(expected, body);
      expect(emailChange.resend).toHaveBeenCalledWith(expected, {
        challengeId: 'c',
      });
      expect(emailChange.confirm).toHaveBeenCalledWith(expected, {
        code: '123456',
      });
    });

    it('DELETE photo clears and returns nothing', async () => {
      photos.clear.mockResolvedValue(undefined);

      await expect(
        controller.deletePhoto(TARGET, request),
      ).resolves.toBeUndefined();
      expect(photos.clear).toHaveBeenCalledWith(context);
    });
  });

  describe('PUT photo upload parsing', () => {
    it('passes exactly one file part with its bytes and declared MIME', async () => {
      photos.replace.mockResolvedValue({ id: TARGET });
      const data = Buffer.from('image-bytes');

      const result = await controller.putPhoto(
        TARGET,
        multipart([filePart('file', data)]),
      );

      expect(result).toEqual({ id: TARGET });
      expect(photos.replace).toHaveBeenCalledWith(context, {
        data,
        mimetype: 'image/png',
      });
    });

    it('415 when the request is not multipart', async () => {
      const notMultipart = {
        id: 'req-7',
        user: { id: ACTOR },
        isMultipart: () => false,
      } as unknown as FastifyRequest as RbacRequest;

      const error = await failure(controller.putPhoto(TARGET, notMultipart));

      expect(error.getStatus()).toBe(415);
      expect(photos.replace).not.toHaveBeenCalled();
    });

    it('400 for a text field part', async () => {
      const error = await failure(
        controller.putPhoto(
          TARGET,
          multipart([{ type: 'field', fieldname: 'note' }]),
        ),
      );

      expect(error.getStatus()).toBe(400);
      expect(photos.replace).not.toHaveBeenCalled();
    });

    it('400 for a file under another field name', async () => {
      const error = await failure(
        controller.putPhoto(TARGET, multipart([filePart('avatar')])),
      );

      expect(error.getStatus()).toBe(400);
    });

    it('400 for a second file part', async () => {
      const error = await failure(
        controller.putPhoto(TARGET, multipart([filePart(), filePart()])),
      );

      expect(error.getStatus()).toBe(400);
      expect(photos.replace).not.toHaveBeenCalled();
    });

    it('400 when there is no file part', async () => {
      const error = await failure(controller.putPhoto(TARGET, multipart([])));

      expect(error.getStatus()).toBe(400);
    });

    it('413 when the file exceeds the limit', async () => {
      const tooLarge = {
        ...filePart(),
        toBuffer: () =>
          Promise.reject(
            Object.assign(new Error('limit'), {
              code: 'FST_REQ_FILE_TOO_LARGE',
            }),
          ),
      };

      const error = await failure(
        controller.putPhoto(TARGET, multipart([tooLarge])),
      );

      expect(error.getStatus()).toBe(413);
      expect(photos.replace).not.toHaveBeenCalled();
    });

    it.each([
      'FST_FILES_LIMIT',
      'FST_FIELDS_LIMIT',
      'FST_PARTS_LIMIT',
      'FST_INVALID_MULTIPART_CONTENT_TYPE',
    ])('400 when the parser reports %s', async (code) => {
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      const parts = async function* (): AsyncGenerator<FakePart> {
        throw Object.assign(new Error('limit'), { code });
      };

      const error = await failure(
        controller.putPhoto(TARGET, multipart(parts)),
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({
        message: 'Send exactly one file field named "file"',
      });
    });

    it('400 for any other parser failure (malformed multipart)', async () => {
      // eslint-disable-next-line @typescript-eslint/require-await, require-yield
      const parts = async function* (): AsyncGenerator<FakePart> {
        throw new Error('Unexpected end of form');
      };

      const error = await failure(
        controller.putPhoto(TARGET, multipart(parts)),
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({
        message: 'Malformed multipart body',
      });
    });
  });
});
