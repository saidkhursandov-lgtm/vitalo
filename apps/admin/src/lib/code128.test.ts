import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128Values, encodeCode128 } from './code128';

describe('Code 128 B encoder (Physical ID barcode)', () => {
  it('table: 107 symbols, 3 bars + 3 spaces of 11 modules each, STOP 13 modules, all different', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    for (const [i, p] of CODE128_PATTERNS.entries()) {
      const sum = [...p].reduce((s, w) => s + Number(w), 0);
      expect(sum).toBe(i === 106 ? 13 : 11);
      expect(p).toMatch(i === 106 ? /^[1-4]{7}$/ : /^[1-4]{6}$/);
    }
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
  });

  it('START B, data, mod-103 checksum, STOP', () => {
    // V=54, -=13, 0=16, 1=17, 8=24, 4=20; checksum = (104 + 54·1 + 13·2 + 16·3 + 16·4 + 16·5 + 17·6 + 24·7 + 20·8) mod 103
    expect(code128Values('V-000184')).toEqual([104, 54, 13, 16, 16, 16, 17, 24, 20, 85, 106]); // 806 mod 103 = 85
    expect(() => encodeCode128('')).toThrow();
    expect(() => encodeCode128('Ё')).toThrow(/cannot be encoded/);
  });

  it('reference encodings (checked once against the jsbarcode library, Code 128 B)', () => {
    expect(encodeCode128('V-000184')).toBe(
      '110100100001110101100010011011100100111011001001110110010011101100100111001101110100110011001001110100111100101100011101011',
    );
    expect(encodeCode128('Wikipedia')).toBe(
      '11010010000111010001101000011010011000010010100001101001010011110010110010000100001001101000011010010010110000111100100101100011101011',
    );
    const v = encodeCode128('V-000184');
    expect(v).toHaveLength(11 * 10 + 13); // start + 8 characters + checksum = 10 symbols, then STOP
    expect(v.startsWith('1') && v.endsWith('11')).toBe(true);
  });
});
