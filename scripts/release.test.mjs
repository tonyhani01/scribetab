import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { bumpVersion, changelogSection } from "./release.mjs";

describe("bumpVersion", () => {
  it("bumps patch", () => {
    assert.equal(bumpVersion("1.1.0", "patch"), "1.1.1");
    assert.equal(bumpVersion("2.3.4", "patch"), "2.3.5");
  });

  it("bumps minor and resets patch", () => {
    assert.equal(bumpVersion("1.1.0", "minor"), "1.2.0");
    assert.equal(bumpVersion("1.9.9", "minor"), "1.10.0");
  });

  it("bumps major and resets minor and patch", () => {
    assert.equal(bumpVersion("1.1.0", "major"), "2.0.0");
    assert.equal(bumpVersion("9.4.2", "major"), "10.0.0");
  });

  it("accepts an explicit x.y.z version", () => {
    assert.equal(bumpVersion("1.1.0", "2.0.0"), "2.0.0");
    assert.equal(bumpVersion("1.1.0", "1.1.0"), "1.1.0");
  });

  it("throws on invalid current version", () => {
    for (const bad of ["", "1", "1.1", "v1.1.0", "1.1.0.0", "1.1.x", "abc", "1.1.0-beta"]) {
      assert.throws(() => bumpVersion(bad, "patch"), Error, `expected throw for current=${bad}`);
    }
  });

  it("throws on invalid bump argument", () => {
    for (const bad of ["beta", "next", "1.2", "1.2.3.4", "v2.0.0", "", "patch!"]) {
      assert.throws(() => bumpVersion("1.1.0", bad), Error, `expected throw for arg=${bad}`);
    }
    assert.throws(() => bumpVersion("1.1.0", undefined), Error);
  });
});

describe("changelogSection", () => {
  it("renders a header followed by subject lines", () => {
    const s = changelogSection("1.2.3", "2026-09-01", ["Add dark mode", "Fix zip step"]);
    assert.match(s, /^## v1\.2\.3 — 2026-09-01\n/);
    assert.ok(s.includes("- Add dark mode"), "first subject listed");
    assert.ok(s.includes("- Fix zip step"), "second subject listed");
    assert.ok((s.match(/^- /gm) || []).length === 2, "exactly two bullets");
  });

  it("renders a placeholder when there are no subjects", () => {
    const s = changelogSection("1.2.3", "2026-09-01", []);
    assert.match(s, /^## v1\.2\.3 — 2026-09-01\n/);
    assert.ok(s.includes("- No changes recorded."));
    assert.equal((s.match(/^- /gm) || []).length, 1, "only the placeholder bullet");
    assert.ok(!s.includes("- undefined"), "no stray bullets");
  });

  it("normalizes a full ISO timestamp to YYYY-MM-DD", () => {
    const s = changelogSection("2.0.0", "2026-09-01T10:20:30.000Z", []);
    assert.ok(s.startsWith("## v2.0.0 — 2026-09-01"), "date truncated to day");
  });
});
