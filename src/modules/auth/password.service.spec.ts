import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and a per-password salt', async () => {
    const a = await service.hash('Passw0rd!');
    const b = await service.hash('Passw0rd!');

    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toContain('Passw0rd!');
    expect(a).not.toEqual(b);
  });

  it('verifies correct and incorrect passwords', async () => {
    const hash = await service.hash('Passw0rd!');

    await expect(service.verify(hash, 'Passw0rd!')).resolves.toBe(true);
    await expect(service.verify(hash, 'Passw0rd?')).resolves.toBe(false);
  });
});
