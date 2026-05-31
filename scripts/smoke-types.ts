export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface TestResult {
  id: string;
  description: string;
  passed: boolean;
  error?: string;
  skipped?: boolean;
  ms: number;
}

export interface SuiteResult {
  name: string;
  tests: TestResult[];
}

export interface SmokeContext {
  sourceDir: string;
  vaultDir: string;
  provider1Dir: string;
  provider2Dir: string;
  provider3Dir: string;
  /** SHA-256 of every file before push: relativePath → hex */
  originalHashes: Map<string, string>;
}
