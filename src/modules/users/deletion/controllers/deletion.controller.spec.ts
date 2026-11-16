import { BadRequestException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { CookieService } from '@/modules/auth/services/cookie.service';
import type { RbacRequest } from '@/modules/rbac/rbac.types';

import type { ConfirmDeletionDto } from '../dto/deletion.dto';
import type { DeletionChallengeService } from '../services/deletion-challenge.service';
import type { DeletionRequestService } from '../services/deletion-request.service';
import { DeletionStatusController } from './deletion-status.controller';
import { DeletionController } from './deletion.controller';
import type { DeletionStatusService } from '../services/deletion-status.service';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const KEY = 'a'.repeat(32);
const request = { id: 'req-1' } as unknown as RbacRequest;

describe('DeletionController', () => {
  const challenges = { start: jest.fn(), resend: jest.fn() };
  const requests = { confirm: jest.fn(), deleteByAdmin: jest.fn() };
  const cookies = { clear: jest.fn() };
  const controller = new DeletionController(
    challenges as unknown as DeletionChallengeService,
    requests as unknown as DeletionRequestService,
    cookies as unknown as CookieService,
  );
  const reply = {} as FastifyReply;

  beforeEach(() => jest.resetAllMocks());

  it('delegates the challenge start and resend', async () => {
    challenges.start.mockResolvedValue({ challengeId: 'c' });
    challenges.resend.mockResolvedValue({ challengeId: 'c' });

    await controller.startChallenge(USER_ID, request);
    await controller.resendChallenge(USER_ID, { challengeId: 'c' }, request);

    expect(challenges.start).toHaveBeenCalledWith({
      requestId: 'req-1',
      userId: USER_ID,
    });
    expect(challenges.resend).toHaveBeenCalledWith(
      { requestId: 'req-1', userId: USER_ID },
      { challengeId: 'c' },
    );
  });

  it('confirms with the Idempotency-Key as job id and expires the cookies', async () => {
    const accepted = { jobId: KEY, statusUrl: '/x', status: 'queued' };
    requests.confirm.mockResolvedValue(accepted);
    const body = { challengeId: 'c', code: '123456' } as ConfirmDeletionDto;

    await expect(controller.confirm(USER_ID, KEY, body, reply)).resolves.toBe(
      accepted,
    );

    expect(requests.confirm).toHaveBeenCalledWith(
      { userId: USER_ID, jobId: KEY },
      body,
    );
    expect(cookies.clear).toHaveBeenCalledWith(reply);
  });

  it.each([undefined, '', 'short', 'A'.repeat(32), 'g'.repeat(32), [KEY]])(
    'refuses the Idempotency-Key %j (400) before anything runs',
    async (key) => {
      await expect(
        controller.confirm(USER_ID, key, {}, reply),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(requests.confirm).not.toHaveBeenCalled();
      expect(cookies.clear).not.toHaveBeenCalled();
    },
  );

  it('does not touch the cookies when the confirmation fails', async () => {
    requests.confirm.mockRejectedValue(new Error('boom'));
    await expect(controller.confirm(USER_ID, KEY, {}, reply)).rejects.toThrow(
      'boom',
    );
    expect(cookies.clear).not.toHaveBeenCalled();
  });

  it('delegates the administrator delete', async () => {
    requests.deleteByAdmin.mockResolvedValue({ jobId: KEY });
    await expect(controller.remove(USER_ID)).resolves.toEqual({ jobId: KEY });
    expect(requests.deleteByAdmin).toHaveBeenCalledWith(USER_ID);
  });
});

describe('DeletionStatusController', () => {
  const statuses = { byReceipt: jest.fn(), byUser: jest.fn() };
  const controller = new DeletionStatusController(
    statuses as unknown as DeletionStatusService,
  );
  const withHeaders = (headers: Record<string, unknown>) =>
    ({ headers }) as unknown as RbacRequest;

  beforeEach(() => jest.resetAllMocks());

  it('uses the receipt branch when the header is present', async () => {
    statuses.byReceipt.mockResolvedValue('running');
    await expect(
      controller.status(USER_ID, withHeaders({ 'deletion-receipt': KEY })),
    ).resolves.toEqual({ status: 'running' });
    expect(statuses.byReceipt).toHaveBeenCalledWith(USER_ID, KEY);
    expect(statuses.byUser).not.toHaveBeenCalled();
  });

  it('passes a repeated header as an empty (unknown) receipt', async () => {
    statuses.byReceipt.mockResolvedValue('queued');
    await controller.status(
      USER_ID,
      withHeaders({ 'deletion-receipt': [KEY, KEY] }),
    );
    expect(statuses.byReceipt).toHaveBeenCalledWith(USER_ID, '');
  });

  it('uses the administrator branch without a receipt', async () => {
    statuses.byUser.mockResolvedValue('failed');
    await expect(controller.status(USER_ID, withHeaders({}))).resolves.toEqual({
      status: 'failed',
    });
    expect(statuses.byUser).toHaveBeenCalledWith(USER_ID);
    expect(statuses.byReceipt).not.toHaveBeenCalled();
  });
});
