/**
 * Returns true when an unknown error is a Node.js ENOENT (file/directory not found).
 * Use this to distinguish "file missing" from other I/O errors in catch blocks.
 */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
