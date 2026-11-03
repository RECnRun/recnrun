#!/usr/bin/env node
import { homedir } from "node:os";
import { startService, stopOnSignals } from "./index.ts";

// Prints where the service answers; the token stays in ~/.recnrun/service.json.
const started = await startService({ home: homedir() });
if (started.reused) {
  console.log(JSON.stringify({ reused: true, port: started.state.port, pid: started.state.pid }));
} else {
  console.log(JSON.stringify({ reused: false, port: started.service.port, pid: process.pid }));
  stopOnSignals(started.service);
}
