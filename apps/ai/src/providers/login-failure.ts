/**
 * How a sign-in helper tells the service why the sign-in failed.
 *
 * The helper runs as its own process, so the reason travels on its standard error, marked so it
 * can be told apart from the vendor CLI's own output. It never carries the secret that was
 * pasted: only what went wrong.
 */
export const loginFailureMarker = "LOGIN_FAILED";

/** Prints the reason a sign-in failed. */
export function writeLoginFailure(reason: string) {
  process.stderr.write(`${loginFailureMarker}: ${reason}\n`);
}

/** Reads the reason a sign-in failed out of what the helper printed. */
export function parseLoginFailure(output: string): string | null {
  for (const line of output.split("\n")) {
    if (line.startsWith(`${loginFailureMarker}:`)) {
      const reason = line.slice(loginFailureMarker.length + 1).trim();
      if (reason) return reason;
    }
  }
  return null;
}
