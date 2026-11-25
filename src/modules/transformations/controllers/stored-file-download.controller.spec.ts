import 'reflect-metadata';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { FastifyReply } from 'fastify';
import { Readable } from 'stream';

import { AccessTokenGuard } from '@/modules/auth/guards/access-token.guard';
import { CsrfGuard } from '@/modules/auth/guards/csrf.guard';
import { REQUIRED_PERMISSION_KEY } from '@/modules/rbac/rbac.constants';
import { RbacGuard } from '@/modules/rbac/rbac.guard';

import { AdminStoredFileDownloadController } from './admin-stored-file-download.controller';
import { StoredFileDownloadController } from './stored-file-download.controller';

interface Sent {
  status?: number;
  headers: Record<string, unknown>;
  body?: unknown;
}

const reply = () => {
  const sent: Sent = { headers: {} };
  const chain = {
    status: (code: number) => {
      sent.status = code;
      return chain;
    },
    header: (name: string, value: unknown) => {
      sent.headers[name] = value;
      return chain;
    },
    send: (body: unknown) => {
      sent.body = body;
      return chain;
    },
  };
  return { reply: chain as unknown as FastifyReply, sent };
};

const FILE = {
  stream: Readable.from(['{}']),
  size: 2,
  contentType: 'application/json',
  extension: 'json',
};

describe('stored file download controllers', () => {
  const downloads = { open: jest.fn() };

  beforeEach(() => {
    downloads.open.mockReset().mockResolvedValue(FILE);
  });

  it('own route: the user is the authenticated actor, with no target', async () => {
    const controller = new StoredFileDownloadController(downloads as never);
    const { reply: res, sent } = reply();

    await controller.download(
      'item-1',
      { id: 'r1', user: { id: 'jwt-sub' } } as never,
      res,
    );

    expect(downloads.open).toHaveBeenCalledWith(
      { requestId: 'r1', actorUserId: 'jwt-sub' },
      'item-1',
    );
    expect(sent.status).toBe(200);
    expect(sent.headers).toEqual({
      'content-type': 'application/json',
      'content-length': 2,
      'content-disposition': 'attachment; filename="converted.json"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    expect(sent.body).toBe(FILE.stream);
  });

  it('admin route: the target comes from the path, the actor from the session', async () => {
    const controller = new AdminStoredFileDownloadController(
      downloads as never,
    );
    const { reply: res, sent } = reply();
    downloads.open.mockResolvedValue({
      ...FILE,
      contentType: 'image/png',
      extension: 'png',
    });

    await controller.download(
      'target-id',
      'item-1',
      { id: 'r2', user: { id: 'jwt-sub' } } as never,
      res,
    );

    expect(downloads.open).toHaveBeenCalledWith(
      { requestId: 'r2', actorUserId: 'jwt-sub', targetUserId: 'target-id' },
      'item-1',
    );
    expect(sent.headers).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'attachment; filename="converted.png"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  });

  it('passes an empty actor when the request has no user (the guards prevent it)', async () => {
    const controller = new StoredFileDownloadController(downloads as never);
    await controller.download('item-1', { id: 'r3' } as never, reply().reply);
    expect(downloads.open).toHaveBeenCalledWith(
      { requestId: 'r3', actorUserId: '' },
      'item-1',
    );
  });

  it('lets a service error through', async () => {
    downloads.open.mockRejectedValue(new Error('x'));
    const controller = new StoredFileDownloadController(downloads as never);
    await expect(
      controller.download('i', { id: 'r' } as never, reply().reply),
    ).rejects.toThrow('x');
  });

  it.each([
    [StoredFileDownloadController, 'download'],
    [AdminStoredFileDownloadController, 'download_any'],
  ])('%p requires transformations@%s', (controller, action) => {
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, controller)).toEqual({
      permission: 'transformations',
      action,
    });
  });

  it.each([StoredFileDownloadController, AdminStoredFileDownloadController])(
    '%p checks the session, CSRF and RBAC',
    (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
        AccessTokenGuard,
        CsrfGuard,
        RbacGuard,
      ]);
    },
  );
});
