/**
 * Product photo: WebP with a JPEG fallback, lazy by default, with width/height so the page does not jump
 * while the picture loads (D2). Old, not yet optimized photos have only `webp` (= the original URL).
 */
export interface PictureSource {
  webp: string;
  jpeg?: string | null;
  width?: number | null;
  height?: number | null;
}

export function Picture({ src, alt = '', eager = false, className }: { src: PictureSource; alt?: string; eager?: boolean; className?: string }) {
  const img = (
    <img
      src={src.jpeg ?? src.webp}
      alt={alt}
      width={src.width ?? undefined}
      height={src.height ?? undefined}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={className}
    />
  );
  if (!src.jpeg) return <img src={src.webp} alt={alt} width={src.width ?? undefined} height={src.height ?? undefined} loading={eager ? 'eager' : 'lazy'} decoding="async" className={className} />;
  return (
    <picture>
      <source srcSet={src.webp} type="image/webp" />
      {img}
    </picture>
  );
}
