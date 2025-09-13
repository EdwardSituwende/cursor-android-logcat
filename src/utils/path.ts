export function extractFileName(fullPath: string): string {
  try {
    const norm = String(fullPath || '').replace(/\\/g, '/');
    const base = norm.split('/').pop();
    return base || fullPath;
  } catch {
    return fullPath;
  }
}


