import {
  StorageStatus,
  Transformation,
  TransformationStatus,
  TransformationType,
} from '../entities/transformation.entity';
import {
  type AttemptRecord,
  TransformationHistoryService,
} from './transformation-history.service';

const attempt: AttemptRecord = {
  id: '9b2f6a52-0f0c-4d1e-8a35-5b9e0f6c7a11',
  userId: '3f2b9c1e-6a1d-4c57-9a3f-0d2f7b1c8e44',
  type: TransformationType.FILE,
  sourceFormat: 'csv',
  targetFormat: 'json',
  status: TransformationStatus.SUCCESS,
  inputSize: 10,
  outputSize: 20,
  durationMs: 5,
  errorCode: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  completedAt: new Date('2026-01-01T00:00:01Z'),
};

describe('TransformationHistoryService', () => {
  const insert = jest.fn();
  const dataSource = {
    transaction: jest.fn((work: (m: { insert: jest.Mock }) => Promise<void>) =>
      work({ insert }),
    ),
  };
  const service = new TransformationHistoryService(dataSource as never);

  beforeEach(() => {
    insert.mockReset().mockResolvedValue(undefined);
  });

  it('writes exactly the metadata columns of the attempt in one transaction', async () => {
    await service.record(attempt);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(Transformation, {
      id: attempt.id,
      userId: attempt.userId,
      type: 'file',
      sourceFormat: 'csv',
      targetFormat: 'json',
      status: 'success',
      inputSize: 10,
      outputSize: 20,
      durationMs: 5,
      errorCode: null,
      createdAt: attempt.createdAt,
      storageStatus: StorageStatus.NOT_REQUESTED,
      storedFileKey: null,
      storageErrorCode: null,
      completedAt: attempt.completedAt,
    });
  });

  it('defaults to not_requested with no key', async () => {
    await service.record(attempt);

    expect(insert).toHaveBeenCalledWith(
      Transformation,
      expect.objectContaining({
        storageStatus: StorageStatus.NOT_REQUESTED,
        storedFileKey: null,
        storageErrorCode: null,
      }),
    );
  });

  it('writes the storage state of a save=true result in the same row', async () => {
    await service.record({
      ...attempt,
      storage: {
        status: StorageStatus.PENDING,
        key: 'opaque-key',
        errorCode: null,
      },
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      Transformation,
      expect.objectContaining({
        storageStatus: 'pending',
        storedFileKey: 'opaque-key',
        storageErrorCode: null,
      }),
    );
  });

  it('records an error attempt without output', async () => {
    await service.record({
      ...attempt,
      status: TransformationStatus.ERROR,
      outputSize: null,
      errorCode: 'timeout',
    });

    expect(insert).toHaveBeenCalledWith(
      Transformation,
      expect.objectContaining({
        status: 'error',
        outputSize: null,
        errorCode: 'timeout',
      }),
    );
  });

  it('lets a database failure through so the caller can answer 503', async () => {
    insert.mockRejectedValue(new Error('connection lost'));
    await expect(service.record(attempt)).rejects.toThrow('connection lost');
  });
});
