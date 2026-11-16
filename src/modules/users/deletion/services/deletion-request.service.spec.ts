import { HttpException } from '@nestjs/common';

import { ConfirmationMethod } from '@/modules/auth/entities/registration-attempt.entity';
import {
  bumpPolicyVersion,
  lockPolicyVersion,
} from '@/modules/rbac/policy-version';
import { hasActiveManageHolder } from '@/modules/rbac/rbac-invariant';

import { User, UserStatus } from '../../entities/user.entity';
import type { ConfirmDeletionDto } from '../dto/deletion.dto';
import {
  DeletionChallenge,
  DeletionChallengeConsumedReason,
} from '../entities/deletion-challenge.entity';
import {
  DeletionJob,
  DeletionJobStatus,
} from '../entities/deletion-job.entity';
import { hashDeletionSecret } from './deletion-challenge.service';
import { DeletionRequestService } from './deletion-request.service';

jest.mock('@/modules/rbac/policy-version', () => ({
  lockPolicyVersion: jest.fn(),
  bumpPolicyVersion: jest.fn(),
}));
jest.mock('@/modules/rbac/rbac-invariant', () => ({
  hasActiveManageHolder: jest.fn(),
}));

const USER_ID = '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44';
const OTHER_ID = '7a1c2d3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const CHALLENGE_ID = '0b9d6c3a-5e2f-4a7b-8c1d-2e3f4a5b6c7d';
const KEY = 'k'.repeat(48);
const JOB_ID = 'a'.repeat(32);
const NEW_JOB_ID = 'b'.repeat(32);
const CODE = '123456';
const EMAIL = 'someone@example.test';
const LINK_SECRET = 'S'.repeat(43);

const failure = async (promise: Promise<unknown>): Promise<HttpException> => {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a rejection');
};
const codeOf = async (promise: Promise<unknown>) => {
  const error = await failure(promise);
  return [
    error.getStatus(),
    (error.getResponse() as { code?: string }).code,
  ] as const;
};

const dto = (fields: Partial<ConfirmDeletionDto>): ConfirmDeletionDto =>
  Object.assign({}, fields) as ConfirmDeletionDto;
const otpDto = (code = CODE) => dto({ challengeId: CHALLENGE_ID, code });

describe('DeletionRequestService', () => {
  let user: User | null;
  let challenge: DeletionChallenge | null;
  let keyedJob: DeletionJob | null;
  let existingJob: DeletionJob | null;
  let affected: number;
  const builder = {
    delete: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    execute: jest.fn(),
  };
  const manager = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const dataSource = { transaction: jest.fn() };
  const audit = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const config = { get: () => KEY };
  const service = new DeletionRequestService(
    dataSource as never,
    config as never,
    audit as never,
  );

  const makeUser = (fields: Partial<User> = {}): User =>
    ({
      id: USER_ID,
      email: EMAIL,
      status: UserStatus.ACTIVE,
      ...fields,
    }) as User;
  const makeChallenge = (
    fields: Partial<DeletionChallenge> = {},
  ): DeletionChallenge =>
    ({
      id: CHALLENGE_ID,
      userId: USER_ID,
      method: ConfirmationMethod.OTP,
      secretHash: hashDeletionSecret(config as never, CHALLENGE_ID, CODE),
      attempts: 0,
      lastSentAt: new Date(),
      consumedAt: null,
      consumedReason: null,
      ...fields,
    }) as DeletionChallenge;
  const makeJob = (fields: Partial<DeletionJob> = {}): DeletionJob =>
    ({
      id: JOB_ID,
      userId: USER_ID,
      status: DeletionJobStatus.QUEUED,
      attempts: 0,
      leaseUntil: null,
      lastErrorCode: null,
      ...fields,
    }) as DeletionJob;

  beforeEach(() => {
    jest.resetAllMocks();
    user = makeUser();
    challenge = makeChallenge();
    keyedJob = null;
    existingJob = null;
    affected = 0;

    dataSource.transaction.mockImplementation((work: (m: unknown) => unknown) =>
      work(manager),
    );
    manager.findOne.mockImplementation(
      (entity: unknown, options: { where: { id?: string } }) => {
        if (entity === User) return Promise.resolve(user);
        if (entity === DeletionChallenge) return Promise.resolve(challenge);
        return Promise.resolve(options.where.id ? keyedJob : existingJob);
      },
    );
    manager.create.mockImplementation((_entity: unknown, fields: object) => ({
      ...fields,
    }));
    manager.save.mockImplementation((value: unknown) => Promise.resolve(value));
    manager.update.mockResolvedValue(undefined);
    manager.query.mockResolvedValue(undefined);
    manager.createQueryBuilder.mockReturnValue(builder);
    builder.delete.mockReturnValue(builder);
    builder.from.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    builder.execute.mockImplementation(() => Promise.resolve({ affected }));
    jest.mocked(hasActiveManageHolder).mockResolvedValue(false);
  });

  /** Nothing in the log may identify the user or reveal a secret. */
  afterEach(() => {
    const logged = JSON.stringify([
      audit.info.mock.calls,
      audit.warn.mock.calls,
      audit.error.mock.calls,
    ]);
    for (const secret of [
      USER_ID,
      OTHER_ID,
      CHALLENGE_ID,
      JOB_ID,
      NEW_JOB_ID,
      EMAIL,
      CODE,
      LINK_SECRET,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  describe('confirm', () => {
    const run = (body = otpDto(), jobId = NEW_JOB_ID) =>
      service.confirm({ userId: USER_ID, jobId }, body);

    it.each([
      ['an empty body', dto({})],
      ['a code without a challenge id', dto({ code: CODE })],
      ['a challenge id without a code', dto({ challengeId: CHALLENGE_ID })],
      ['a bad challenge id', dto({ challengeId: 'nope', code: CODE })],
      [
        'a token with a code',
        dto({ token: `${CHALLENGE_ID}.${LINK_SECRET}`, code: CODE }),
      ],
      ['a token without a dot', dto({ token: 'nodot' })],
      ['a token with a bad id', dto({ token: `x.${LINK_SECRET}` })],
      ['a token with a short secret', dto({ token: `${CHALLENGE_ID}.abc` })],
    ])(
      'rejects %s as malformed (400) without touching the database',
      async (_n, body) => {
        expect(await codeOf(run(body))).toEqual([400, 'invalid_confirmation']);
        expect(dataSource.transaction).not.toHaveBeenCalled();
        expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
          result: 'malformed',
        });
      },
    );

    it('accepts the deletion: job, deleting user, roles removed, challenges cancelled', async () => {
      affected = 2;

      const result = await run();

      expect(result).toEqual({
        jobId: NEW_JOB_ID,
        statusUrl: `/users/${USER_ID}/deletion-status`,
        status: DeletionJobStatus.QUEUED,
      });
      expect(lockPolicyVersion).toHaveBeenCalledTimes(1);
      const job = (manager.save.mock.calls as unknown[][])[0][0] as DeletionJob;
      expect(job).toMatchObject({
        id: NEW_JOB_ID,
        userId: USER_ID,
        status: DeletionJobStatus.QUEUED,
        attempts: 0,
        leaseUntil: null,
        lastErrorCode: null,
      });
      expect(job.tombstoneEmail).toMatch(
        /^deleted-[0-9a-f]{32}@example\.invalid$/,
      );
      expect(manager.update).toHaveBeenCalledWith(
        User,
        { id: USER_ID },
        { status: UserStatus.DELETING },
      );
      expect(builder.from).toHaveBeenCalledWith('user_roles');
      expect(bumpPolicyVersion).toHaveBeenCalledTimes(1);
      const tables = manager.query.mock.calls.map(
        (call: [string]) => /UPDATE (\w+)/.exec(call[0])?.[1],
      );
      expect(tables).toEqual([
        'registration_attempts',
        'login_attempts',
        'email_change_challenges',
        'deletion_challenges',
      ]);
      expect(challenge).toMatchObject({
        consumedReason: DeletionChallengeConsumedReason.CONFIRMED,
      });
      expect(challenge?.consumedAt).toBeInstanceOf(Date);
      expect(audit.info).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'accepted',
      });
    });

    it('does not bump the policy version when no role was assigned', async () => {
      affected = 0;
      await run();
      expect(bumpPolicyVersion).not.toHaveBeenCalled();
    });

    it('accepts a magic link token', async () => {
      challenge = makeChallenge({
        method: ConfirmationMethod.MAGIC_LINK,
        secretHash: hashDeletionSecret(
          config as never,
          CHALLENGE_ID,
          LINK_SECRET,
        ),
      });

      const result = await run(
        dto({ token: `${CHALLENGE_ID}.${LINK_SECRET}` }),
      );

      expect(result.jobId).toBe(NEW_JOB_ID);
    });

    it('returns the same job for a replay of the same key by the same user', async () => {
      keyedJob = makeJob({ id: NEW_JOB_ID });
      challenge = null;

      const result = await run();

      expect(result).toMatchObject({ jobId: NEW_JOB_ID, status: 'queued' });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('answers 409 when the key belongs to another user', async () => {
      keyedJob = makeJob({ id: NEW_JOB_ID, userId: OTHER_ID });

      expect(await codeOf(run())).toEqual([409, 'idempotency_key_conflict']);
      expect(manager.save).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'idempotency_conflict',
      });
    });

    it('answers 400 for an unknown challenge', async () => {
      challenge = null;
      expect(await codeOf(run())).toEqual([400, 'invalid_confirmation']);
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'not_found',
      });
    });

    it('answers 400 for a consumed challenge', async () => {
      challenge = makeChallenge({
        consumedAt: new Date(),
        consumedReason: DeletionChallengeConsumedReason.CONFIRMED,
      });
      expect(await codeOf(run())).toEqual([400, 'invalid_confirmation']);
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'consumed',
      });
    });

    it('answers 429 once the challenge was exhausted', async () => {
      challenge = makeChallenge({
        consumedAt: new Date(),
        consumedReason: DeletionChallengeConsumedReason.ATTEMPTS_EXHAUSTED,
      });
      expect(await codeOf(run())).toEqual([429, 'rate_limit_exceeded']);
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'exhausted',
      });
    });

    it('answers 400 for an expired challenge and leaves the counter alone', async () => {
      challenge = makeChallenge({
        lastSentAt: new Date(Date.now() - 601_000),
      });
      expect(await codeOf(run())).toEqual([400, 'invalid_confirmation']);
      expect(challenge?.attempts).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it.each([
      ['a blocked user', makeUser({ status: UserStatus.BLOCKED })],
      ['a deleting user', makeUser({ status: UserStatus.DELETING })],
      ['a missing user', null],
    ])('answers 401 for %s and spends the challenge', async (_n, value) => {
      user = value;
      expect(await codeOf(run())).toEqual([401, 'invalid_session']);
      expect(challenge).toMatchObject({
        consumedReason: DeletionChallengeConsumedReason.USER_INACTIVE,
      });
      expect(manager.save).toHaveBeenCalledWith(challenge);
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'user_inactive',
      });
    });

    it('answers 400 for a code sent to a magic link challenge', async () => {
      challenge = makeChallenge({ method: ConfirmationMethod.MAGIC_LINK });
      expect(await codeOf(run())).toEqual([400, 'invalid_confirmation']);
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'wrong_method',
      });
    });

    it('counts a wrong code and keeps the challenge open', async () => {
      expect(await codeOf(run(otpDto('000000')))).toEqual([
        400,
        'invalid_confirmation',
      ]);
      expect(challenge?.attempts).toBe(1);
      expect(challenge?.consumedAt).toBeNull();
      expect(manager.save).toHaveBeenCalledWith(challenge);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('consumes the challenge on the 5th wrong code (still 400)', async () => {
      challenge = makeChallenge({ attempts: 4 });
      expect(await codeOf(run(otpDto('000000')))).toEqual([
        400,
        'invalid_confirmation',
      ]);
      expect(challenge).toMatchObject({
        attempts: 5,
        consumedReason: DeletionChallengeConsumedReason.ATTEMPTS_EXHAUSTED,
      });
    });

    it('does not count a wrong magic link secret', async () => {
      challenge = makeChallenge({
        method: ConfirmationMethod.MAGIC_LINK,
        secretHash: hashDeletionSecret(
          config as never,
          CHALLENGE_ID,
          LINK_SECRET,
        ),
      });
      const wrong = dto({ token: `${CHALLENGE_ID}.${'W'.repeat(43)}` });

      expect(await codeOf(run(wrong))).toEqual([400, 'invalid_confirmation']);
      expect(challenge?.attempts).toBe(0);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('returns the existing job of the user and spends the challenge as job_exists', async () => {
      existingJob = makeJob({ id: JOB_ID, status: DeletionJobStatus.RUNNING });

      const result = await run();

      expect(result).toMatchObject({ jobId: JOB_ID, status: 'running' });
      expect(challenge).toMatchObject({
        consumedReason: DeletionChallengeConsumedReason.JOB_EXISTS,
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('answers 409 for the last active rbac@manage user', async () => {
      jest
        .mocked(hasActiveManageHolder)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      expect(await codeOf(run())).toEqual([409, 'last_access_manager']);
      expect(hasActiveManageHolder).toHaveBeenNthCalledWith(1, manager, {
        only: USER_ID,
      });
      expect(hasActiveManageHolder).toHaveBeenNthCalledWith(2, manager, {
        exclude: USER_ID,
      });
      expect(manager.update).not.toHaveBeenCalled();
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'rejected',
        status: 409,
      });
    });

    it('allows a manager when another active manager remains', async () => {
      jest.mocked(hasActiveManageHolder).mockResolvedValue(true);
      await expect(run()).resolves.toMatchObject({ jobId: NEW_JOB_ID });
    });

    it('answers 503 and logs the event only when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('connection lost'));

      expect(await codeOf(run())).toEqual([503, 'service_unavailable']);
      expect(audit.error).toHaveBeenCalledWith(
        'users.deletion.database_unavailable',
      );
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.confirm', {
        result: 'rejected',
        status: 503,
      });
    });
  });

  describe('deleteByAdmin', () => {
    it('answers 404 for a malformed id without a lookup of the user', async () => {
      expect(await codeOf(service.deleteByAdmin('not-a-uuid'))).toEqual([
        404,
        'not_found',
      ]);
      expect(manager.findOne).not.toHaveBeenCalledWith(User, expect.anything());
      expect(audit.warn).toHaveBeenCalledWith('users.deletion.admin_delete', {
        result: 'rejected',
        status: 404,
      });
    });

    it('answers 404 for an unknown user', async () => {
      user = null;
      expect(await codeOf(service.deleteByAdmin(USER_ID))).toEqual([
        404,
        'not_found',
      ]);
      expect(lockPolicyVersion).toHaveBeenCalledTimes(1);
    });

    it.each([UserStatus.PENDING, UserStatus.ACTIVE, UserStatus.BLOCKED])(
      'creates a job for a %s user',
      async (status) => {
        user = makeUser({ status });

        const result = await service.deleteByAdmin(USER_ID);

        expect(result).toMatchObject({
          statusUrl: `/users/${USER_ID}/deletion-status`,
          status: DeletionJobStatus.QUEUED,
        });
        expect(result.jobId).toMatch(/^[0-9a-f]{32}$/);
        expect(manager.update).toHaveBeenCalledWith(
          User,
          { id: USER_ID },
          { status: UserStatus.DELETING },
        );
        expect(audit.info).toHaveBeenCalledWith('users.deletion.admin_delete', {
          result: 'accepted',
        });
      },
    );

    it.each([
      DeletionJobStatus.QUEUED,
      DeletionJobStatus.RUNNING,
      DeletionJobStatus.SUCCEEDED,
    ])('returns the existing %s job unchanged', async (status) => {
      existingJob = makeJob({ status });
      user = makeUser({ status: UserStatus.DELETING });

      const result = await service.deleteByAdmin(USER_ID);

      expect(result).toMatchObject({ jobId: JOB_ID, status });
      expect(manager.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('queues a failed job again without a new tombstone', async () => {
      existingJob = makeJob({
        status: DeletionJobStatus.FAILED,
        attempts: 5,
        leaseUntil: new Date(),
        lastErrorCode: 'storage_unavailable',
      });
      user = makeUser({ status: UserStatus.DELETING });

      const result = await service.deleteByAdmin(USER_ID);

      expect(result).toMatchObject({ jobId: JOB_ID, status: 'queued' });
      expect(existingJob).toMatchObject({
        status: DeletionJobStatus.QUEUED,
        attempts: 0,
        leaseUntil: null,
        lastErrorCode: null,
      });
      expect(existingJob.nextAttemptAt).toBeInstanceOf(Date);
      expect(manager.create).not.toHaveBeenCalled();
    });

    it.each([UserStatus.DELETING, UserStatus.DELETED])(
      'answers 503 and logs a consistency violation for a %s user without a job',
      async (status) => {
        user = makeUser({ status });
        expect(await codeOf(service.deleteByAdmin(USER_ID))).toEqual([
          503,
          'service_unavailable',
        ]);
        expect(manager.save).not.toHaveBeenCalled();
        expect(audit.error).toHaveBeenCalledWith(
          'users.deletion.consistency_violation',
          { result: 'missing_job' },
        );
      },
    );

    it('answers 409 for the last active rbac@manage user', async () => {
      jest
        .mocked(hasActiveManageHolder)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      expect(await codeOf(service.deleteByAdmin(USER_ID))).toEqual([
        409,
        'last_access_manager',
      ]);
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('allows deleting a manager while another one remains', async () => {
      jest.mocked(hasActiveManageHolder).mockResolvedValue(true);
      await expect(service.deleteByAdmin(USER_ID)).resolves.toMatchObject({
        status: 'queued',
      });
    });

    it('answers 503 when the database fails', async () => {
      dataSource.transaction.mockRejectedValue(new Error('down'));
      expect(await codeOf(service.deleteByAdmin(USER_ID))).toEqual([
        503,
        'service_unavailable',
      ]);
      expect(audit.error).toHaveBeenCalledWith(
        'users.deletion.database_unavailable',
      );
    });
  });
});
