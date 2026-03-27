/**
 * Default content for .bfsignore — system and OS-generated files to exclude from backups.
 * Inlined to avoid runtime path issues with bundlers (tsup, etc.).
 */
export const DEFAULT_BFSIGNORE_CONTENT = `# macOS
.DS_Store
.AppleDouble
.LSOverride

# Windows
Thumbs.db
Thumbs.db:encryptable
ehthumbs.db
ehthumbs_vista.db
desktop.ini
$RECYCLE.BIN/

# Linux
*~
.fuse_hidden*
.Trash-*
.nfs*
`;
