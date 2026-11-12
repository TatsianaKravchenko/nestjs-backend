import { createTransport } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';

import { MailService } from './mail.service';

jest.mock('nodemailer');

const sendMail = jest.fn().mockResolvedValue(undefined);
const mockedCreate = jest.mocked(createTransport);

function build(env: Record<string, string>) {
  return new MailService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('MailService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedCreate.mockReturnValue({ sendMail } as never);
  });

  it('fails when SMTP is not configured and sends nothing', async () => {
    await expect(
      build({}).sendLoginOtp('a@example.test', '123456'),
    ).rejects.toThrow('SMTP is not configured');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it.each([
    ['sendRegistrationOtp', '123456'],
    ['sendRegistrationMagicLink', 'https://app.test/confirm?t=1'],
    ['sendLoginOtp', '123456'],
    ['sendLoginMagicLink', 'https://app.test/login?t=1'],
  ] as const)(
    '%s sends one email containing the secret',
    async (method, secret) => {
      const mail = build({
        SMTP_HOST: 'smtp.test',
        SMTP_PORT: '587',
        SMTP_FROM: 'noreply@example.test',
      });

      await mail[method]('a@example.test', secret);

      expect(sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'noreply@example.test',
          to: 'a@example.test',
          text: expect.stringContaining(secret) as string,
        }),
      );
    },
  );

  it('authenticates only when a user is configured, and reuses the transport', async () => {
    const mail = build({
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'pass',
    });

    await mail.sendLoginOtp('a@example.test', '1');
    await mail.sendLoginOtp('a@example.test', '2');

    expect(mockedCreate).toHaveBeenCalledTimes(1);
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { user: 'user', pass: 'pass' } }),
    );
  });

  it('omits auth when no SMTP user is configured', async () => {
    await build({ SMTP_HOST: 'smtp.test', SMTP_PORT: '25' }).sendLoginOtp(
      'a@example.test',
      '1',
    );

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });
});
