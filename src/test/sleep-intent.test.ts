import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SLEEP_INTENT_TTL_MS,
  parseSleepIntent,
  sleepIntentDue,
  sleepIntentFromHash,
  sleepOffer,
  withSleepIntent,
  withoutSleepIntent,
} from "../shared/sleep.js";
import { withoutConnectionHash } from "../shared/view-url.js";

describe("Sleep from an isolated tab", () => {
  it("is offered here on a shared app, as a hop from a daemon's own bundle, and not at all with nowhere to hop", () => {
    assert.deepEqual(sleepOffer(false, null), { kind: "here" });
    assert.deepEqual(sleepOffer(false, "brane.organelle.dev"), { kind: "here" });
    assert.deepEqual(sleepOffer(true, "brane.organelle.dev"), { kind: "hop", appHost: "brane.organelle.dev" });
    assert.equal(sleepOffer(true, null), null);
  });

  it("carries the intent in the fragment beside the connection, and both come off on arrival", () => {
    const url = withSleepIntent("https://brane.organelle.dev/#host=d%3A1&token=t", "brane-7aa813");
    const hash = url.slice(url.indexOf("#"));
    assert.equal(sleepIntentFromHash(hash), "brane-7aa813");
    assert.equal(new URLSearchParams(hash.slice(1)).get("token"), "t");
    assert.equal(withoutSleepIntent(withoutConnectionHash(hash)), "");
    assert.equal(withSleepIntent("https://a/x?tab=chat", "b"), "https://a/x?tab=chat#sleep=b");
    assert.equal(withoutSleepIntent("#sleep=b&other=1"), "#other=1");
    assert.equal(sleepIntentFromHash(""), null);
  });

  it("opens the confirm only for that daemon, and only while fresh", () => {
    const now = 1_000_000;
    const intent = parseSleepIntent({ braneId: "brane-7aa813", at: now });
    assert.equal(sleepIntentDue(intent, "brane-7aa813", now + 1_000), true);
    assert.equal(sleepIntentDue(intent, "brane-other", now + 1_000), false);
    assert.equal(sleepIntentDue(intent, "brane-7aa813", now + SLEEP_INTENT_TTL_MS), false);
    assert.equal(sleepIntentDue(intent, undefined, now), false);
    assert.equal(sleepIntentDue(null, "brane-7aa813", now), false);
    assert.equal(parseSleepIntent({ braneId: "", at: 1 }), null);
    assert.equal(parseSleepIntent("x"), null);
  });
});
