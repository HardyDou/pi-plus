import assert from "node:assert/strict";
import test from "node:test";
import { quietSeconds, tooFresh } from "../src/commands.js";

const now = Date.UTC(2026, 10, 22, 12, 0, 0);
const secondsAgo = (s) => Math.floor(now / 1000) - s;

test("quietSeconds reads tmux activity stamps, and refuses to guess", () => {
  assert.equal(quietSeconds(secondsAgo(600), now), 600, "ten quiet minutes");
  assert.equal(quietSeconds(secondsAgo(0), now), 0, "just now");
  assert.equal(quietSeconds(undefined, now), null, "no stamp is not 'quiet'");
  assert.equal(quietSeconds("nonsense", now), null);
});

test("tooFresh is the gate a heartbeat uses: skip anything that moved recently", () => {
  assert.equal(tooFresh(secondsAgo(30), 600, now), true, "moved a minute ago: leave it alone");
  assert.equal(tooFresh(secondsAgo(700), 600, now), false, "quiet for 11 minutes: nudge it");
  assert.equal(tooFresh(secondsAgo(30), 0, now), false, "no gate configured means no gate");
  assert.equal(tooFresh(undefined, 600, now), false, "unknown activity does not silence a job");
});
