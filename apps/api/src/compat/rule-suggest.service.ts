import { Controller, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../staff/audit.service';
import { CurrentStaff, RequirePermission, StaffGuard, type StaffContext } from '../staff/staff-auth';
import { EnrichService, EnrichUnavailable } from './enrich.service';
import { RULES_SCHEMA, RULES_SYSTEM, checkRulesAnswer, rulesDataBlock } from './rule-suggest';

/**
 * D-78: «Предложить правила» for a substance (usually one just added from «Добавить из iHerb»): the model drafts a few
 * compatibility rules; they are saved as «черновик» (origin vitalo) and work only after an admin approves them.
 */
@Injectable()
export class RuleSuggestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrich: EnrichService,
    private readonly audit: AuditService,
  ) {}

  async suggest(me: StaffContext, substanceId: string, now = new Date()) {
    const dict = await this.prisma.substances.findMany({ select: { id: true, code: true, name_ru: true, synonyms: true, enabled: true, kind: true }, orderBy: [{ sort_order: 'asc' }, { name_ru: 'asc' }] });
    const target = dict.find((d) => d.id === substanceId);
    if (!target) throw new NotFoundException('Substance not found');
    const rules = await this.prisma.compat_rules.findMany({ where: { OR: [{ substance_a_id: substanceId }, { substance_b_id: substanceId }] }, select: { substance_a_id: true, substance_b_id: true } });
    const existing = new Set(rules.map((r) => (r.substance_a_id === substanceId ? r.substance_b_id : r.substance_a_id)));
    const examples = (await this.prisma.compat_rules.findMany({ where: { status: 'approved' }, orderBy: { approved_at: 'desc' }, take: 3, select: { text_ru: true } })).map((r) => r.text_ru);
    const s = await this.enrich.assertCanCall(now);
    const r = await this.enrich.callLogged(
      { scenario: 'rule_suggest', setKey: target.code, model: s.card_model, system: RULES_SYSTEM, data: rulesDataBlock(target, dict, existing, examples), schema: RULES_SCHEMA as never, maxTokens: 4000, timeoutMs: 60_000 },
      (json) => checkRulesAnswer(json, target, dict, existing),
    );
    if (!r.ok) throw new EnrichUnavailable('AI_FAILED', 'AI ответил не по форме, попробуйте ещё раз');
    const created = await this.prisma.$transaction(async (tx) => {
      const out: string[] = [];
      for (const x of r.value) {
        const row = await tx.compat_rules.create({
          data: {
            substance_a_id: target.id,
            substance_b_id: x.substance_b_id,
            kind: x.kind,
            interval_hours: x.interval_hours,
            when_a: x.when_a,
            when_b: x.when_b,
            time_a: x.time_a,
            meal_a: x.meal_a,
            time_b: x.time_b,
            meal_b: x.meal_b,
            text_ru: x.text_ru,
            text_uz: x.text_uz,
            source: x.source,
            origin: 'vitalo',
            status: 'draft',
          },
        });
        await this.audit.log({ staffId: me.staff.id, action: 'compat.rule_suggested', entityType: 'compat_rule', entityId: row.id, after: row }, tx);
        out.push(row.id);
      }
      return out;
    });
    return { created: created.length, cost_usd: Math.round(r.cost_usd * 10000) / 10000 };
  }
}

@ApiTags('staff: compat')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/compat')
export class RuleSuggestController {
  constructor(private readonly svc: RuleSuggestService) {}

  @Post('substances/:id/suggest-rules')
  @HttpCode(200)
  @RequirePermission('compat.answer')
  suggest(@CurrentStaff() me: StaffContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.suggest(me, id);
  }
}
