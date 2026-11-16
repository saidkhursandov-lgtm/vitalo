/**
 * 14.11.2026: forms of substances and the labels «Форма вещества» of products — the owner's decisions from
 * docs/content/VITALO_forms_review.xlsx (every row «да»; OZN-A068 without a label; A073 without vitamin E; A083 without
 * BCAA; «убихинол» out of Coenzyme Q10; the group records split into separate substances). Loaded by
 * `npm run compat:forms` (src/compat/forms-load.ts).
 */

export interface NewSubstance {
  code: string;
  kind: 'substance' | 'form';
  /** a form points at its substance: the rules and goals of the parent apply to it */
  parent?: string;
  name_ru: string;
  name_uz: string;
  synonyms: string[];
}

export interface SynonymChange {
  code: string;
  add?: string[];
  remove?: string[];
}

export interface ProductLabelPlan {
  /** substances in the label, in order (dictionary codes) */
  label: string[];
  /** a linked substance becomes its form */
  replace?: Record<string, string>;
  /** linked substances taken off */
  remove?: string[];
}

export const NEW_SUBSTANCES: NewSubstance[] = [
  // forms (sheet 1)
  { code: 'magnesium_citrate', kind: 'form', parent: 'magnesium', name_ru: 'Магний цитрат', name_uz: 'Magniy sitrat', synonyms: ['цитрат магния', 'магния цитрат', 'magnesium citrate', 'magniy sitrat'] },
  { code: 'magnesium_bisglycinate', kind: 'form', parent: 'magnesium', name_ru: 'Магний бисглицинат', name_uz: 'Magniy bisglitsinat', synonyms: ['бисглицинат магния', 'глицинат магния', 'хелат магния', 'magnesium bisglycinate', 'magnesium glycinate', 'magniy bisglitsinat'] },
  { code: 'zinc_picolinate', kind: 'form', parent: 'zinc', name_ru: 'Цинк пиколинат', name_uz: 'Sink pikolinat', synonyms: ['пиколинат цинка', 'цинка пиколинат', 'zinc picolinate'] },
  { code: 'chromium_picolinate', kind: 'form', parent: 'xrom', name_ru: 'Хром пиколинат', name_uz: 'Xrom pikolinat', synonyms: ['пиколинат хрома', 'хрома пиколинат', 'chromium picolinate'] },
  { code: 'iron_bisglycinate', kind: 'form', parent: 'iron', name_ru: 'Железо бисглицинат', name_uz: 'Temir bisglitsinat', synonyms: ['бисглицинат железа', 'ferrochel', 'феррохел', 'iron bisglycinate'] },
  { code: 'methylfolate', kind: 'form', parent: 'folate', name_ru: 'Метилфолат', name_uz: 'Metilfolat', synonyms: ['метилфолат', '5-мтгф', 'quatrefolic', 'methylfolate', 'l-methylfolate', '5-mthf'] },
  { code: 'ubiquinol', kind: 'form', parent: 'koenzim_q10', name_ru: 'Убихинол', name_uz: 'Ubixinol', synonyms: ['убихинол', 'ubiquinol', 'ubixinol', 'kaneka'] },
  { code: 'calcium_ascorbate', kind: 'form', parent: 'vitamin_c', name_ru: 'Аскорбат кальция', name_uz: 'Kalsiy askorbat', synonyms: ['аскорбат кальция', 'calcium ascorbate', 'буферизованный витамин c', 'buffered vitamin c'] },
  { code: 'creatine_monohydrate', kind: 'form', parent: 'creatine', name_ru: 'Креатин моногидрат', name_uz: 'Kreatin monogidrat', synonyms: ['креатин моногидрат', 'моногидрат креатина', 'creatine monohydrate', 'creapure'] },
  { code: 'marine_collagen', kind: 'form', parent: 'collagen', name_ru: 'Морской коллаген', name_uz: 'Dengiz kollageni', synonyms: ['морской коллаген', 'пептиды морского коллагена', 'гидролизат морского коллагена', 'marine collagen', 'fish collagen'] },
  { code: 'bovine_collagen', kind: 'form', parent: 'collagen', name_ru: 'Говяжий коллаген', name_uz: 'Mol kollageni', synonyms: ['говяжий коллаген', 'bovine collagen', 'beef collagen'] },
  { code: 'omega3_rtg', kind: 'form', parent: 'omega3', name_ru: 'Омега-3 rTG', name_uz: 'Omega-3 rTG', synonyms: ['rtg', 'реэтерифицированный триглицерид', 'реэтерифицированная триглицеридная форма', 're-esterified triglyceride'] },
  { code: 'potassium_iodate', kind: 'form', parent: 'iodine', name_ru: 'Калия йодат', name_uz: 'Kaliy yodat', synonyms: ['калия йодат', 'potassium iodate'] },
  { code: 'whey_isolate', kind: 'form', parent: 'protein', name_ru: 'Сывороточный изолят (WPI)', name_uz: 'Zardob izolyati (WPI)', synonyms: ['wpi', 'сывороточный изолят', 'изолят сывороточного белка', 'whey isolate', 'whey protein isolate'] },
  { code: 'whey_concentrate', kind: 'form', parent: 'protein', name_ru: 'Сывороточный концентрат (WPC)', name_uz: 'Zardob konsentrati (WPC)', synonyms: ['wpc', 'сывороточный концентрат', 'концентрат сывороточного белка', 'whey concentrate', 'whey protein concentrate'] },
  // the group records split (sheet 4): forms of the group, so the rules and goals of the group still apply to them
  { code: 'echinacea', kind: 'form', parent: 'exinatseya_va_fitoekstraktlar', name_ru: 'Эхинацея', name_uz: 'Exinatseya', synonyms: ['эхинацея', 'echinacea', 'exinatseya'] },
  { code: 'elderberry', kind: 'form', parent: 'exinatseya_va_fitoekstraktlar', name_ru: 'Бузина', name_uz: 'Buzina', synonyms: ['бузина', 'бузины', 'elderberry', 'sambucus'] },
  { code: 'milk_thistle', kind: 'form', parent: 'exinatseya_va_fitoekstraktlar', name_ru: 'Расторопша (силимарин)', name_uz: 'Rastoropsha (silimarin)', synonyms: ['расторопша', 'силимарин', 'milk thistle', 'silymarin'] },
  { code: 'ginkgo', kind: 'form', parent: 'exinatseya_va_fitoekstraktlar', name_ru: 'Гинкго билоба', name_uz: 'Ginkgo biloba', synonyms: ['гинкго билоба', 'гинкго', 'ginkgo biloba', 'ginkgo'] },
  { code: 'spirulina', kind: 'form', parent: 'exinatseya_va_fitoekstraktlar', name_ru: 'Спирулина', name_uz: 'Spirulina', synonyms: ['спирулина', 'spirulina'] },
  { code: 'zeaxanthin', kind: 'form', parent: 'lyutein_va_antotsianlar', name_ru: 'Зеаксантин', name_uz: 'Zeaksantin', synonyms: ['зеаксантин', 'zeaxanthin', 'zeaksantin'] },
  { code: 'bilberry', kind: 'form', parent: 'lyutein_va_antotsianlar', name_ru: 'Черника (антоцианы)', name_uz: 'Chernika (antotsianlar)', synonyms: ['черника', 'антоцианы', 'bilberry', 'anthocyanins'] },
  // not in the dictionary yet, common at iHerb / California Gold Nutrition (sheet 3) — no rules and goals yet
  { code: 'astaxanthin', kind: 'substance', name_ru: 'Астаксантин', name_uz: 'Astaksantin', synonyms: ['астаксантин', 'astaxanthin', 'astaksantin'] },
  { code: 'curcumin', kind: 'substance', name_ru: 'Куркумин', name_uz: 'Kurkumin', synonyms: ['куркумин', 'куркума', 'curcumin', 'turmeric', 'kurkuma'] },
  { code: 'l_theanine', kind: 'substance', name_ru: 'L-теанин', name_uz: 'L-teanin', synonyms: ['l-теанин', 'теанин', 'l-theanine', 'theanine'] },
  { code: 'nac', kind: 'substance', name_ru: 'NAC (N-ацетилцистеин)', name_uz: 'NAC (N-atsetilsistein)', synonyms: ['nac', 'n-ацетилцистеин', 'ацетилцистеин', 'n-acetyl cysteine', 'n-acetylcysteine'] },
  { code: 'glycine', kind: 'substance', name_ru: 'Глицин', name_uz: 'Glitsin', synonyms: ['глицин', 'glycine', 'glitsin'] },
  { code: 'quercetin', kind: 'substance', name_ru: 'Кверцетин', name_uz: 'Kversetin', synonyms: ['кверцетин', 'quercetin', 'kversetin'] },
];

export const SYNONYM_CHANGES: SynonymChange[] = [
  // taken by the new forms: the same word in the substance and in its form would confuse the suggestions
  { code: 'magnesium', remove: ['цитрат магния', 'магния цитрат', 'магний цитрат', 'бисглицинат магния', 'глицинат магния'] },
  { code: 'zinc', remove: ['пиколинат цинка'] },
  { code: 'xrom', remove: ['пиколинат хрома', 'хрома пиколинат'] },
  { code: 'iron', remove: ['бисглицинат железа'] },
  { code: 'folate', remove: ['метилфолат'], add: ['folate', 'methyl folate'] },
  { code: 'koenzim_q10', remove: ['убихинол', 'ubiquinol', 'ubixinol'] },
  { code: 'creatine', remove: ['креатин моногидрат', 'моногидрат креатина', 'creatine monohydrate'] },
  { code: 'collagen', remove: ['морской коллаген'], add: ['collagen peptides', 'hydrolyzed collagen'] },
  { code: 'iodine', remove: ['калия йодат'] },
  { code: 'lyutein', remove: ['zeaksantin'] },
  { code: 'lyutein_va_antotsianlar', remove: ['зеаксантин', 'черника'] },
  { code: 'exinatseya_va_fitoekstraktlar', remove: ['эхинацея', 'бузина', 'расторопша', 'силимарин', 'гинкго билоба', 'спирулина', 'echinacea', 'elderberry', 'silymarin'] },
  // English spellings for products from the USA (sheet 3)
  { code: 'b_complex', add: ['vitamin b complex', 'b-complex', 'b complex'] },
  { code: 'omega3', add: ['fish oil', 'omega-3 fish oil', 'cod liver oil'] },
  { code: 'multivitamin', add: ['multi', 'daily multi', 'multivitamins', 'multi-vitamin'] },
  { code: 'hyaluronic', add: ['sodium hyaluronate', 'hyaluronan'] },
  { code: 'protein', add: ['whey protein', 'plant protein', 'pea protein'] },
  { code: 'vitamin_e', add: ['d-alpha tocopherol', 'tocopherols'] },
  { code: 'elektrolitlar', add: ['electrolyte'] },
];

const MG_CIT = { magnesium: 'magnesium_citrate' };
const CREATINE = { creatine: 'creatine_monohydrate' };

export const PRODUCT_LABELS: Record<string, ProductLabelPlan> = {
  'OZN-A001': { label: ['marine_collagen', 'vitamin_c'], replace: { collagen: 'marine_collagen' } },
  'OZN-A002': { label: ['magnesium_citrate', 'vitamin_b6', 'vitamin_d3'], replace: MG_CIT },
  'OZN-A003': { label: ['vitamin_d3'] },
  'OZN-A004': { label: ['multivitamin'] },
  'OZN-A005': { label: ['collagen', 'hyaluronic', 'vitamin_c'] },
  'OZN-A006': { label: ['omega3_rtg'], replace: { omega3: 'omega3_rtg' } },
  'OZN-A007': { label: ['creatine_monohydrate'], replace: CREATINE },
  'OZN-A008': { label: ['creatine_monohydrate'], replace: CREATINE },
  'OZN-A009': { label: ['bovine_collagen', 'vitamin_c', 'hyaluronic'], replace: { collagen: 'bovine_collagen' } },
  'OZN-A010': { label: ['creatine_monohydrate'], replace: CREATINE },
  'OZN-A011': { label: ['marine_collagen', 'hyaluronic', 'vitamin_c'], replace: { collagen: 'marine_collagen' } },
  'OZN-A012': { label: ['potassium_iodate'], replace: { iodine: 'potassium_iodate' } },
  'OZN-A013': { label: ['collagen', 'vitamin_c'] },
  'OZN-A014': { label: ['magnesium_citrate', 'vitamin_b6'], replace: MG_CIT },
  'OZN-A015': { label: ['vitamin_c'] },
  'OZN-A016': { label: ['protein'] },
  'OZN-A017': { label: ['multivitamin'] },
  'OZN-A018': { label: ['multivitamin', 'zinc', 'selenium'] },
  'OZN-A019': { label: ['magnesium_citrate', 'vitamin_b6'], replace: MG_CIT },
  'OZN-A020': { label: ['magnesium_citrate', 'vitamin_b6'], replace: MG_CIT },
  'OZN-A021': { label: ['vitamin_d3'] },
  'OZN-A022': { label: ['magnesium_citrate', 'vitamin_b6'], replace: MG_CIT },
  'OZN-A023': { label: ['omega3'] },
  'OZN-A024': { label: ['vitamin_d3'] },
  'OZN-A025': { label: ['vitamin_d3', 'vitamin_k2'] },
  'OZN-A026': { label: ['vitamin_d3'] },
  'OZN-A027': { label: ['vitamin_d3', 'vitamin_k2'], remove: ['vitamin_c'] },
  'OZN-A028': { label: ['vitamin_c'] },
  'OZN-A029': { label: ['calcium_ascorbate'], replace: { vitamin_c: 'calcium_ascorbate' } },
  'OZN-A030': { label: ['magnesium_bisglycinate'], replace: { magnesium: 'magnesium_bisglycinate' } },
  'OZN-A031': { label: ['magnesium_bisglycinate'], replace: { magnesium: 'magnesium_bisglycinate' } },
  'OZN-A032': { label: ['magnesium'] },
  'OZN-A033': { label: ['melatonin'] },
  'OZN-A034': { label: ['5_htp_5_gidroksitriptofan'] },
  'OZN-A035': { label: ['ashvaganda'] },
  'OZN-A036': { label: ['biotin'] },
  'OZN-A037': { label: ['iron_bisglycinate'], replace: { iron: 'iron_bisglycinate' } },
  'OZN-A038': { label: ['methylfolate'], replace: { folate: 'methylfolate' } },
  'OZN-A039': { label: ['inozitol'] },
  'OZN-A040': { label: ['marine_collagen', 'vitamin_c', 'hyaluronic'], replace: { collagen: 'marine_collagen' } },
  'OZN-A041': { label: ['marine_collagen', 'biotin', 'zinc', 'vitamin_c'], replace: { collagen: 'marine_collagen' } },
  'OZN-A042': { label: ['zinc_picolinate'], replace: { zinc: 'zinc_picolinate' } },
  'OZN-A043': { label: ['selenium', 'zinc'] },
  'OZN-A044': { label: ['chromium_picolinate'], replace: { xrom: 'chromium_picolinate' } },
  'OZN-A045': { label: ['calcium', 'magnesium', 'vitamin_d3'] },
  'OZN-A046': { label: ['omega3'] },
  'OZN-A047': { label: ['omega3'] },
  'OZN-A048': { label: ['koenzim_q10'] },
  'OZN-A049': { label: ['berberin'] },
  'OZN-A050': { label: ['probiotiklar'] },
  'OZN-A051': { label: ['multivitamin'] },
  'OZN-A052': { label: ['multivitamin'] },
  'OZN-A053': { label: ['bcaa_aminokislotalar'] },
  'OZN-A054': { label: ['multivitamin'] },
  'OZN-A055': { label: ['magnesium_bisglycinate'], replace: { magnesium: 'magnesium_bisglycinate' } },
  'OZN-A056': { label: ['b_complex'] },
  'OZN-A057': { label: ['creatine_monohydrate'], replace: CREATINE },
  'OZN-A058': { label: ['multivitamin', 'koenzim_q10', 'lyutein'] },
  'OZN-A059': { label: ['zinc_picolinate'], replace: { zinc: 'zinc_picolinate' } },
  'OZN-A060': { label: ['ovqat_hazm_qilish_fermentlari'] },
  'OZN-A061': { label: ['magniy_l_treonat'], remove: ['magnesium'] },
  'OZN-A062': { label: ['ubiquinol'], replace: { koenzim_q10: 'ubiquinol' } },
  'OZN-A063': { label: ['b_complex'] },
  'OZN-A064': { label: ['omega3_rtg'], replace: { omega3: 'omega3_rtg' } },
  'OZN-A065': { label: ['omega3', 'vitamin_d3'] },
  'OZN-A066': { label: ['omega3'] },
  'OZN-A067': { label: ['multivitamin'] },
  // the owner: no label for echinacea; linked to the separate «Эхинацея» instead of the group
  'OZN-A068': { label: [], replace: { exinatseya_va_fitoekstraktlar: 'echinacea' } },
  'OZN-A069': { label: ['probiotiklar'] },
  'OZN-A070': { label: ['letsitin'] },
  'OZN-A071': { label: ['glyukozamin', 'xondroitin', 'msm_metilsulfonilmetan'] },
  'OZN-A072': { label: ['lyutein'], remove: ['lyutein_va_antotsianlar'] },
  'OZN-A073': { label: ['vitamin_d3', 'vitamin_k2'], remove: ['vitamin_e'] },
  'OZN-A074': { label: ['ashvaganda'] },
  'OZN-A075': { label: ['omega3'] },
  'OZN-A076': { label: ['probiotiklar'] },
  'OZN-A077': { label: ['vitamin_c'] },
  'OZN-A078': { label: ['elektrolitlar'] },
  'OZN-A079': { label: ['probiotiklar'] },
  'OZN-A080': { label: ['uc_ii_denaturatsiyalanmagan_ii_tur_kollagen'] },
  'OZN-A081': { label: ['psyllium'] },
  'OZN-A082': { label: ['omega3', 'vitamin_a', 'vitamin_d3'] },
  'OZN-A083': { label: ['whey_concentrate'], replace: { protein: 'whey_concentrate' }, remove: ['bcaa_aminokislotalar'] },
  'OZN-A084': { label: ['creatine_monohydrate'], replace: CREATINE },
  'OZN-A085': { label: ['probiotiklar'] },
  'OZN-A086': { label: ['whey_isolate'], replace: { protein: 'whey_isolate' } },
};
