import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Picture, SafeImg } from './components/Picture';

describe('a product photo that does not load (weak mobile internet)', () => {
  it('Picture: the light box with the jar icon and the short name for screen readers, no broken image', () => {
    const { container } = render(<Picture src={{ webp: '/x.webp', jpeg: '/x.jpg' }} alt="Магний Цитрат + B6" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    const box = container.querySelector('.img-fallback')!;
    expect(box.getAttribute('aria-label')).toBe('Магний Цитрат + B6');
    expect(box.querySelector('svg')).toBeTruthy();
    expect(container.textContent).toBe('');
  });

  it('SafeImg: a cart thumbnail becomes the same box', () => {
    const { container } = render(<SafeImg src="/y.jpg" alt="" width={56} height={56} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.img-fallback')).toBeTruthy();
  });
});
