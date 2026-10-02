import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = Prisma.TransactionClient | PrismaService;

/** JSON-safe copy for audit/edit logs: BigInt -> number, Decimal/Date -> string. */
export function auditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
}

export interface AuditEntry {
  staffId: string;
  action: string; // e.g. "product.updated", "order.status_changed"
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Audit log: who / what / when / before / after (Master TZ §23). Written in the same transaction as the change. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.audit_logs.create({
      data: {
        staff_user_id: entry.staffId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId ?? null,
        before_json: entry.before === undefined ? Prisma.JsonNull : auditJson(entry.before),
        after_json: entry.after === undefined ? Prisma.JsonNull : auditJson(entry.after),
      },
    });
  }
}
