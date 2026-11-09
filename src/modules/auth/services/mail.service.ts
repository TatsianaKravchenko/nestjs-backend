import { Injectable } from '@nestjs/common';
import { createTransport, Transporter } from 'nodemailer';

import { ConfigService } from '@/core/config/config.service';

@Injectable()
export class MailService {
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  sendRegistrationOtp(email: string, code: string): Promise<void> {
    return this.send(
      email,
      'Confirm your registration',
      `Your confirmation code is ${code}. It expires in 10 minutes.`,
    );
  }

  sendRegistrationMagicLink(email: string, link: string): Promise<void> {
    return this.send(
      email,
      'Confirm your registration',
      `Open this link to continue: ${link}\nIt expires in 10 minutes and can be used once.`,
    );
  }

  sendLoginOtp(email: string, code: string): Promise<void> {
    return this.send(
      email,
      'Your sign-in code',
      `Your sign-in code is ${code}. It expires in 10 minutes. If this was not you, ignore this email.`,
    );
  }

  sendLoginMagicLink(email: string, link: string): Promise<void> {
    return this.send(
      email,
      'Your sign-in link',
      `Open this link to sign in: ${link}\nIt expires in 10 minutes and can be used once. If this was not you, ignore this email.`,
    );
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    const host = this.config.get('SMTP_HOST');
    if (!host) {
      throw new Error('SMTP is not configured');
    }

    const user = this.config.get('SMTP_USER');
    this.transporter ??= createTransport({
      host,
      port: Number(this.config.get('SMTP_PORT')),
      auth: user ? { user, pass: this.config.get('SMTP_PASSWORD') } : undefined,
    });

    await this.transporter.sendMail({
      from: this.config.get('SMTP_FROM'),
      to,
      subject,
      text,
    });
  }
}
