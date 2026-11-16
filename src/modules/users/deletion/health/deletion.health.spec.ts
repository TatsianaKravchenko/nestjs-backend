import type { HealthIndicatorService } from '@nestjs/terminus';

import type { ConfigService } from '@/core/config/config.service';

import type { UserEraserRegistry } from '../services/user-eraser.registry';
import { DeletionReadinessIndicator } from './deletion.health';

const KEY = 'd'.repeat(32);

function setup(env: Record<string, string>, missing: string[] = []) {
  const session = {
    up: jest.fn().mockReturnValue({ s: { status: 'up' } }),
    down: jest.fn().mockReturnValue({ s: { status: 'down' } }),
  };
  const indicators = { check: jest.fn().mockReturnValue(session) };
  const indicator = new DeletionReadinessIndicator(
    indicators as unknown as HealthIndicatorService,
    { get: (k: string) => env[k] } as unknown as ConfigService,
    { missing: () => missing } as unknown as UserEraserRegistry,
  );
  return { indicator, session };
}

describe('DeletionReadinessIndicator', () => {
  it('is up with its own 32-byte key', () => {
    const { indicator, session } = setup({
      DELETION_CHALLENGE_HMAC_KEY: KEY,
      JWT_ACCESS_SECRET: 'a'.repeat(32),
    });
    indicator.checkKey();
    expect(session.up).toHaveBeenCalled();
  });

  it.each([undefined, 'short'])('is down for the key %s', (value) => {
    const { indicator, session } = setup(
      value ? { DELETION_CHALLENGE_HMAC_KEY: value } : {},
    );
    indicator.checkKey();
    expect(session.down).toHaveBeenCalledWith({
      message: expect.stringContaining('missing or too short') as string,
    });
  });

  it('is down when the key equals another key', () => {
    const { indicator, session } = setup({
      DELETION_CHALLENGE_HMAC_KEY: KEY,
      EMAIL_CHANGE_HMAC_KEY: KEY,
    });
    indicator.checkKey();
    expect(session.down).toHaveBeenCalledWith({
      message: expect.stringContaining('own key') as string,
    });
  });

  it('is up when every data store has an eraser, down and named otherwise', () => {
    const ok = setup({});
    ok.indicator.checkErasers();
    expect(ok.session.up).toHaveBeenCalled();

    const bad = setup({}, ['billing.invoices', 'x']);
    bad.indicator.checkErasers();
    expect(bad.session.down).toHaveBeenCalledWith({
      message: 'No eraser for: billing.invoices, x',
    });
  });
});
