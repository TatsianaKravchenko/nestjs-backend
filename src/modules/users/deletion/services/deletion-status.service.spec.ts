import { HttpException } from '@nestjs/common';

import {
  DeletionJob,
  DeletionJobStatus,
} from '../entities/deletion-job.entity';
import { DeletionStatusService } from './deletion-status.service';

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const RECEIPT = 'a'.repeat(32);

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const http = error as HttpException;
    return [
      http.getStatus(),
      (http.getResponse() as { code?: string }).code,
    ] as const;
  }
  throw new Error('expected a rejection');
};

describe('DeletionStatusService', () => {
  const repository = { findOne: jest.fn() };
  const dataSource = { getRepository: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new DeletionStatusService(
    dataSource as never,
    audit as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    dataSource.getRepository.mockReturnValue(repository);
  });

  describe('byReceipt', () => {
    it('returns the status of the job named by the receipt for this user', async () => {
      repository.findOne.mockResolvedValue({
        id: RECEIPT,
        status: DeletionJobStatus.RUNNING,
      });

      await expect(service.byReceipt(USER_ID, RECEIPT)).resolves.toBe(
        'running',
      );
      expect(dataSource.getRepository).toHaveBeenCalledWith(DeletionJob);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: RECEIPT, userId: USER_ID },
        select: { id: true, status: true },
      });
    });

    it.each([
      ['a malformed user id', 'not-a-uuid', RECEIPT],
      ['a short receipt', USER_ID, 'abc'],
      ['an upper-case receipt', USER_ID, 'A'.repeat(32)],
      ['a non-hex receipt', USER_ID, 'z'.repeat(32)],
      ['an empty receipt', USER_ID, ''],
    ])('answers 404 for %s without a lookup', async (_name, user, receipt) => {
      expect(await codeOf(service.byReceipt(user, receipt))).toEqual([
        404,
        'not_found',
      ]);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('answers the same 404 for an unknown or foreign receipt', async () => {
      repository.findOne.mockResolvedValue(null);
      expect(await codeOf(service.byReceipt(USER_ID, RECEIPT))).toEqual([
        404,
        'not_found',
      ]);
    });

    it('answers 503 when the database fails', async () => {
      repository.findOne.mockRejectedValue(new Error('down'));
      expect(await codeOf(service.byReceipt(USER_ID, RECEIPT))).toEqual([
        503,
        'service_unavailable',
      ]);
      expect(audit.error).toHaveBeenCalledWith(
        'users.deletion.database_unavailable',
      );
    });
  });

  describe('byUser', () => {
    it.each(Object.values(DeletionJobStatus))(
      'returns the %s status of the target job',
      async (status) => {
        repository.findOne.mockResolvedValue({ id: RECEIPT, status });

        await expect(service.byUser(USER_ID)).resolves.toBe(status);
        expect(repository.findOne).toHaveBeenCalledWith({
          where: { userId: USER_ID },
          select: { id: true, status: true },
        });
      },
    );

    it('answers 404 for a malformed id without a lookup', async () => {
      expect(await codeOf(service.byUser('not-a-uuid'))).toEqual([
        404,
        'not_found',
      ]);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('answers 404 when the user has no job', async () => {
      repository.findOne.mockResolvedValue(null);
      expect(await codeOf(service.byUser(USER_ID))).toEqual([404, 'not_found']);
    });
  });

  it('never logs ids or receipts', async () => {
    repository.findOne.mockResolvedValue(null);
    await codeOf(service.byReceipt(USER_ID, RECEIPT));
    const logged = JSON.stringify([
      audit.info.mock.calls,
      audit.warn.mock.calls,
      audit.error.mock.calls,
    ]);
    expect(logged).not.toContain(USER_ID);
    expect(logged).not.toContain(RECEIPT);
  });
});
