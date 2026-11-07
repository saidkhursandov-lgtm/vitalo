/**
 * 08.11.2026: makes a copy of the catalog file for a database where the compatibility rules (and some substances) are
 * not there yet — the shop's server. The file keeps the codes of rules and substances from vitalo_dev; here:
 *   - a rule row with «Код правила» unknown in the database -> «Новое», code cleared;
 *   - every rule row -> «Одобрить: Да» (the owner's decision 08.11: approve all rules);
 *   - a substance row with «Код» unknown in the database -> «Новое», code cleared;
 *   - with --new-hidden: every new product («Новый») -> «Скрыт» (the owner's decision 08.11: new products without
 *     photos and stock are hidden on the server until the owner adds them and shows them in the admin).
 * Reads the database (only SELECT), writes only the new file. Then: npm run catalog:load -- --file <the copy>.
 *
 *   npm run catalog:for-server -- --file docs/content/X.xlsx --out docs/content/Y.xlsx [--new-hidden]
 */
import 'dotenv/config';
import ExcelJS from 'exceljs';
import { resolve } from 'path';
import { ACTION, PRODUCTS_SHEET, PRODUCT_STATUS, RULES_SHEET, RULE_ACTION, SUBSTANCES_SHEET, SUBSTANCE_ACTION } from '../src/import/catalog-master';
import { PrismaService } from '../src/prisma/prisma.service';

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const text = (v: unknown) => (v == null ? '' : typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v)).trim();

function columns(ws: ExcelJS.Worksheet) {
  for (let r = 1; r <= 6; r++) {
    const map = new Map<string, number>();
    ws.getRow(r).eachCell((c, n) => map.set(text(c.value).toLowerCase(), n));
    if ([...map.keys()].some((k) => k.startsWith('действие'))) {
      const find = (prefix: string) => [...map.entries()].find(([k]) => k.startsWith(prefix))?.[1];
      return { header: r, find };
    }
  }
  throw new Error(`${ws.name}: no header row with «Действие»`);
}

async function main() {
  const file = resolve(arg('--file') ?? '');
  const out = resolve(arg('--out') ?? '');
  if (!arg('--file') || !arg('--out') || file === out) throw new Error('--file <xlsx> --out <new xlsx> (different files)');
  const prisma = new PrismaService();
  try {
    const subCodes = new Set((await prisma.substances.findMany({ select: { code: true } })).map((s) => s.code));
    const ruleIds = new Set((await prisma.compat_rules.findMany({ select: { id: true } })).map((r) => r.id));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);

    const subs = wb.getWorksheet(SUBSTANCES_SHEET)!;
    const sc = columns(subs);
    const sCode = sc.find('код')!, sAction = sc.find('действие')!;
    const newSubs: string[] = [];
    for (let r = sc.header + 1; r <= subs.rowCount; r++) {
      const code = text(subs.getCell(r, sCode).value);
      if (code && !subCodes.has(code)) {
        subs.getCell(r, sCode).value = null;
        subs.getCell(r, sAction).value = SUBSTANCE_ACTION.create;
        newSubs.push(code);
      }
    }

    const rules = wb.getWorksheet(RULES_SHEET)!;
    const rc = columns(rules);
    const rId = rc.find('код правила')!, rAction = rc.find('действие')!, rApprove = rc.find('одобрить')!, rA = rc.find('вещество a')!;
    let made = 0, approved = 0;
    for (let r = rc.header + 1; r <= rules.rowCount; r++) {
      if (!text(rules.getCell(r, rA).value)) continue;
      const id = text(rules.getCell(r, rId).value);
      if (id && !ruleIds.has(id)) {
        rules.getCell(r, rId).value = null;
        rules.getCell(r, rAction).value = RULE_ACTION.create;
        made++;
      }
      if (text(rules.getCell(r, rApprove).value) !== 'Да') {
        rules.getCell(r, rApprove).value = 'Да';
        approved++;
      }
    }
    let hidden = 0;
    if (process.argv.includes('--new-hidden')) {
      const ps = wb.getWorksheet(PRODUCTS_SHEET)!;
      const pc = columns(ps);
      const pAction = pc.find('действие')!, pStatus = pc.find('статус')!;
      for (let r = pc.header + 1; r <= ps.rowCount; r++) {
        if (text(ps.getCell(r, pAction).value) !== ACTION.create) continue;
        if (text(ps.getCell(r, pStatus).value) !== PRODUCT_STATUS.hidden) hidden++;
        ps.getCell(r, pStatus).value = PRODUCT_STATUS.hidden;
      }
    }
    await wb.xlsx.writeFile(out);
    console.log(`Готово: ${out}`);
    console.log(`Вещества → «Новое»: ${newSubs.length}${newSubs.length ? ` (${newSubs.join(', ')})` : ''}`);
    console.log(`Правила → «Новое»: ${made}; «Одобрить» поставлено «Да»: ${approved}`);
    if (process.argv.includes('--new-hidden')) console.log(`Новые товары → «Скрыт»: ${hidden} (были «Активен»)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
