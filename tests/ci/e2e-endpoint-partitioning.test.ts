import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ─── Contract under test ────────────────────────────────────────────────────
//
// Scenarios that provision their own server (REQUIRES_DOCKER > 0) register their
// endpoint AFTER any endpoint the job supplied on the command line. The pool
// hands providers out round-robin from index 0, so in a job that also passes
// --ftp/--ssh the scenario drives the job's external server while asserting
// against its own — it fails for a reason that has nothing to do with the code,
// and along the way it silently stops testing what it exists to test (a cert-pin
// scenario ends up running against a server with no pin at all).
//
// run.sh states the rule where --exclude-docker is implemented: a job supplying
// external endpoints must use it, and the docker-managed scenarios belong in a
// companion --docker-only job. The rule lives only as prose there, so every new
// CI job either repeats it from memory or breaks it — and breaking it produces a
// red that looks like a code regression, which is the most expensive kind of
// false alarm: it teaches people to ignore red.
//
// This pins the rule against both CI definitions at once, so a job added later
// cannot reintroduce it quietly.

/** CI definitions that drive the cli-e2e harness. */
const CI_FILES = ['.github/workflows/e2e.yml', '.gitlab-ci.yml'];

/** A job hands the harness a server it did not provision itself. */
const SUPPLIES_EXTERNAL_ENDPOINT = /--ftp\s|--ssh\s|--ssh-docker\s/;

/**
 * Harness invocations, one per entry, with line continuations folded in so a
 * command split across YAML lines is judged as a whole.
 */
function harnessInvocations(file: string): string[] {
  const folded = readFileSync(file, 'utf8').replace(/\\\r?\n\s*/g, ' ');
  return folded
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('scripts/cli-e2e/run.sh'));
}

describe('cli-e2e CI jobs partition self-provisioned servers from supplied ones', () => {
  for (const file of CI_FILES) {
    it(`should pass --exclude-docker wherever ${file} supplies an endpoint`, () => {
      const offenders = harnessInvocations(file)
        .filter((cmd) => SUPPLIES_EXTERNAL_ENDPOINT.test(cmd))
        .filter((cmd) => !cmd.includes('--exclude-docker'));

      // Naming the offending commands makes the failure actionable on its own —
      // whoever sees this does not have to rediscover which job is at fault.
      expect(offenders, `invocations in ${file} that supply an endpoint without --exclude-docker:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('should keep the docker-managed scenarios covered by a --docker-only job', () => {
    // The rule above removes those scenarios from every endpoint-supplying job,
    // so something else has to run them; otherwise the fix trades a false red for
    // a silent coverage hole.
    const all = CI_FILES.flatMap(harnessInvocations);

    expect(all.some((cmd) => cmd.includes('--docker-only'))).toBe(true);
  });
});
