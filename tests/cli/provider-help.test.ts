import { describe, expect, it } from 'vitest';
// Side-effect imports: register built-in providers in the global registry.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';

import { buildProviderHelpSection } from '../../src/cli/provider-help.js';

describe('buildProviderHelpSection', () => {
  it('should prepend an "Available providers:" heading', () => {
    const help = buildProviderHelpSection();
    expect(help).toContain('Available providers:');
  });

  it('should render one section per built-in provider', () => {
    const help = buildProviderHelpSection();
    expect(help).toMatch(/local — Local filesystem/);
    expect(help).toMatch(/ftp — FTP\/FTPS/);
  });

  it('should prepend the fixed BFS usage prefix before provider-specific suffix', () => {
    const help = buildProviderHelpSection();
    expect(help).toContain('Usage: bfs provider add --name <name> --type local');
    expect(help).toContain('Usage: bfs provider add --name <name> --type ftp');
    // FTP usage now lists all inline flags + --config-file.
    expect(help).toMatch(/--type ftp .*--host <h>.*--config-file <path>/s);
  });

  it('should render the Options section only when flags are non-empty', () => {
    const help = buildProviderHelpSection();
    // Both built-ins declare --config-file, so Options: should appear.
    expect(help).toContain('Options:');
    expect(help).toContain('--config-file <path>');
  });

  it('should not render install hint for built-in providers', () => {
    // Built-ins register without AdapterRegistrationMeta and leave
    // ProviderHelp.installation undefined, so no "(install: …)" marker.
    const help = buildProviderHelpSection();
    expect(help).not.toMatch(/local — Local filesystem\s+\(install:/);
    expect(help).not.toMatch(/ftp — FTP\/FTPS\s+\(install:/);
  });

  it('should render Example section for providers with examples', () => {
    const help = buildProviderHelpSection();
    expect(help).toContain('Example:');
    // Local provider includes a command-line example.
    expect(help).toMatch(/bfs provider add --ci --name \S+ --type local/);
  });
});
