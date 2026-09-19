// Promise wrapper around google.script.run (SPEC §14.2).
//
// This is the only file in the client that names google.script.run.

/** Apps Script round trips are slow; this is a ceiling, not a target. */
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * A structured server error is `{ code, message }` (SPEC §14.2), which is a
 * normal return value rather than a thrown exception.
 * @param {*} value
 * @returns {boolean}
 */
export function isServerError(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

/**
 * @param {string} message
 * @param {string} code
 * @param {boolean} fromServer
 * @returns {Error}
 */
function transportError(message, code, fromServer) {
  const err = new Error(message);
  err.code = code;
  err.fromServer = !!fromServer;
  return err;
}

/**
 * One attempt, with a timeout.
 * @param {string} name
 * @param {Array<*>} args
 * @param {number} timeoutMs
 * @returns {Promise<*>}
 */
function runOnce(name, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const runner =
      typeof google !== "undefined" && google.script && google.script.run ? google.script.run : null;
    if (!runner) {
      reject(transportError("google.script.run is not available on this page", "NO_TRANSPORT", false));
      return;
    }
    if (typeof runner[name] !== "function") {
      reject(transportError(`The server has no callable function named ${name}`, "NO_SUCH_FUNCTION", false));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(transportError(`${name} timed out after ${timeoutMs} ms`, "TIMEOUT", false));
    }, timeoutMs);

    runner
      .withSuccessHandler((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (isServerError(result)) {
          reject(transportError(result.message, result.code, true));
        } else {
          resolve(result);
        }
      })
      .withFailureHandler((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(transportError(err && err.message ? err.message : String(err), "TRANSPORT", false));
      })
      [name].apply(runner, args || []);
  });
}

/**
 * Call a server function, retrying once on a transient failure.
 *
 * A structured server error is an answer, not a transient failure, so it is
 * never retried: ACCESS_DENIED and CHUNK_TOO_LARGE both mean "do something
 * different", and repeating the call would only waste a round trip.
 *
 * @param {string} name
 * @param {Array<*>} [args]
 * @param {{timeoutMs?: number, retry?: boolean}} [options]
 * @returns {Promise<*>}
 */
export async function callServer(name, args, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const retry = opts.retry === undefined ? true : !!opts.retry;
  try {
    return await runOnce(name, args, timeoutMs);
  } catch (err) {
    if (!retry || (err && err.fromServer)) throw err;
    return runOnce(name, args, timeoutMs);
  }
}
