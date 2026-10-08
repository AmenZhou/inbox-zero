import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Runs the real scripts/daily-digest.sh under /bin/bash with a stub `npx` (absolute path, first on PATH),
// so no digest code, Gmail, DB or network is ever touched.
const SCRIPT = path.resolve(
  import.meta.dirname,
  "../../../scripts/daily-digest.sh",
);
const SENT = "[daily-summary]: Digest email sent {}";

/**
 * Each plan entry is one `npx` call: the exit code, plus whether it prints the "Digest email sent" line first.
 * A call beyond the plan exits 99, so an unexpected extra attempt shows up in the exit code.
 */
function run(
  plan: { code: number; sent?: boolean }[],
  args: string[] = ["me@example.com"],
  env: Record<string, string> = { DIGEST_RETRY_SLEEP: "0" },
) {
  const dir = mkdtempSync(path.join(tmpdir(), "digest-sh-"));
  const calls = path.join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(
    path.join(dir, "plan"),
    plan.map((p) => `${p.code} ${p.sent ? 1 : 0}\n`).join(""),
  );
  writeFileSync(
    path.join(dir, "npx"),
    `#!/bin/bash
echo "NODE_ENV=$NODE_ENV cwd=$PWD args=$*" >> "${calls}"
n=$(wc -l < "${calls}" | tr -d ' ')
read -r code sent < <(sed -n "\${n}p" "${path.join(dir, "plan")}")
[[ -n "$code" ]] || exit 99
echo "stub npx attempt $n"
[[ "$sent" == 1 ]] && echo "${SENT}"
echo "stub error line" >&2
exit "$code"
`,
  );
  chmodSync(path.join(dir, "npx"), 0o755);
  const childEnv = {
    ...process.env,
    ...env,
    PATH: `${dir}:${process.env.PATH}`,
  };

  // The stub, not a real npx, must be what the script resolves.
  const resolved = spawnSync("/bin/bash", ["-c", "command -v npx"], {
    env: childEnv,
    encoding: "utf8",
  });
  if (resolved.stdout.trim() !== path.join(dir, "npx")) {
    throw new Error(`stub npx is not the resolved npx: ${resolved.stdout}`);
  }

  const result = spawnSync("/bin/bash", [SCRIPT, ...args], {
    env: childEnv,
    encoding: "utf8",
  });
  const lines = readFileSync(calls, "utf8").split("\n").filter(Boolean);
  return { ...result, lines, calls: lines.length };
}

describe("scripts/daily-digest.sh", () => {
  it("success on the first attempt: one call, exit 0, in apps/web with NODE_ENV=production", () => {
    const r = run([{ code: 0, sent: true }]);

    expect(r.calls).toBe(1);
    expect(r.status).toBe(0);
    expect(r.lines[0]).toContain("NODE_ENV=production");
    expect(r.lines[0]).toMatch(/cwd=.*\/apps\/web /);
    expect(r.lines[0]).toContain(
      "args=tsx -r ./scripts/stub-server-only.cjs scripts/dailySummary.ts me@example.com",
    );
    expect(r.stdout).toContain(SENT);
  });

  it("retries after a failure that sent nothing, then succeeds (2 calls, exit 0); the log shows every attempt", () => {
    const r = run([{ code: 1 }, { code: 0, sent: true }]);

    expect(r.calls).toBe(2);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("stub npx attempt 1");
    expect(r.stdout).toContain("stub npx attempt 2");
    expect(r.stdout).toContain("stub error line"); // stderr is in the log too
  });

  it("honours DIGEST_RETRY_SLEEP between attempts", () => {
    const t = Date.now();
    const r = run([{ code: 1 }, { code: 0 }], ["me@example.com"], {
      DIGEST_RETRY_SLEEP: "1",
    });

    expect(r.calls).toBe(2);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1000);
  });

  it("does NOT retry a failure after 'Digest email sent' (a retry would send a duplicate) and keeps its exit code", () => {
    const r = run([
      { code: 7, sent: true },
      { code: 0, sent: true },
    ]);

    expect(r.calls).toBe(1);
    expect(r.status).toBe(7);
  });

  it("gives up after 3 failed attempts and returns the last exit code", () => {
    const r = run([{ code: 1 }, { code: 1 }, { code: 3 }, { code: 0 }]);

    expect(r.calls).toBe(3);
    expect(r.status).toBe(3);
  });

  it.each([
    [[]],
    [["not-an-email"]],
    [["-x@y"]],
    [["me@example.com", "--hours", "48"]],
    [["me@example.com", "--hours=0"]],
    [["me@example.com", "--hours=48", "extra"]],
  ])("rejects bad arguments %j with the usage line and runs nothing", (args) => {
    const r = run([{ code: 0 }], args as string[]);

    expect(r.calls).toBe(0);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: daily-digest.sh <email> [--hours=<n>]");
  });

  it("accepts --hours=<n> and passes it through", () => {
    const r = run([{ code: 0, sent: true }], ["me@example.com", "--hours=48"]);

    expect(r.lines[0]).toContain(
      "scripts/dailySummary.ts me@example.com --hours=48",
    );
  });

  it("never mentions the catch-up and stays executable", () => {
    const code = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/catchUpHistory|catch-up-history\.sh/);
    expect(spawnSync("test", ["-x", SCRIPT]).status).toBe(0);
  });
});
