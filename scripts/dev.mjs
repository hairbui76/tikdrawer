// Kill whatever is listening on PORT, then start `next dev`.
// Cross-platform (Windows + Unix) so it works on the host and in Docker.
import { execSync, spawn } from "node:child_process";

const PORT = process.env.PORT || "3000";

function killPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && m[1] === String(port) && m[2] !== "0") pids.add(m[2]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
          console.log(`[dev] killed PID ${pid} on port ${port}`);
        } catch {
          /* already gone */
        }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} || true`, {
        encoding: "utf8",
        shell: "/bin/sh",
      });
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        try {
          execSync(`kill -9 ${pid}`);
          console.log(`[dev] killed PID ${pid} on port ${port}`);
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    // nothing listening, or the lookup tool is missing — just continue.
  }
}

killPort(PORT);

const child = spawn("next dev", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PORT },
});
child.on("exit", (code) => process.exit(code ?? 0));
