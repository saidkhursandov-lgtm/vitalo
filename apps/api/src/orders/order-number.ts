/** VTL-YYYYMMDD-NNNN; the sequence restarts every Tashkent calendar day (order_number_counters). */
export function formatOrderNumber(tashkentDate: string, seq: number): string {
  return `VTL-${tashkentDate.replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
}
