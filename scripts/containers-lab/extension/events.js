// A bounded, timestamped event log the harness reads as evidence.
const LIMIT = 2000;
const log = [];

export function record(type, data = {}) {
  log.push({ at: Date.now(), type, ...data });
  if (log.length > LIMIT) log.shift();
}

export const events = () => [...log];
export const clearEvents = () => void log.splice(0);
