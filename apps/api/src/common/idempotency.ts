import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { stableStringify } from './stable-json';

const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const TX = { maxWait: 10_000, timeout: 20_000 };

/** Header Idempotency-Key of a staff request (8–128 chars) or 400. */
export function requireIdempotencyKey(key: string | undefined): string {
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Header Idempotency-Key (8-128 chars) is required' });
  }
  return key;
}

/**
 * Exactly once per (employee, scope, Idempotency-Key) — the same mechanism as order creation: the key row is
 * inserted first in the transaction, a parallel duplicate waits on the unique index and then gets the stored
 * answer; a failed attempt frees the key. The same key with another body -> 422.
 * `onUniqueConflict` turns a unique violation that is NOT the key (e.g. a unique business number) into an answer.
 */
export async function runIdempotent<T extends object>(
  prisma: PrismaService,
  opts: { scope: string; staffId: string; key: string; request: object; onUniqueConflict?: () => never },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T & { replayed: boolean }> {
  const key = `staff:${opts.staffId}:${opts.scope}:${opts.key}`;
  const requestHash = createHash('sha256').update(stableStringify(opts.request)).digest('hex');
  const replay = (row: { request_hash: string; response_json: Prisma.JsonValue }) => {
    if (row.request_hash !== requestHash) {
      throw new UnprocessableEntityException({ code: 'IDEMPOTENCY_KEY_REUSED', message: 'This Idempotency-Key was already used with a different request' });
    }
    if (!row.response_json) throw new ConflictException({ code: 'REQUEST_IN_PROGRESS', message: 'The same request is still being processed' });
    return { ...(row.response_json as T), replayed: true };
  };
  const existing = await prisma.idempotency_keys.findUnique({ where: { key } });
  if (existing) return replay(existing);
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.idempotency_keys.create({ data: { key, scope: opts.scope, request_hash: requestHash, expires_at: new Date(Date.now() + IDEMPOTENCY_TTL_MS) } });
      const res = await fn(tx);
      await tx.idempotency_keys.update({ where: { key }, data: { response_json: res as Prisma.InputJsonObject } });
      return res;
    }, TX);
    return { ...result, replayed: false };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const row = await prisma.idempotency_keys.findUnique({ where: { key } });
      if (row) return replay(row);
      opts.onUniqueConflict?.();
    }
    throw e;
  }
}
