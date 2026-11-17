#!/usr/bin/env node
// Dev entry point: runs the TypeScript source through tsx.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");
