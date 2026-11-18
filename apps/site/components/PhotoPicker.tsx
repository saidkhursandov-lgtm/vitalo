'use client';
import { useEffect, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { useSession } from './Session';

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

/** Keeps only JPG/PNG/WEBP up to 10 MB and at most `max` photos; `rejected` — some files were skipped. */
export function acceptPhotos(current: File[], added: File[], max: number): { photos: File[]; rejected: boolean } {
  const ok = added.filter((f) => PHOTO_TYPES.includes(f.type) && f.size <= PHOTO_MAX_BYTES);
  return { photos: [...current, ...ok].slice(0, max), rejected: ok.length < added.length };
}

/** Photos for a review or a return: previews, a remove cross and the «Добавить фото» tile. */
export function PhotoPicker({ photos, max, onChange, onRejected }: { photos: File[]; max: number; onChange: (p: File[]) => void; onRejected: (bad: boolean) => void }) {
  const { t } = useSession();
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  return (
    <div className="photo-picker">
      {previews.map((src, i) => (
        <div key={src} className="photo-tile">
          <img src={src} alt="" />
          <button type="button" aria-label={t('review.removePhoto')} onClick={() => onChange(photos.filter((_, j) => j !== i))}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      ))}
      {photos.length < max ? (
        <label className="photo-tile photo-add">
          <Plus size={22} strokeWidth={1.8} />
          <span>{t('review.addPhoto')}</span>
          <input
            type="file"
            accept={PHOTO_TYPES.join(',')}
            multiple
            onChange={(e) => {
              const r = acceptPhotos(photos, [...(e.target.files ?? [])], max);
              onRejected(r.rejected);
              onChange(r.photos);
              e.target.value = '';
            }}
          />
        </label>
      ) : null}
    </div>
  );
}
