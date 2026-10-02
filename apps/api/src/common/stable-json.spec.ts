import { stableStringify } from './stable-json';

describe('stableStringify', () => {
  it('does not depend on key order, including nested objects', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [1, { y: 1, x: 2 }] } })).toBe(
      stableStringify({ a: { c: [1, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('ignores undefined fields and keeps array order', () => {
    expect(stableStringify({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });
});
