/**
 * Code 128 (subset B) for the Physical ID on labels: «V-000184» -> bars. No dependency: the table below is the
 * standard ISO/IEC 15417 one (widths of bar, space, bar, space, bar, space in modules; every symbol is 11 modules,
 * STOP is 13). Checked by tests in code128.test.ts (structure, checksum, reference encodings).
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const CODE128_PATTERNS: readonly string[] = PATTERNS;
const START_B = 104;
const STOP = 106;

/** Widths -> modules: '211214' -> '11010010000' (1 = bar, 0 = space). */
const modules = (widths: string) => [...widths].map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(Number(w))).join('');

/** Symbol values of the text in subset B: START B, data, checksum, STOP. Only printable ASCII (32…126). */
export function code128Values(text: string): number[] {
  if (!text) throw new RangeError('empty barcode text');
  const data = [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 32 || c > 126) throw new RangeError(`character «${ch}» cannot be encoded in Code 128 B`);
    return c - 32;
  });
  const checksum = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, checksum, STOP];
}

/** The whole symbol as modules (without the quiet zones: leave at least 10 modules blank on each side). */
export function encodeCode128(text: string): string {
  return code128Values(text).map((v) => modules(PATTERNS[v])).join('');
}
