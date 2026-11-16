import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { AuthAuditService } from '@/modules/auth/services/auth-audit.service';

import {
  accepted,
  newJobId,
  newTombstoneEmail,
  statusUrl,
  withDeletionDb,
} from './deletion-support';

describe('deletion support', () => {
  it('builds a path-only status URL', () => {
    expect(statusUrl('u-1')).toBe('/users/u-1/deletion-status');
  });

  it('creates 32-hex job ids and unique unroutable tombstones', () => {
    expect(newJobId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newJobId()).not.toBe(newJobId());
    const a = newTombstoneEmail();
    expect(a).toMatch(/^deleted-[0-9a-f]{32}@example\.invalid$/);
    expect(a).not.toBe(newTombstoneEmail());
  });

  it('projects a job without the receipt in the URL', () => {
    const body = accepted({
      id: 'a'.repeat(32),
      userId: 'u',
      status: 'queued',
    } as never);
    expect(body).toEqual({
      jobId: 'a'.repeat(32),
      statusUrl: '/users/u/deletion-status',
      status: 'queued',
    });
    expect(body.statusUrl).not.toContain(body.jobId);
  });

  describe('withDeletionDb', () => {
    const audit = { error: jest.fn() };
    const asAudit = audit as unknown as AuthAuditService;
    beforeEach(() => jest.clearAllMocks());

    it('returns the result', async () => {
      await expect(
        withDeletionDb(asAudit, () => Promise.resolve(7)),
      ).resolves.toBe(7);
    });

    it('keeps an HttpException', async () => {
      const error = new BadRequestException();
      await expect(
        withDeletionDb(asAudit, () => Promise.reject(error)),
      ).rejects.toBe(error);
      expect(audit.error).not.toHaveBeenCalled();
    });

    it('turns other failures into a logged 503', async () => {
      await expect(
        withDeletionDb(asAudit, () => Promise.reject(new Error('db'))),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(audit.error).toHaveBeenCalledWith(
        'users.deletion.database_unavailable',
      );
    });
  });
});
