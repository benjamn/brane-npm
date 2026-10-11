import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { toPortablePath, fromPortablePath } from "../db/schema.js";

describe("toPortablePath", () => {
  it("converts home directory to ~", () => {
    assert.equal(toPortablePath(homedir()), "~");
  });

  it("converts path under home to ~/relative", () => {
    const home = homedir();
    assert.equal(toPortablePath(`${home}/dev/myproject`), "~/dev/myproject");
  });

  it("leaves paths outside home unchanged", () => {
    assert.equal(toPortablePath("/tmp/something"), "/tmp/something");
  });

  it("does not match partial home prefix", () => {
    const home = homedir();
    // e.g., /Users/benjamin should not match /Users/ben
    assert.equal(toPortablePath(`${home}zzz/extra`), `${home}zzz/extra`);
  });
});

describe("fromPortablePath", () => {
  it("resolves ~ to home directory", () => {
    assert.equal(fromPortablePath("~"), homedir());
  });

  it("resolves ~/relative to absolute path", () => {
    assert.equal(fromPortablePath("~/dev/myproject"), `${homedir()}/dev/myproject`);
  });

  it("leaves absolute paths unchanged", () => {
    assert.equal(fromPortablePath("/tmp/something"), "/tmp/something");
  });

  it("round-trips through toPortablePath", () => {
    const original = `${homedir()}/dev/test-project`;
    assert.equal(fromPortablePath(toPortablePath(original)), original);
  });
});
