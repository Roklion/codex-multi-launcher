import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

const originalSpawn = childProcess.spawn;
const active = new Map();
const received = [];
let nextPid = 100;

childProcess.spawn = (_command, _args, _options) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const payload = JSON.parse(chunk.toString("utf8"));
      const count = active.get(payload.packageFullName) ?? 0;
      assert.equal(count, 0, `overlapping launches for ${payload.packageFullName}`);
      active.set(payload.packageFullName, count + 1);
      received.push(payload);
      callback();
    },
    final(callback) {
      const payload = received.at(-1);
      setTimeout(() => {
        active.delete(payload.packageFullName);
        if (payload.arguments === "fail") {
          child.stderr.end("activation failed");
          child.emit("close", 1);
        } else {
          child.stdout.end(JSON.stringify({ pid: ++nextPid }));
          child.emit("close", 0);
        }
      }, 10);
      callback();
    }
  });
  return child;
};
syncBuiltinESMExports();

try {
  const { launchWindowsPackagedApp } = await import("../dist-electron/main/windows-packaged-launch.js");
  const options = (packageFullName, argumentsValue) => ({
    packageFullName,
    appUserModelId: "Codex!App",
    arguments: argumentsValue,
    environment: { CODEX_HOME: "C:\\Users\\测试\\Codex" }
  });
  const launches = [
    launchWindowsPackagedApp(options("A", "first")),
    launchWindowsPackagedApp(options("A", "second")),
    launchWindowsPackagedApp(options("B", "other"))
  ];
  assert.equal((await Promise.all(launches)).length, 3);
  assert.equal(received.length, 3);
  assert.equal(received[0].environment.CODEX_HOME, "C:\\Users\\测试\\Codex");

  await assert.rejects(launchWindowsPackagedApp(options("A", "fail")), /activation failed/);
  await launchWindowsPackagedApp(options("A", "after failure"));

  if (process.platform === "win32") {
    const unicodePath = "C:\\Users\\测试\\Codex";
    const result = childProcess.spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false); ([Console]::In.ReadToEnd() | ConvertFrom-Json).path"
    ], { input: JSON.stringify({ path: unicodePath }), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), unicodePath);
  }
  console.log("Windows packaged launch queue verification passed.");
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
