import { invalidRequest } from '@/modules/auth/errors/auth.errors';
import multipart from '@fastify/multipart';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * True when some JSON object in `text` repeats a key (after unescaping).
 * Expects syntactically valid JSON: it only tracks strings, braces and commas.
 */
export function hasDuplicateKeys(text: string): boolean {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      const top = stack[stack.length - 1];
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (char === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',') {
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
    }
    i += 1;
  }
  return false;
}

/**
 * HTTP behavior shared by `main.ts` and the e2e tests: a JSON parser that
 * refuses a repeated key (the default keeps the last one silently) and
 * multipart support with a hard 5 MiB file limit, one file and no text fields.
 */
export async function setupHttp(app: NestFastifyApplication): Promise<void> {
  const adapter = app.getHttpAdapter() as unknown as FastifyAdapter;
  const fastify = adapter.getInstance();
  const { bodyLimit } = fastify.initialConfig;

  adapter.useBodyParser(
    'application/json',
    false,
    { bodyLimit },
    (req, body, done) => {
      const { onProtoPoisoning, onConstructorPoisoning } =
        fastify.initialConfig;
      const parse = fastify.getDefaultJsonParser(
        onProtoPoisoning || 'error',
        onConstructorPoisoning || 'error',
      );
      void parse(req, body as unknown as string, (error, parsed) => {
        if (error) return done(error, undefined);
        if (hasDuplicateKeys(body.toString('utf8'))) {
          return done(invalidRequest('Duplicate key in JSON body'), undefined);
        }
        return done(null, parsed);
      });
    },
  );
  adapter.useBodyParser(
    'application/x-www-form-urlencoded',
    false,
    { bodyLimit },
    (_req, body, done) => {
      done(
        null,
        Object.fromEntries(new URLSearchParams(body.toString('utf8'))),
      );
    },
  );

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 2 },
  });
}
