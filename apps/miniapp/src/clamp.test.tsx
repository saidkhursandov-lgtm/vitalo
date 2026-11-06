import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClampText, isLongText } from './components/ClampText';
import { I18nProvider } from './lib/i18n';
import type { Lang } from './lib/types';

afterEach(cleanup);

const LONG = 'Органический цитрат магния хорошо усваивается. '.repeat(8);
const show = (text: string, lang: Lang = 'ru') =>
  render(
    <I18nProvider lang={lang} setLang={() => {}}>
      <ClampText className="pre" text={text} />
    </I18nProvider>,
  );

describe('06.11: long verdicts and brand stories — «Читать полностью»', () => {
  it('a short text is shown as it is, without the button', () => {
    const { container } = show('Органический цитрат магния.');
    expect(container.querySelector('p')!.className).toBe('pre');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('more than 240 characters or more than four lines counts as long', () => {
    expect(isLongText('x'.repeat(240))).toBe(false);
    expect(isLongText('x'.repeat(241))).toBe(true);
    expect(isLongText('1\n2\n3\n4')).toBe(false);
    expect(isLongText('1\n2\n3\n4\n5')).toBe(true);
  });

  it('a long text shows four lines and opens / folds by the button', () => {
    const { container } = show(LONG);
    const p = container.querySelector('p')!;
    expect(p.className).toBe('pre clamp-text');
    const btn = screen.getByRole('button', { name: 'Читать полностью' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.querySelector('svg')).not.toBeNull();
    fireEvent.click(btn);
    expect(p.className).toBe('pre clamp-text is-open');
    expect(screen.getByRole('button', { name: 'Свернуть' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Свернуть' }));
    expect(p.className).toBe('pre clamp-text');
  });

  it('Uzbek labels', () => {
    show(LONG, 'uz');
    fireEvent.click(screen.getByRole('button', { name: 'Toʻliq oʻqish' }));
    expect(screen.getByRole('button', { name: 'Yopish' })).toBeTruthy();
  });
});
