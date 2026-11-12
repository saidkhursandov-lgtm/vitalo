import { useMutation } from '@tanstack/react-query';
import { downloadFile } from '../lib/api';

/**
 * Аудит админки 2.14: «Скачать для Excel» — the current filter as a CSV file (UTF-8 with BOM, opens in Excel with
 * Cyrillic). The API checks the permission and writes the download to the audit log.
 */
export function ExportButton({ path, label = 'Скачать для Excel' }: { path: string; label?: string }) {
  const m = useMutation({ mutationFn: () => downloadFile(path) });
  return (
    <span className="export">
      <button type="button" className="btn btn-sm btn-ghost" disabled={m.isPending} onClick={() => m.mutate()}>
        {m.isPending ? 'Готовим файл…' : label}
      </button>
      {m.isError && (
        <span className="text-bad small" role="alert">
          {' '}
          Не удалось скачать: {m.error.message}
        </span>
      )}
    </span>
  );
}
