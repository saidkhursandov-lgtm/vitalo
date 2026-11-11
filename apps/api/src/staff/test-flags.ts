import { BadRequestException, Body, Controller, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { CurrentStaff, RequirePermission, StaffContext, StaffGuard } from './staff-auth';

/**
 * Аудит админки 10.11, п. 1.5: отметка «тестовый» у товара, бренда, закупки и клиента (у заказов она уже есть).
 * Тестовые записи не удаляются (правило проекта) — только скрываются в списках по умолчанию и не входят в сводки.
 * Ставит и снимает только администратор; каждое изменение — в журнале действий.
 */
export const TEST_FLAG_ENTITIES = ['product', 'brand', 'purchase', 'customer'] as const;
export type TestFlagEntity = (typeof TEST_FLAG_ENTITIES)[number];

export class TestFlagDto {
  @ApiProperty() @IsBoolean() is_test!: boolean;
}

@Injectable()
export class TestFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async set(staffId: string, entity: string, id: string, isTest: boolean) {
    if (!TEST_FLAG_ENTITIES.includes(entity as TestFlagEntity)) throw new BadRequestException({ code: 'BAD_ENTITY', message: 'Неизвестный вид записи' });
    return this.prisma.$transaction(async (tx) => {
      const table = {
        product: tx.products,
        brand: tx.brands,
        purchase: tx.purchases,
        customer: tx.users,
      }[entity as TestFlagEntity] as unknown as {
        findUnique(a: object): Promise<{ is_test: boolean } | null>;
        update(a: object): Promise<unknown>;
      };
      const row = await table.findUnique({ where: { id }, select: { is_test: true } });
      if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Запись не найдена' });
      if (row.is_test !== isTest) {
        await table.update({ where: { id }, data: { is_test: isTest } });
        await this.audit.log({ staffId, action: 'test_flag.set', entityType: entity, entityId: id, before: { is_test: row.is_test }, after: { is_test: isTest } }, tx);
      }
      return { entity, id, is_test: isTest };
    });
  }
}

@ApiTags('staff: test flags')
@ApiBearerAuth()
@UseGuards(StaffGuard)
@Controller('staff/test-flags')
export class TestFlagsController {
  constructor(private readonly flags: TestFlagsService) {}

  @Patch(':entity/:id')
  @HttpCode(200)
  @RequirePermission('test_flags.manage')
  set(@CurrentStaff() me: StaffContext, @Param('entity') entity: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: TestFlagDto) {
    return this.flags.set(me.staff.id, entity, id, dto.is_test);
  }
}
