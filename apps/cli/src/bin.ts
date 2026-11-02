#!/usr/bin/env node
import { main } from "./index.ts";

process.exitCode = main(process.argv.slice(2));
