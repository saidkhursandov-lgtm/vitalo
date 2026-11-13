import { useState, type ImgHTMLAttributes } from 'react';
import { PillIcon } from './Icons';

/**
 * Product photo: WebP with a JPEG fallback, lazy by default, with width/height so the page does not jump
 * while the picture loads (D2). Old, not yet optimized photos have only `webp` (= the original URL).
 * A photo that does not load (weak mobile internet) becomes a clean light box with a jar icon — never the broken-file
 * sign and the long `alt` text.
 */
export interface PictureSource {
  webp: string;
  jpeg?: string | null;
  width?: number | null;
  height?: number | null;
}

/** The light box with the jar icon in place of a photo that did not load. */
export function ImgFallback({ className = '', label, size }: { className?: string; label?: string; size?: { width?: number | string; height?: number | string } }) {
  return (
    <span
      className={`img-fallback ${className}`.trim()}
      style={size?.width ? { width: size.width, height: size.height ?? size.width } : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <PillIcon width="40%" height="40%" aria-hidden />
    </span>
  );
}

export function Picture({ src, alt = '', eager = false, className }: { src: PictureSource; alt?: string; eager?: boolean; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const key = src.jpeg ?? src.webp;
  if (failed === key) return <ImgFallback className={className} label={alt || undefined} />;
  const onError = () => setFailed(key);
  const img = (
    <img
      src={key}
      alt={alt}
      width={src.width ?? undefined}
      height={src.height ?? undefined}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
      onError={onError}
    />
  );
  if (!src.jpeg) return img;
  return (
    <picture>
      <source srcSet={src.webp} type="image/webp" />
      {img}
    </picture>
  );
}

/** A small product image (cart lines, thumbnails): the same fallback when it does not load. */
export function SafeImg({ src, className, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === src) return <ImgFallback className={className} size={{ width: rest.width, height: rest.height }} />;
  return <img src={src} className={className} {...rest} onError={() => setFailed(src)} />;
}
