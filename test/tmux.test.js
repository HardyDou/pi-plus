import test from "node:test";
import assert from "node:assert/strict";


test("a log: session reports a dead pipe, and create() forces one open", async () => {
  const { Tmux } = await import("../src/tmux.js");
  class Flaky extends Tmux {
    constructor() {
      super({});
      this.calls = [];
      this.pipes = 0;
    }
    run(args, options) {
      this.calls.push(args.join(" "));
      if (args[0] === "pipe-pane") {
        // the first, `-o` attempt lands in the window where the server is still
        // creating the pane: tmux believes a pipe is open and nothing is written
        this.pipes += args.includes("-o") ? 0 : 1;
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "list-panes") return { status: 0, stdout: "0 0\n", stderr: "" };
      if (args[0] === "display-message") return { status: 0, stdout: `${this.pipes}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
  }
  const tmux = new Flaky();
  assert.deepEqual(tmux.paneState("api"), { exists: true, dead: false, pipe: false });
  tmux.create(
    { tmuxName: "api", cwd: "/srv/api", log: "/srv/api.log", remainOnExit: false },
    { argv: ["pi"], env: {} },
  );
  assert.ok(tmux.calls.some((call) => call.startsWith("pipe-pane -o")), "asks first");
  assert.ok(tmux.calls.some((call) => call.startsWith("pipe-pane -t")), "then forces it open");
  assert.equal(tmux.pipeActive("api"), true, "and the pipe is verified, not assumed");
});

test("a pane that is already dead is not reported as a broken pipe", async () => {
  const { Tmux } = await import("../src/tmux.js");
  class Dead extends Tmux {
    run(args) {
      if (args[0] === "list-panes") return { status: 0, stdout: "1 0\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    }
  }
  assert.deepEqual(new Dead({}).paneState("api"), { exists: true, dead: true, pipe: false });
});
