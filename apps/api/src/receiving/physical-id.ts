/**
 * Stage 2B: Physical ID of a jar. «V-» + the number from the sequence physical_unit_seq with zeros to 6 digits
 * (V-000184); from 1 000 000 on the number is written as is. The same rule is a CHECK in the database.
 */
export function formatPhysicalId(seq: number): string {
  if (!Number.isInteger(seq) || seq <= 0) throw new RangeError(`bad Physical ID number ${seq}`);
  return `V-${String(seq).padStart(6, '0')}`;
}

/**
 * What an employee or a USB scanner typed -> the Physical ID, or null when it is not one.
 * V-000184, v-000184, V000184, 000184 and 184 are the same unit. A scanner works like a keyboard: with the
 * Russian layout on, «V» arrives as «М» (the same key), so that is accepted too.
 */
export function normalizePhysicalId(input: string): string | null {
  const s = input
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/^М/, 'V') // Cyrillic Em: the V key with the Russian layout
    .replace(/[‐-―−]/g, '-'); // any dash
  const m = /^(?:V-?)?(\d{1,9})$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? formatPhysicalId(n) : null;
}
