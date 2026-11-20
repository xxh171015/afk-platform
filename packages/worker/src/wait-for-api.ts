// The worker asks the API before it starts. An API that is not there yet is not a reason to exit: under up.sh a
// worker that exits stops the whole stack, and the usual cause is an API that is restarting or that a failed
// restart left down (scripts/restart.sh worker starts the new worker at once). Say so once, then keep trying.

const FIRST_RETRY_MS = 1_000;
const RETRY_CAP_MS = 10_000;

export interface WaitForApiOptions {
  apiUrl: string;
  fetch(url: string): Promise<{ ok: boolean; status: number }>;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export async function waitForApi(options: WaitForApiOptions): Promise<void> {
  let delay = FIRST_RETRY_MS;
  let waited = false;
  for (;;) {
    let problem: string;
    try {
      const response = await options.fetch(`${options.apiUrl}/specs`);
      if (response.ok) {
        if (waited) options.log(`the API answers; starting`);
        return;
      }
      problem = `HTTP ${response.status}`;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (!waited) {
      options.log(
        `the API at ${options.apiUrl} does not answer (${problem}); waiting for it (start it with pnpm api, or Ctrl-C)`,
      );
      waited = true;
    }
    await options.sleep(delay);
    delay = Math.min(delay * 2, RETRY_CAP_MS);
  }
}
