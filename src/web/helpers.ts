export const linesToText = (values: string[]): string => values.join('\n');

export const textToLines = (value: string): string[] =>
  value
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(Boolean);

export const sameLines = (text: string, values: string[]): boolean =>
  linesToText(values) === text.trim();

export const formatTime = (value: number | null): string => {
  if (value === null) return '暂无记录';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date(value));
};

export const formatDateTime = (value: string | number | Date): string =>
  new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: false,
  }).format(new Date(value));

export const textOrDash = (value: string | null | undefined): string => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : '—';
};
