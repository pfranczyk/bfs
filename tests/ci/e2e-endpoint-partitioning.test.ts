import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repo root - anchored to this file, so the suite does not depend on the cwd. */
const ROOT = path.resolve(__dirname, '..', '..');

// --- Contract under test ----------------------------------------------------
//
// Scenarios that provision their own server (REQUIRES_DOCKER > 0) register their
// endpoint AFTER any endpoint the job supplied on the command line. The pool
// hands providers out round-robin from index 0, so in a job that also passes
// --ftp/--ssh the scenario drives the job's external server while asserting
// against its own - it fails for a reason that has nothing to do with the code,
// and along the way it silently stops testing what it exists to test (a cert-pin
// scenario ends up running against a server with no pin at all).
//
// run.sh states the rule where --exclude-docker is implemented: a job supplying
// external endpoints must use it, and the docker-managed scenarios belong in a
// companion --docker-only job. The rule lives only as prose there, so every new
// CI job either repeats it from memory or breaks it - and breaking it produces a
// red that looks like a code regression, which is the most expensive kind of
// false alarm: it teaches people to ignore red.
//
// This pins the rule against the workflow, so a job added later cannot
// reintroduce it quietly.

/** The CI definition that drives the cli-e2e harness. */
const CI_FILE = '.github/workflows/e2e.yml';

/** A job hands the harness a server it did not provision itself. */
const SUPPLIES_EXTERNAL_ENDPOINT = /--ftp[\s=]|--ssh[\s=]|--ssh-docker[\s=]/;

/**
 * Harness invocations, one per entry, with line continuations folded in so a
 * command split across YAML lines is judged as a whole. Comments are stripped -
 * whole-line and trailing alike - because the file explains these very flags in
 * prose, and a quoted example must not be judged as if it were a job.
 *
 * @param file - repo-relative path of the CI definition to read
 * @returns every line that invokes the cli-e2e harness
 */
function harnessInvocations(file: string): string[] {
  const folded = readFileSync(path.join(ROOT, file), 'utf8').replace(/\\\r?\n\s*/g, ' ');
  return folded
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => line.includes('scripts/cli-e2e/run.sh'));
}

describe('cli-e2e CI jobs partition self-provisioned servers from supplied ones', () => {
  // Without this one, a rename or a restructured job would leave the rule
  // pinned against nothing at all - green, and guarding no job.
  it('should find harness invocations in the CI definition', () => {
    expect(harnessInvocations(CI_FILE).length).toBeGreaterThan(0);
  });

  it(`should pass --exclude-docker wherever ${CI_FILE} supplies an endpoint`, () => {
    const offenders = harnessInvocations(CI_FILE)
      .filter((cmd) => SUPPLIES_EXTERNAL_ENDPOINT.test(cmd))
      .filter((cmd) => !cmd.includes('--exclude-docker'));

    // Naming the offending commands makes the failure actionable on its own -
    // whoever sees this does not have to rediscover which job is at fault.
    expect(offenders, `invocations in ${CI_FILE} that supply an endpoint without --exclude-docker:\n${offenders.join('\n')}`).toEqual([]);
  });

  it(`should keep a --docker-only job in ${CI_FILE} to run what the rule excludes`, () => {
    // The rule removes those scenarios from every endpoint-supplying job, so the
    // definition that excludes them needs its own home for them.
    const invocations = harnessInvocations(CI_FILE);
    if (!invocations.some((cmd) => cmd.includes('--exclude-docker'))) return;

    expect(invocations.some((cmd) => cmd.includes('--docker-only'))).toBe(true);
  });
});
