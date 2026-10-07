import path from 'node:path';

/**
 * A missing hashed asset must 404. Extensionless routes and html files fall back
 * to the SPA shell so client-side navigation still loads.
 */
export function staticMiss(pathname: string): 'spa' | 'missing' {
  const ext = path.posix.extname(pathname);
  if (ext && ext !== '.html') return 'missing';
  return 'spa';
}
