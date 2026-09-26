import { spawn } from "node:child_process";
const tasks = [
  "start:api",
  "start:gateway",
  "start:worker",
  "start:relay",
  "dev:client",
];
const children = tasks.map((task) =>
  spawn("npm", ["run", task], {
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  }),
);
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (child.pid && process.platform !== "win32")
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      /* A child may have already exited. */
    }
  }
  process.exitCode = code;
}
for (const child of children) child.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
