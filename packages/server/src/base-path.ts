export function normalizeServerBasePath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '/') return '';
  if (!value.startsWith('/') || value.endsWith('/')) {
    throw new Error(`Invalid server base path: ${JSON.stringify(value)}`);
  }
  const segments = value.slice(1).split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9._~-]+$/.test(segment),
    )
  ) {
    throw new Error(`Invalid server base path: ${JSON.stringify(value)}`);
  }
  return value;
}
