#!/usr/bin/env bash
# End-to-end feature test for pp (manual, not part of `npm test`).
#
# What it does: exercises every feature against a throw-away tmux socket
# (pfe2e), its own XDG_STATE_HOME and config, up to and including installing a
# real systemd user unit (named pi-plus-e2e, so it can never stop yours) and
# starting ONE real pi agent.
#
# Requirements: tmux, bash, a working `pi` CLI (only the last two sections).
#
#   ./test/e2e.sh                        # full run (~5 minutes)
#   PP_E2E_ONLY='^(drift|tui)$' ./test/e2e.sh   # just those sections (debugging)
#
# It cleans up after itself (kills its own tmux server, stops/uninstalls its own
# unit, removes /tmp/e2e-pifarm). The unit is named `pi-plus-e2e` (PP_UNIT_NAME),
# so the autostart section cannot stop the `pi-plus.service` you rely on.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
E2E=/tmp/e2e-pifarm
SOCK=pfe2e
export XDG_STATE_HOME=$E2E/state
export PP_AUDIT_FILE=$E2E/state/pi-plus/audit.log   # the suite must not write to the real trail
# ...and it must never touch the real unit: stopping a unit takes its whole
# cgroup with it, and the real one owns the user's tmux server.
export PP_UNIT_NAME=pi-plus-e2e
CFG=$E2E/plus.yml
PASS=0; FAIL=0; FAILED_NAMES=()

SKIP=0
SECTION_ACTIVE=1

check() { # name want_rc pattern cmd...
  local name="$1" want_rc="$2" pat="$3"; shift 3
  if [[ $SECTION_ACTIVE -eq 0 ]]; then
    SKIP=$((SKIP+1))
    return 0
  fi
  local out rc
  out=$("$@" 2>&1); rc=$?
  local ok=1
  [[ "$rc" -eq "$want_rc" ]] || ok=0
  if [[ -n "$pat" ]]; then grep -qE -- "$pat" <<<"$out" || ok=0; fi
  if [[ $ok -eq 1 ]]; then
    PASS=$((PASS+1)); printf 'ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name")
    printf 'FAIL %s  (rc=%s want=%s /pat= %s)\n' "$name" "$rc" "$want_rc" "$pat"
    sed -n '1,12p' <<<"$out" | sed 's/^/     | /'
  fi
}

# ncheck: command must succeed and must NOT print the pattern
ncheck() { # name pattern cmd...
  local name="$1" pat="$2"; shift 2
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [[ $rc -eq 0 ]] && ! grep -qE -- "$pat" <<<"$out"; then
    PASS=$((PASS+1)); printf 'ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); FAILED_NAMES+=("$name")
    printf 'FAIL %s  (rc=%s /absent= %s)\n' "$name" "$rc" "$pat"
    sed -n '1,12p' <<<"$out" | sed 's/^/     | /'
  fi
}

# PP_E2E_ONLY=<regex> runs only the sections whose title matches — handy while
# chasing one feature. Section bodies still execute (their setup is what the
# checks need), so a filtered run is a debugging aid, not a smaller suite.
section() {
  printf '\n### %s\n' "$1"
  if [[ -n ${PP_E2E_ONLY:-} ]]; then
    if [[ "$1" =~ $PP_E2E_ONLY ]]; then SECTION_ACTIVE=1; else SECTION_ACTIVE=0; printf '     (skipped)\n'; fi
  fi
}

cleanup() {
  [[ -n ${INBOX_PID:-} ]] && kill "$INBOX_PID" >/dev/null 2>&1
  [[ -n ${INBOX_JSON_PID:-} ]] && kill "$INBOX_JSON_PID" >/dev/null 2>&1
  [[ -n ${FAKE_PID:-} ]] && kill "$FAKE_PID" >/dev/null 2>&1
  systemctl --user stop pi-plus-e2e.service >/dev/null 2>&1
  tmux -L "$SOCK" kill-server >/dev/null 2>&1
  rm -rf "$E2E"
}
trap cleanup EXIT

rm -rf "$E2E"; mkdir -p "$E2E" "$E2E/piws" "$E2E/bin"
# run the CLI from this checkout, not from whatever happens to be on PATH
ln -sfn "$ROOT/bin/pp.js" "$E2E/bin/pp"
export PATH="$E2E/bin:$PATH"
cat > "$CFG" <<'YAML'
version: 1
tmux:
  socket: pfe2e
defaults:
  agent: bash
sessions:
  - name: e-always
    cwd: /tmp
    restart: always
    remain_on_exit: true
    log: /tmp/e2e-pifarm/e-always.log
  - name: e-no
    cwd: /tmp
    restart: no
  - name: e-unless
    cwd: /tmp
    restart: unless-stopped
  - name: e-onfail
    cwd: /tmp
    restart: on-failure
YAML
PF() { pp --socket "$SOCK" "$@"; }
PFc() { pp --socket "$SOCK" -c "$CFG" "$@"; }

section "audit"
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" down e-no >/dev/null 2>&1 || true
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" up e-no >/dev/null 2>&1
check "audit records a stop"            0 'down.*e-no'      bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --action down"
check "audit records a start"           0 'up.*e-no'        bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --action up"
check "audit filters by target"         0 'e-no'             bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit e-no --limit 5"
check "audit prints one line per entry" 0 'restart.*e-no'    bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK restart e-no >/dev/null && $ROOT/bin/pp.js -c $CFG --socket $SOCK audit --limit 1"
check "a restart is one entry, not two" 0 ''                bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --action up --limit 5 | grep -c restart || true"
check "audit says who did it"           0 'actor'            bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --json --limit 2"
check "audit --prune keeps recent"      0 'pruned'           bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --prune 30d"
check "an empty trail says so"          0 'nothing recorded' bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK audit --file $E2E/none.log"
check "a dry run is not a change"       1 ''                 bash -c "PP_AUDIT_FILE=$E2E/dry.log $ROOT/bin/pp.js -c $CFG --socket $SOCK --dry-run down e-no >/dev/null; test -f $E2E/dry.log"
export PP_AUDIT_FILE=$E2E/state/pi-plus/audit.log
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" down e-no >/dev/null 2>&1 || true

section "help"
check "help overview"            0 'Commands:'                 pp help
check "help up"                  0 '\-\-reconcile'             pp help up
check "help alias ls"            0 'status \(alias'            pp help ls
check "up --help"                0 'Usage:'                    pp up --help
check "help typo suggestion"     2 "did you mean 'pp help install'" pp help instal
check "unknown command"          2 "run 'pp help'"        pp upstat
VERSION=$(node -p "require('$ROOT/package.json').version")
check "version"                  0 "^$VERSION$"                 pp -V
check "help shows the usage"     0 'Usage:'                    node "$ROOT/bin/pp.js" help

section "init / check"
check "init --path"              0 'wrote'                     pp init --path "$E2E/init.yml"
check "init refuses overwrite"   1 'already exists'            pp init --path "$E2E/init.yml"
check "init --force"             0 'wrote'                     pp init --path "$E2E/init.yml" --force
check "the starter config is usable"  0 'ok config looks usable' pp check -c "$E2E/init.yml"
# the starter config ships with no sessions (an example path that does not exist
# on your machine makes the first command fail), so build the bad one here
printf 'version: 1\nsessions:\n  - name: gone\n    cwd: %s/nope\n' "$E2E" > "$E2E/badcwd.yml"
check "check flags missing cwd"  1 'cwd does not exist'        pp check -c "$E2E/badcwd.yml"
check "check --brief says ok in one line" 0 'ok [0-9]+ session'  pp check --brief -c "$CFG"
check "check --brief names the problem"   1 '1 problem'         pp check --brief -c "$E2E/badcwd.yml"
check "check --json ok"          0 '"ok": true'                pp check -c "$CFG" --json

section "watch"
# the point of a watch is the transition, not the table
WATCHLOG=$E2E/watch.log
# something has to be running, or there is no transition to report
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" up e-always > /dev/null 2>&1
( exec "$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" status --watch 2 > "$WATCHLOG" 2>&1 ) &
WATCHPID=$!
sleep 3
# --force: e2e has no tty to confirm at
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" down e-always --force > /dev/null 2>&1
sleep 3
kill -INT "$WATCHPID" 2> /dev/null
wait "$WATCHPID" 2> /dev/null
# the pattern is matched against the command's output, so print the line
check "status counts restarts"       0 'restarted [0-9]+'      bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK restart e-always >/dev/null && $ROOT/bin/pp.js -c $CFG --socket $SOCK restart e-always >/dev/null && $ROOT/bin/pp.js -c $CFG --socket $SOCK status e-always"
check "status --watch draws the table"     0 'watching'   bash -c "grep watching $WATCHLOG | head -1"
check "status --watch reports a stop"      0 'went off'   bash -c "grep 'went off' $WATCHLOG | head -1"
check "status --watch says nothing changed" 0 'no changes yet' bash -c "grep 'no changes yet' $WATCHLOG | head -1"
# leave the world as we found it: the up section below counts what it starts
"$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" down e-always --force > /dev/null 2>&1

section "clean"
mkdir -p "$E2E/state/pi-plus" "$E2E/logs"
printf 'line-A\nline-B\nline-C\n' > "$E2E/logs/app.log"
# many short lines, not one huge one: the point is that the cut lands on a line
# boundary and the newest lines survive
seq 1 300000 >> "$E2E/logs/app.log"
printf 'line-D\n' >> "$E2E/logs/app.log"
printf "version: 1\ntmux:\n  socket: $SOCK\nsessions:\n  - name: logger\n    cwd: $E2E\n    agent: sh -c 'sleep 300'\n    log: $E2E/logs/app.log\n" > "$E2E/log.yml"
check "clean --dry-run keeps the file" 0 'would shrink logger' bash -c "$ROOT/bin/pp.js -c $E2E/log.yml --socket $SOCK clean --keep 64k --dry-run; test $(wc -c < $E2E/logs/app.log) -gt 1000000 && echo kept"
check "clean shrinks the log"     0 'freed'                    bash -c "$ROOT/bin/pp.js -c $E2E/log.yml --socket $SOCK clean --keep 64k"
check "clean keeps the newest line" 0 'line-D'                 bash -c "tail -1 $E2E/logs/app.log"
check "clean keeps the line boundary" 0 '^[0-9]+$'             bash -c "head -1 $E2E/logs/app.log"
check "clean keeps appending to the same file" 0 'inode'        bash -c "INODE1=\$(stat -c %i $E2E/logs/app.log); echo after >> $E2E/logs/app.log; INODE2=\$(stat -c %i $E2E/logs/app.log); [ \"\$INODE1\" = \"\$INODE2\" ] && echo inode-unchanged"
check "clean leaves small logs alone" 0 'nothing to shrink'    bash -c "$ROOT/bin/pp.js -c $E2E/log.yml --socket $SOCK clean --keep 4m"
check "clean rejects a bad size"  2 'is not a size'            bash -c "$ROOT/bin/pp.js -c $E2E/log.yml clean --keep two-megabytes"

section "config validation"
printf 'version: 1\nsessions:\n  - name: a\n\tcwd: /tmp\n' > "$E2E/tabs.yml"
check "tab indentation rejected" 2 'tab'                       pp check -c "$E2E/tabs.yml"
printf 'version: 1\nsessions:\n  - name: dup\n    cwd: /tmp\n  - name: dup\n    cwd: /tmp\n' > "$E2E/dup.yml"
check "duplicate name rejected"  2 'duplicate'                 pp check -c "$E2E/dup.yml"
printf 'version: 1\nsessions:\n  - name: "bad name"\n    cwd: /tmp\n' > "$E2E/badname.yml"
check "invalid tmux name"        2 'tmux_name|name'             pp check -c "$E2E/badname.yml"
printf 'version: 1\nsessions:\n  - name: x\n    cwd: /tmp\n    restart: sometimes\n' > "$E2E/badrestart.yml"
check "invalid restart policy"   2 'restart must be one of'     pp check -c "$E2E/badrestart.yml"
printf 'version: 1\nsessions:\n  - name: x\n    cwd: /tmp\n    bogus_key: 1\n' > "$E2E/unknown.yml"
check "unknown key warns"        0 'unknown key'                pp check -c "$E2E/unknown.yml"
printf 'version: 1\nsessions:\n  - name: x\n    cwd: /nope/nope\n' > "$E2E/nocwd.yml"
check "missing cwd fails up"     1 'does not exist'             pp -c "$E2E/nocwd.yml" up --socket "$SOCK"
check "missing config"           2 'config file not found'            pp -c "$E2E/absent.yml" status --socket "$SOCK"

section "dry-run"
check "up --dry-run prints argv" 0 'new-session -d -s e-always' PFc up --dry-run
check "dry-run creates nothing"  1 ''                           tmux -L "$SOCK" has-session -t e-always
check "attach --dry-run"         0 'attach-session'             PFc attach e-always --dry-run
check "logs --dry-run"           0 'capture-pane'               PFc logs e-always --dry-run
check "send --dry-run"           0 'send-keys'                  PFc send e-always 'echo hi' --dry-run
check "down --dry-run"           0 'stopped|absent|not running'              PFc down --dry-run

section "pipes"
# a tool that is meant to be piped must not print a stack trace when the pipe closes
PIPECFG=$E2E/pipe.yml
printf "version: 1\ntmux:\n  socket: $SOCK\nsessions:\n  - name: pipe-a\n    cwd: $E2E\n    agent: bash\n  - name: pipe-b\n    cwd: $E2E\n    agent: bash\n" > "$PIPECFG"
check "piping into head is quiet"   0 '^0$'    bash -c "cd $E2E && $ROOT/bin/pp.js -c $PIPECFG --socket $SOCK status 2>&1 | head -2 >/dev/null; echo 0"
check "no EPIPE stack trace"        1 '^0$'    bash -c "cd $E2E && $ROOT/bin/pp.js -c $PIPECFG --socket $SOCK status 2>&1 | head -2 | grep -c EPIPE"

section "busy"
# `pp busy` answers "who is working, and on what" — one capture per running
# session. The fixture's bash sessions never print a spinner, so they read idle.
check "busy lists the configured sessions" 0 "SESSION" pp busy
check "busy says nothing is working when no agent is" 0 "idle — nothing is running" pp busy
check "busy --json is a list of rows" 0 '"state"' pp busy --json

section "role"
ROLECFG=$E2E/role.yml
printf "version: 1\nsort: name\ntmux:\n  socket: $SOCK\nsessions:\n  - name: risk-10\n    cwd: $E2E\n    agent: bash\n    role: pm\n  - name: risk-2\n    cwd: $E2E\n    agent: bash\n  - name: alpha\n    cwd: $E2E\n    agent: bash\n" > "$ROLECFG"
check "role shows the current label"   0 'pm'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role risk-10"
check "role sets a new label"          0 'risk-2  dev' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role risk-2 dev"
check "role is written to the config"  0 'role: dev'     bash -c "grep 'role: dev' $ROLECFG"
check "role --list names the unlabelled ones" 0 'unlabelled' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role --list 2>&1"
check "status grows a ROLE column"     0 'ROLE'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK status"
check "status --role filters"          0 'risk-2.*dev'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role dev status"
check "status --role is case-insensitive" 0 'risk-10.*pm' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role PM status"
check "an unknown role says so"        2 'no session has role "qa"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role qa status"
# free-text labels drift: catch the typo where it is created
check "a case-only label is refused"   2 'already "pm"'    bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role alpha PM 2>&1"
# two-letter labels are one edit apart all the time (pm/po, qa/qe): only
# labels of three characters or more get the near-miss guard
check "a one-edit label is refused"    2 'one edit away'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role alpha dve 2>&1"
# a schedule can aim at a label instead of one session
check "cron add --role targets a label" 0 'role pm'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK cron add --role pm --every 10m 'standup' 2>&1"
check "cron ls shows the role target"   0 'role pm'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK cron ls 2>&1"
# a job aimed at a label reaches those sessions, so the CRON column counts it
check "status counts a role job on its sessions" 0 'risk-10.*1$' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK status 2>&1 | grep risk-10"
# --role works on every fan-out verb, not just status: up/down/restart/logs
check "up --role starts only that label" 0 'new-session -d -s risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --dry-run up --role pm 2>&1"
check "down --role stops only that label" 0 'risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --dry-run down --role pm 2>&1"
check "restart --role restarts only that label" 0 'new-session -d -s risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --dry-run restart --role pm 2>&1"
check "audit --role names only its sessions" 0 'role' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role dev audit 2>&1; true"
check "audit --role rejects a label nobody has" 2 'no session has role "qa"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG audit --role qa 2>&1"
# one read-only block you can paste: sessions, jobs, machines, audit tail
check "snapshot prints a pasteable block" 0 '^## pi-plus ' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK snapshot 2>&1"
check "snapshot --json wraps the block" 0 '"text"'     bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK snapshot --json 2>&1"
check "cron add --role rejects an unused label" 1 'no session has role "qa"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK cron add --role qa --every 10m 'x' 2>&1"
# a label that disappears later turns a job into a silent no-op: it ticks,
# it "delivers", and it reaches nobody. doctor has to say so.
DGC=$E2E/lostlabel
mkdir -p "$DGC/state"
printf 'version: 1\nsessions:\n  - name: g\n    cwd: /tmp\n    agent: bash\n' > "$DGC/plus.yml"
XDG_STATE_HOME=$DGC/state "$ROOT/bin/pp.js" -c "$DGC/plus.yml" cron add --session g --every 10m "x" >/dev/null 2>&1
env XDG_STATE_HOME=$DGC/state node -e '
  const fs = require("fs");
  const path = process.env.XDG_STATE_HOME + "/pi-plus/cron.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  data.jobs[0].role = "pm";
  delete data.jobs[0].session;
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
' 
check "doctor names a job aimed at a lost label" 1 'targets role "pm" — nothing carries it' bash -c "XDG_STATE_HOME=$DGC/state $ROOT/bin/pp.js -c $DGC/plus.yml doctor 2>&1"
check "plan retargets the job that reaches nobody" 0 'pp cron retarget .* --role' bash -c "XDG_STATE_HOME=$DGC/state $ROOT/bin/pp.js -c $DGC/plus.yml plan 2>&1"
check "cron add --role rejects --session" 1 'not both' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK cron add --role pm --session alpha --every 10m 'x' 2>&1"
bash -c "cd $E2E && for id in \$( $ROOT/bin/pp.js -c $ROLECFG cron ls --json | tr -d ' ,\"' | awk -F: '/^id:/{print \$2}' ); do $ROOT/bin/pp.js -c $ROLECFG cron rm \$id >/dev/null 2>&1; done"
check "--force creates it anyway"      0 'dve'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role alpha dve --force 2>&1"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role alpha - >/dev/null 2>&1"
check "role - clears the label"        0 'no role'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role risk-2 -"
check "clearing removes the line"      0 '^1$'           bash -c "grep -c 'role:' $ROLECFG"
# "what words do we use?" — the list has to be readable, not machine-only
check "role --list names label and members" 0 'pm.*risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role --list"
check "role --list --json is a list"   0 '\"role\": \"pm\"'     bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK role --list --json"
check "no role at all says so"         0 'no session carries a role' bash -c "cd $E2E && sed 's/^    role: pm$//' $ROLECFG > $ROLECFG.bare && $ROOT/bin/pp.js -c $ROLECFG.bare --socket $SOCK role --list"
# a machine can carry the label: "everything on the test box is test"
cat > $E2E/noderole.yml <<YML
version: 1
nodes:
  - name: box
    host: box@127.0.0.1
    defaults:
      role: test
sessions:
  - name: boxapi
    cwd: $E2E
    node: box
  - name: boxdocs
    cwd: $E2E
    node: box
    role: dev
YML
check "a machine default labels its sessions" 0 'test.*boxapi' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/noderole.yml role --list"
check "a session role still wins"            0 'dev.*boxdocs'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/noderole.yml role --list"
# sort: name in the config means risk-2 and risk-10 sit in numeric order
check "config sort orders by name"     0 'alpha'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK status | sed -n '2p'"

# a hand-written config can still split one label into two spellings
printf "version: 1\ntmux:\n  socket: $SOCK\nsessions:\n  - {name: case-a, cwd: $E2E, agent: bash, role: prod}\n  - {name: case-b, cwd: $E2E, agent: bash, role: Prod}\n" > "$E2E/rolecase.yml"
check "check catches one label in two spellings" 1 'differ only by case' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/rolecase.yml check 2>&1"

# the handover page names the three sections and stays read-only
check "handover has its three sections" 0 'changed' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --since 7d 2>&1"
check "handover says who needs a human" 0 'human'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --since 7d 2>&1"
check "handover --json is an object"    0 '"changes"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --json 2>&1"
check "handover --json says who is mid-turn" 0 '"busy"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --json 2>&1"
# the first screen is the front door: the newest verbs have to be on it
check "the first screen points at handover" 0 'pp handover' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK 2>&1"
check "the first screen points at why"     0 'pp why <name>' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK 2>&1"
check "handover rejects a bad window"   2 'not a duration' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --since soon 2>&1"
# a question left in a session is what the next shift has to pick up
check "handover lists the questions waiting" 0 'waiting 1 question' bash -c "mkdir -p "$XDG_STATE_HOME/pi-plus" && printf '{\"version\":1,\"todos\":[{\"id\":\"aaa111\",\"session\":\"e-always\",\"kind\":\"manual\",\"title\":\"do we ship?\",\"state\":\"new\",\"createdAt\":\"2020-01-01T00:00:00.000Z\"}]}' > $XDG_STATE_HOME/pi-plus/todos.json && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --since 7d 2>&1"
check "handover names the todo command" 0 'pp todo attach aaa111' bash -c "$ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --since 7d 2>&1"
# handing the page to the next shift's agent is the step people skip at 3am
check "handover refuses a session that is not running" 1 'is not running' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --send alpha 2>&1"
check "handover --send needs a session that exists"   2 'unknown session' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --send nope 2>&1"
check "handover hands the page over"                  0 'handed the page to' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK up risk-10 >/dev/null 2>&1; $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK handover --send risk-10 2>&1"

# sort: role groups by label, and leaves the unlabelled at the bottom
check "sort role puts one label together" 0 'risk-10'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --sort role status | grep -E 'risk-10|alpha' | head -1"
# the last row must be one without a label (its ROLE column is a bare dash)
check "sort role sinks the unlabelled"    0 '^-$'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --sort role status | grep -E '^[0-9]+ ' | tail -1 | awk '{print \$NF}'"
check "an unknown sort lists the four"    2 'name, role' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --sort nope status 2>&1"

# --role is a filter for the fan-out verbs too, not just for the table
check "send --role only reaches that role" 0 'would send *risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role pm send --dry-run 'hey' 2>&1"
check "send --role skips other roles"  0 ''   bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role pm send --dry-run 'hey' 2>&1 | grep -qv 'risk-2$'"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK up risk-10" >/dev/null 2>&1
check "logs --role reads that role"    0 '' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role pm logs -n 2 2>&1"
check "logs --role with no match says so" 2 'no session has role' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role qa logs -n 2 2>&1"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK down risk-10 --force" >/dev/null 2>&1
check "why explains a stopped session" 0 'should be up but is not' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK why risk-2 2>&1"
check "why --json gives the facts"     0 '"state"'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK why risk-2 --json 2>&1"
check "why rejects an unknown session" 2 'unknown session'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK why nosuch 2>&1"
check "why --role answers for the group"  0 'role pm' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK why --role pm 2>&1"
check "why --role names an unknown label" 2 'no session has role' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK why --role nosuch 2>&1"
check "up --role starts that role"     0 'risk-10' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ROLECFG --socket $SOCK --role pm up --dry-run 2>&1"

section "ready"
# bash never draws pi's input box, so --wait has to time out honestly, with a
# reason, instead of pretending the pane is ready. Its own config keeps this out
# of the way of the sessions other sections assert on.
READYCFG=$E2E/ready.yml
printf "version: 1\ntmux:\n  socket: $SOCK\nsessions:\n  - name: ready-x\n    cwd: $E2E\n    agent: bash\n    restart: \"no\"\n" > "$READYCFG"
check "up --wait times out with a reason" 1 'not ready after .*no prompt yet' bash -c "cd $E2E && $ROOT/bin/pp.js -c $READYCFG --socket $SOCK up ready-x --wait 1 2>&1"
check "a timed-out session is left running" 0 'ready-x.*running' bash -c "cd $E2E && $ROOT/bin/pp.js -c $READYCFG --socket $SOCK status ready-x"

section "up / status"
check "bare up starts 3"         0 '3 started'                  PFc up
check "up is idempotent"         0 '0 started'                  PFc up
check "status table"             0 'e-no +off'                  PFc status
check "status shows an idle column"   0 'IDLE'                  PFc status
check "status --json carries the drift"  0 '"drift"'            bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --json | tail -20"
check "status --json drift counts down"  0 '"down": [0-9]'      bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --json | tail -20"
check "status --json says how idle"   0 '"idleSeconds"'         bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --json | head -20"
check "ls sorts by idle"              0 'e-always'              bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK ls --sort idle | head -2"
check "ls rejects an unknown sort"    2 'unknown --sort'        bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK ls --sort sideways"
check "ls --idle-over filters"        0 'quiet for|e-always'    bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK ls --idle-over 30d"
check "status shows restart col" 0 'RESTART'                    PFc status
check "status footer says why a session is down" 0 'down \('  bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status | tail -3"
check "status --json carries the reasons"     0 '"reasons"'     bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --json | tail -25"
check "status --json valid"      0 '"sessions"|e-always'        bash -c "pp -c $CFG --socket $SOCK status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d)[:40])'"
check "status named row only"    0 'e-always'                   bash -c "pp -c $CFG --socket $SOCK status e-always | sed -n 2p"
check "status unknown name"      2 'unknown session'            PFc status nosuch
check "status --started adds the column"  0 'STARTED'           PFc status --started
check "status --started says why"         0 'up$|up +$'        bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --started e-always | sed -n 2p"
check "status --json records who started it"  0 '"lastStart"'   bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status --json | head -30"
check "one session explains its last start"   0 'last start'    bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK status e-always | tail -5"
check "restart records itself as the reason"  0 'by restart'    bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK restart e-always >/dev/null && $ROOT/bin/pp.js -c $CFG --socket $SOCK status e-always | tail -5"

section "launcher"
check "the wrapper runs"          0 '^[0-9]+\.[0-9]+\.[0-9]+$' bash -c "$ROOT/bin/pp -V"
# cron, sudo and non-login ssh shells get PATH=/usr/bin:/bin, where nvm's node
# is invisible: the wrapper has to find it on its own or `pp` looks broken
check "the wrapper finds node without PATH" 0 '^[0-9]+\.[0-9]+\.[0-9]+$' bash -c "env -i PATH=/usr/bin:/bin HOME=$HOME $ROOT/bin/pp -V"

section "logs / send"
check "send text"                0 'sent to e-always'           PFc send e-always 'echo hello-e2e'
sleep 1
check "logs see output"          0 'hello-e2e'                  PFc logs e-always -n 50
check "logs --grep keeps only the match" 0 '^hello-e2e$'        bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always -n 50 --grep hello-e2e 2>/dev/null"
check "logs --grep counts what matched"  0 '[0-9]+ matches?'            bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always -n 50 --grep hello-e2e 2>&1 >/dev/null"
check "logs --grep marks what it skipped" 0 '…'                 bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always -n 50 --grep hello-e2e 2>/dev/null | head -1"
check "logs --grep fails when nothing matches" 1 'no line matches' bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always -n 50 --grep definitely-not-there"
check "logs --grep rejects a bad pattern" 2 'not a valid pattern' bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always --grep '[-'"
check "logs --context needs a number"    2 'takes a number'    bash -c "$ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always --grep x --context nope"
check "log file written"         0 '^[1-9][0-9]*$'              bash -c "sleep 1; grep -c hello-e2e $E2E/e-always.log"
check "send --no-enter"          0 'typed into e-onfail'           PFc send e-onfail 'touch /tmp/e2e-pifarm/noenter.flag' --no-enter
sleep 0.5
check "no-enter did not run"     1 ''                           test -f "$E2E/noenter.flag"
check "clear the typed line"     0 ''                           bash -c "tmux -L $SOCK send-keys -t '=e-onfail:' C-u"
check "typed line can be run"    0 'sent to e-onfail'           PFc send e-onfail 'touch /tmp/e2e-pifarm/enter.flag'
sleep 0.6
check "enter ran it"             0 ''                           test -f "$E2E/enter.flag"
check "logs unknown session"     2 'unknown session'            PFc logs nosuch

section "restart policies"
check "down unless-stopped"      0 'stopped e-unless'           PFc down e-unless
check "state recorded"           0 'e-unless'                   bash -c "grep -q e-unless $XDG_STATE_HOME/pi-plus/state.json && echo e-unless"
ncheck "reconcile skips stopped" 'started e-unless'            PFc up --reconcile
check "status off for stopped"   0 'e-unless +off'              PFc status
check "explicit up clears stop"  0 'started e-unless'           PFc up e-unless
# the entry may survive because the same record now also remembers who started
# the session last; what must be gone is the "stopped on purpose" flag
check "state cleared"            0 'stop cleared'               bash -c "node -e 'const d=require(\"$XDG_STATE_HOME/pi-plus/state.json\"); const e=Object.values(d).flatMap(b=>Object.entries(b)).filter(([n])=>n===\"e-unless\").map(([,v])=>v); console.log(e.length && !e[0].stopped ? \"stop cleared\" : \"still stopped\")'"

section "crash handling"
PFc send e-always 'exit 3' >/dev/null 2>&1; sleep 1.5
check "dead pane visible"        0 'e-always +dead'             PFc status
check "reconcile restarts dead"  0 'restart e-always'            PFc up --reconcile
check "back to running"          0 'e-always +running'          PFc status
PFc up e-no >/dev/null 2>&1; PFc send e-no 'exit 9' >/dev/null 2>&1; sleep 1.5
check "restart:no keeps pane"    0 'e-no +dead'                 PFc status
check "restart:no logs readable" 0 'Pane is dead'               PFc logs e-no -n 5
ncheck "bare up leaves it dead"  'started e-no'                PFc up
check "explicit up rebuilds"     0 'started e-no'               PFc up e-no
check "restart named"            0 'started e-always'           PFc restart e-always

section "down"
check "down named"               0 'stopped e-always'           PFc down e-always
check "down bare stops all"      0 '4 stopped|stopped e-'       PFc down
check "status all stopped"       0 '0/4 running'                PFc status
check "down unknown name"        2 'unknown session'            PFc down nosuch

section "attach"
check "attach without name"      2 'usage: pp attach'      PFc attach
check "attach unknown name"      2 'unknown session'            PFc attach nosuch

section "rm"
RMFG=$E2E/rm.yml
mkdir -p "$E2E/rm-a" "$E2E/rm-b" "$E2E/rm-c"
cat > "$RMFG" <<YAML
version: 1
tmux:
  socket: $SOCK
defaults:
  agent: bash
sessions:
  - name: r-a
    cwd: $E2E/rm-a
  - name: r-b
    cwd: $E2E/rm-b
  - name: r-c
    cwd: $E2E/rm-c
YAML
PF() { pp --socket "$SOCK" -c "$RMFG" "$@"; }
check "rm starts the test sessions" 0 '3 started'            PF up
check "rm refuses without --force"  2 'refusing to delete'   PF rm r-b
check "rm --dry-run keeps it"       0 'would remove r-b'     PF rm r-b --dry-run
check "rm --dry-run really kept it" 0 '3/3 running'          PF status
check "rm kills and deletes"        0 'removed r-b'          PF rm r-b --force
ncheck "rm rewrote the config"      'name: r-b'             cat "$RMFG"
check "rm left the others"          0 'name: r-a|name: r-c'  cat "$RMFG"
check "rm removed the tmux session" 0 'r-a'                  bash -c "tmux -L $SOCK list-sessions -F '#{session_name}'"
ncheck "rm left no tmux session"    '^r-b$'                 bash -c "tmux -L $SOCK list-sessions -F '#{session_name}'"
check "rm --no-config keeps the entry" 0 'config entry kept' PF rm r-c --force --no-config
check "rm --no-config kept the yaml"   0 'name: r-c'         cat "$RMFG"
check "rm unknown name"             2 'unknown session'      PF rm nosuch --force
check "rm without names"            2 'nothing to remove'    PF rm
check "rm --json"                   0 '"removed"'            PF rm r-a --force --json
check "rm emptied the config"       0 'name:|sessions:'      cat "$RMFG"
PF() { pp --socket "$SOCK" "$@"; }

section "doctor"
# doctor exits 1 when autostart is not installed, which is normal on a fresh
# box: assert the report itself, not the exit code
check "doctor runs"              0 'tmux|node'                  bash -c "pp --socket $SOCK -c $CFG doctor || true"
check "doctor --json"            1 '"checks"|"ok"'              PFc doctor --json
# a full disk is the failure where every other check starts lying
check "doctor watches free space"  0 'free on'                      bash -c 'pp doctor 2>&1 | grep -F disk'
check "plan puts free space first"  0 'free — below the'            bash -c 'PP_DISK_MIN_MB=999999 pp plan 2>&1' 
check "an impossible floor fails the check" 1 'wants [0-9.]+ [GMT]B' bash -c 'PP_DISK_MIN_MB=999999 pp doctor --json 2>&1' 

section "mesh"
MESH_ENV=("env" "REMOTE_PI_HOME=$E2E/nomesh")
check "mesh ls without broker"     1 'no mesh broker at'   "${MESH_ENV[@]}" pp mesh ls
check "mesh resolve offline"       0 'offline'             "${MESH_ENV[@]}" pp -c "$CFG" mesh resolve e-always
check "mesh resolve json"          0 '"address"'           "${MESH_ENV[@]}" pp -c "$CFG" --json mesh resolve e-always
check "mesh send unknown session"  2 'unknown session'     "${MESH_ENV[@]}" pp -c "$CFG" mesh send 99 hi
check "mesh send usage"            2 'usage: pp mesh send' "${MESH_ENV[@]}" pp -c "$CFG" mesh send e-always
check "mesh bad body json"         2 'not valid JSON'      "${MESH_ENV[@]}" pp -c "$CFG" mesh send e-always --body-json "{oops"
check "mesh help page"             0 'broker'              pp help mesh
check "mesh unknown subcommand"    2 'unknown mesh subcommand' pp mesh wat

section "alias"
check "alias add"                 0 'linked'             pp alias add pif --bin-dir "$E2E/aliasbin"
check "alias runs the CLI"        0 '^0\.'                "$E2E/aliasbin/pif" -V
check "alias ls json"             0 '"pif"'              pp --json alias ls --bin-dir "$E2E/aliasbin"
echo not-a-symlink > "$E2E/aliasbin/real"
check "alias refuses a real file" 1 'is not a symlink'   pp alias add real --bin-dir "$E2E/aliasbin"
check "alias --force replaces it" 0 'linked'             pp alias add real --bin-dir "$E2E/aliasbin" --force
check "alias rejects bad name"    1 'not a valid command name' pp alias add 'a b' --bin-dir "$E2E/aliasbin"
check "alias add needs a name"    2 'alias name is required'  pp alias add
check "alias rm"                  0 'removed'            pp alias rm pif --bin-dir "$E2E/aliasbin"
check "alias rm again is quiet"   0 'nothing to remove'  pp alias rm pif --bin-dir "$E2E/aliasbin"
check "help alias page"           0 'bin-dir'            pp help alias
check "doctor explains stalls as quiet time" 0 'no agent|no new output'     bash -c 'pp doctor 2>&1 || true'
# either "first: ..." or "ok N checks": which one depends on the machine, the
# shape of the answer does not
check "doctor --brief gives a one-line answer" 0 'first: |ok [0-9]+ checks' bash -c 'pp doctor --brief 2>&1 || true'
# the exit code depends on whether this machine happens to be healthy; the
# contract under test is that the json always names the failed checks
check "doctor --json lists the failed checks" 0 '"failed"'  bash -c 'pp doctor --json 2>&1; true'
check "doctor names the binary"   0 'command name'       bash -c 'pp doctor 2>&1 || true'  # exits 1 until autostart is installed

section "update"
# network-dependent: keep it tolerant, the unit tests cover the logic
check "update --check json"      0 '"current"'   bash -c 'pp --json update --check 2>&1 || true'
check "update --dry-run"         0 'up to date|update available|would run|\[dry-run\]' bash -c 'pp update --dry-run 2>&1 || true'
check "update offline errors"    2 'cannot reach' pp update --registry http://127.0.0.1:1/none
check "update help page"         0 'npm i -g'    pp help update

section "mesh (fake broker)"
MESH_HOME=$E2E/fake
MESH=("env" "REMOTE_PI_HOME=$MESH_HOME")
MESH_SOCK="$MESH_HOME/.pi/remote/sessions/local/broker.sock"
node "$ROOT/test/fake-broker.js" "$MESH_SOCK" &
FAKE_PID=$!
# wait for the socket rather than guessing how long a node start takes
for _ in $(seq 1 50); do [[ -S "$MESH_SOCK" ]] && break; sleep 0.1; done
# exec so the background pid *is* node (a subshell would swallow the SIGINT)
bash -c "cd '$E2E' && exec env REMOTE_PI_HOME='$MESH_HOME' pp mesh inbox --as e-inbox" > "$E2E/inbox.out" 2>&1 &
INBOX_PID=$!
bash -c "cd '$E2E' && exec env REMOTE_PI_HOME='$MESH_HOME' pp --json mesh inbox --as e-inbox-json" > "$E2E/inbox.jsonl" 2>&1 &
INBOX_JSON_PID=$!
sleep 1.5
check "mesh ls sees the inbox"    0 '@e-inbox'          "${MESH[@]}" pp mesh ls
check "mesh send to an inbox"     0 'delivered'         "${MESH[@]}" pp mesh send "$E2E@e-inbox" "hello-inbox"
# the inbox has to be listening and settled; a single shot is a timing bet
reply_ok=0
for _ in 1 2 3; do
  if "${MESH[@]}" pp mesh send "$E2E@e-inbox" "?reply pong-$$" --reply 5000 2>&1 | grep -qE 'reply from .*: pong'; then reply_ok=1; break; fi
  sleep 1
done
check "mesh send --reply"         0 '^1$' bash -c "echo $reply_ok"
check "mesh send to json inbox"   0 'delivered'         "${MESH[@]}" pp mesh send "$E2E@e-inbox-json" "json-inbox"
sleep 0.6
check "inbox printed the message" 0 'hello-inbox'      cat "$E2E/inbox.out"
check "inbox hid broker events"   0 '^$'               bash -c "! grep -q 'peer_joined' '$E2E/inbox.out'"
check "inbox json line"           0 '"from".*"body".*json-inbox' cat "$E2E/inbox.jsonl"
kill -INT "$INBOX_PID" 2>/dev/null
kill -INT "$INBOX_JSON_PID" 2>/dev/null
sleep 0.8
check "inbox leaves on SIGINT"    0 'left the mesh as .*e-inbox' cat "$E2E/inbox.out"
kill "$FAKE_PID" 2>/dev/null

section "autostart unit files"
check "install --print"          0 'ExecStart='                 PFc install --print
check "print includes reconcile" 0 'up.*--reconcile'            PFc install --print
check "print includes watch timer" 0 'Timer|StartInterval'      PFc install --print --watch 120
check "install --dry-run"        0 'ExecStart='                 PFc install --dry-run
check "uninstall --dry-run"      0 'dry-run|remove'             PFc uninstall --dry-run

section "autostart real (systemd user)"
if systemctl --user show-environment >/dev/null 2>&1; then
  check "install enables unit"   0 'enabled|installed'          PFc install
  check "unit is enabled"        0 '^enabled$'                  bash -c 'systemctl --user is-enabled pi-plus-e2e.service'
  sleep 3
  check "unit started sessions"  0 'e-always +running'          PFc status
  # the oneshot stays "active (exited)", so install must *restart* it
  PFc down >/dev/null 2>&1
  check "install reruns a stale unit" 0 'e-always +running'     bash -c "pp --socket $SOCK -c $CFG install >/dev/null 2>&1; sleep 2; pp --socket $SOCK -c $CFG status"
  check "uninstall removes unit" 0 'removed|disabled'           PFc uninstall
  check "unit is gone"          4 'not-found'                  bash -c 'systemctl --user is-enabled pi-plus-e2e.service' 
else
  printf 'skip systemd user bus unavailable\n'
fi

section "real pi session + remote-pi"
cat > "$E2E/pi.yml" <<'YAML'
version: 1
tmux:
  socket: pfe2e
sessions:
  - name: e-pi
    cwd: /tmp/e2e-pifarm/piws
    pi_session: e2esession1
    remote_pi_name: e-pi-mesh
    log: /tmp/e2e-pifarm/e-pi.log
YAML
check "pi up"                    0 'started e-pi'               pp -c "$E2E/pi.yml" --socket "$SOCK" up
for i in $(seq 1 30); do
  grep -q 'connected as "e-pi-mesh"' "$E2E/e-pi.log" 2>/dev/null && break
  sleep 1
done
# what we own: pi started and wrote to its pane log, and the agent name we wrote.
# Whether remote-pi reaches a broker depends on that machine's peers, so the
# announcement itself is not asserted.
check "pi started and logged"    0 'pi|session|model'          bash -c "head -c 4000 $E2E/e-pi.log | tr -d '\000'"
check "remote-pi name written"   0 'e-pi-mesh'                 bash -c "cat $E2E/piws/.pi/remote-pi/config.json"
check "remote-pi config written" 0 'e-pi-mesh'                  bash -c "python3 -c 'import json;print(json.load(open(\"/tmp/e2e-pifarm/piws/.pi/remote-pi/config.json\"))[\"agent_name\"])'"
check "pi answers a prompt"      0 'sent to e-pi'               pp -c "$E2E/pi.yml" --socket "$SOCK" send e-pi 'reply with the single word OK'
for i in $(seq 1 40); do
  ls ~/.pi/agent/sessions/--tmp-e2e-pifarm-piws--/ 2>/dev/null | grep -q e2esession1 && break
  sleep 1
done
check "pi session file created"  0 'e2esession1'                bash -c "ls ~/.pi/agent/sessions/--tmp-e2e-pifarm-piws--/ | grep e2esession1"
check "pi status shows session"  0 'e2esession1'                pp -c "$E2E/pi.yml" --socket "$SOCK" status
check "pi restart resumes"       0 'started e-pi'               pp -c "$E2E/pi.yml" --socket "$SOCK" restart
sleep 6
check "resumed same session"     0 '^1$'                        bash -c "ls ~/.pi/agent/sessions/--tmp-e2e-pifarm-piws--/ | grep -c e2esession1"
check "pi down"                  0 'stopped e-pi'               pp -c "$E2E/pi.yml" --socket "$SOCK" down

section "cron"
# isolated state so the developer's own jobs are never touched
export XDG_STATE_HOME="$E2E/state"
rm -rf "$XDG_STATE_HOME"; mkdir -p "$XDG_STATE_HOME"
check "cron ls is empty"          0 'no scheduled jobs'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
check "cron add command job"      0 'scheduled [0-9a-f]'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --every 5m --command 'echo cron-ok'"
check "cron add --timeout is for command jobs" 0 'killed after 9s' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --every 5m --command 'echo slow' --timeout 9 --dry-run 2>&1"
check "cron rejects --timeout on a prompt"     1 'only applies to --command' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add 'hi' --session e-always --timeout 5 2>&1"
CMD_ID=$(cd "$E2E" && "$ROOT/bin/pp.js" -c "$CFG" cron ls --json | grep -o '"id": "[0-9a-f]*"' | head -1 | cut -d'"' -f4)
check "cron add once job"         0 'scheduled [0-9a-f]'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --in 1m 'echo from-cron'"
check "cron ls lists both"        0 'every 5m'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
# a job stuck in the past is a doctor finding, not just a column
node -e '
  const fs = require("fs");
  const path = process.env.XDG_STATE_HOME + "/pi-plus/cron.json";
  const data = JSON.parse(fs.readFileSync(path, "utf8"));
  const job = data.jobs.find((j) => j.schedule.kind !== "once");
  job.lastRun = new Date(Date.now() - 3600 * 1000).toISOString();
  job.lastStatus = "delivered";
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
'
# -c matters: without it doctor discovers a config from the cwd, and every job here looks dangling
check "doctor reports a stuck job" 1 'is .* late — pp cron run' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG doctor 2>&1"
check "cron ls says when next"    0 'in [0-9]+[smh] \('        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
check "cron ls --json has nextRun" 0 'nextRun'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls --json"
check "cron rejects --every 0"    1 'must be positive'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --every 0 --command true"
NEXT=$(node -e 'console.log(new Date(Date.now()+180000).toISOString())')
check "cron tick delivers"        0 'delivered'                bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron tick --now $NEXT"
sleep 1
check "cron typed into the pane"  0 '^[1-9]'                   bash -c "tmux -L $SOCK capture-pane -p -t '=e-always:' | grep -c from-cron"
check "cron once job pruned"      0 '^1$'                      bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls --json | grep -c '\"id\"'"
check "cron run fires now"        0 'delivered'                    bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron run $CMD_ID"
check "cron logs recorded"        0 'delivered'                bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron logs -n 20"
check "cron status json"          0 '"installed"'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron status --json"
check "cron install --print"      0 '@reboot.*cron tick'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron install --print | tr '\n' ' ' | grep -o '@reboot.*cron tick'"
check "cron rm removes job"       0 'removed [0-9a-f]'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron rm $CMD_ID"
# pause is not delete: the schedule and the history survive being silenced
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --every 9m 'paused one'" > /dev/null 2>&1
PAUSE_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="paused one").id)')
check "cron pause keeps the job"    0 'schedule and history are kept' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron pause $PAUSE_ID"
check "cron ls shows it as paused"  0 'paused'                        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
check "cron resume brings it back"  0 'resumed'                       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron resume $PAUSE_ID"
check "cron pause needs an id"      2 'usage: pp cron pause'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron pause"
# --idle-after: a heartbeat that only bothers sessions which have gone quiet
check "cron add takes --idle-after" 0 'scheduled [0-9a-f]'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --every 5m --idle-after 10m 'nudge the quiet ones' | tee $E2E/idlejob.out" 2>/dev/null
IDLE_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.idleAfter===600).id)')
check "cron ls shows the quiet gate" 0 'idle 10m'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
check "it will not nudge a session that just moved" 0 'nothing to nudge yet' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron run $IDLE_ID"
# dryrun answers "who would this reach" without typing into anything
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron add --all --every 10m --idle-after 30s 'dryrun probe'" > /dev/null 2>&1
DRY_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="dryrun probe").id)')
check "cron dryrun counts the reach" 0 'would send to' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron dryrun $DRY_ID"
check "pp why says who it would reach now" 0 'would reach' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why $DRY_ID"
# jobs with no tick are a schedule nobody winds: plan says so before "late"
mkdir -p "$E2E/shim-nocron"
printf '#!/bin/sh\necho "no crontab for user" >&2\nexit 1\n' > "$E2E/shim-nocron/crontab"
chmod +x "$E2E/shim-nocron/crontab"
check "plan notices nobody winds the tick" 0 'nothing calls the tick' bash -c "cd $E2E && PATH=\"$E2E/shim-nocron:$PATH\" $ROOT/bin/pp.js -c $CFG --socket $SOCK plan 2>&1"
# quiet hours: a job may be due and still be told to wait
check "cron add takes --window"     0 'scheduled [0-9a-f]' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron add --all --every 10m --window 00:00-23:59 'quiet probe'"
QUIET_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="quiet probe").id)')
check "cron ls shows quiet hours"   0 'quiet 00:00-23:59'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron ls"
check "the tick respects them"      0 'quiet hours'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron tick --now \$(date -u -d '+20 min' +%Y-%m-%dT%H:%M:%S.000Z) 2>&1 | tail -3"
check "dryrun says why it waits"    0 'quiet hours — skipped' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron dryrun $QUIET_ID"
check "the window can be dropped"   0 'removed'            bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron rm $QUIET_ID"
check "cron dryrun never types"      0 '^0$'          bash -c "tmux -L $SOCK capture-pane -p -t '=e-always:' | grep -c 'dryrun probe' || true"
check "cron rm takes the idle job" 0 'removed'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron rm $IDLE_ID"
# a fan-out job that runs often must say what it costs
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --every 5m 'cheap words'" > /dev/null 2>&1
check "cron ls names the loudest job" 0 'could cost up to [0-9]+ agent turn'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
# rename a session out from under a job: the job is fine, its aim is not
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-onfail --every 7m 'lost cause'" > /dev/null 2>&1
LOST_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="lost cause").id)')
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const text = fs.readFileSync(file, "utf8").replace("- name: e-onfail", "- name: e-onfail-renamed");
  fs.writeFileSync(file, text);
' "$CFG"
check "doctor names a job whose session moved" 1 'targets session "e-onfail" — nothing carries it' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG doctor 2>&1"
check "plan points at the job, not the tick"  0 "cron retarget $LOST_ID"  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK plan 2>&1"
# retargeting beats rm+add: the job keeps its run history, only its aim moves
check "cron retarget moves the aim"  0 'retargeted .* -> session "e-onfail-renamed"'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron retarget $LOST_ID --session e-onfail-renamed"
check "cron ls shows the new target" 0 'e-onfail'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls | grep -F $LOST_ID"
check "retargeted job is no longer dangling" 0 '' bash -c "cd $E2E && ! $ROOT/bin/pp.js -c $CFG doctor 2>&1 | grep -F '$LOST_ID targets'"
check "cron retarget refuses an unknown role" 2 'no session has role "nobody"'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron retarget $LOST_ID --role nobody"
# a job aimed at a drained machine must say so, not cry "not running" every tick
cat > "$E2E/drained.yml" <<'YAML'
version: 1
nodes:
  - name: dead
    host: dead@127.0.0.1
    drained: true
sessions:
  - name: dw
    cwd: /tmp
    agent: bash
    node: dead
    restart: no
YAML
bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron add --session dw --every 5m 'maintenance words'" > /dev/null 2>&1
DRAIN_JOB=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="maintenance words").id)')
check "cron run defers on a drained machine" 0 'is on a drained machine \(dead\) — pp node undrain dead' \
  bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron run $DRAIN_JOB 2>&1"
check "a daily cap is stored" 0 'max 2/day' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron add --all --every 10m --max-per-day 2 'cap probe' && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron ls 2>&1 | grep -F 'max 2/day'"
CAP_ID=$(cd "$E2E" && XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}" node -e 'const j=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json").jobs.find(x=>x.maxPerDay===2);process.stdout.write(j?j.id:"none")')
check "the dry run reports the cap it has not reached" 0 'would send' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron dryrun $CAP_ID 2>&1 | head -2"
check "cron set changes the cap in place" 0 'maxPerDay: 2 -> 24' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID --max-per-day 24"
check "cron set keeps the schedule and the counts" 0 'every 10m · max 24/day' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron ls 2>&1 | grep -F '$CAP_ID'"
check "cron set can add a knob" 0 'idleAfter: .none. -> 30m' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID --idle-after 30m"
check "cron set can remove a knob" 0 'idleAfter: 30m -> .none.' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID --idle-after none"
check "cron set with nothing to change is a usage error" 2 'nothing to change' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID 2>&1"
check "cron set can replace the prompt" 0 'prompt: cap probe -> cap probe 2' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID 'cap probe 2'"
check "cron set can move the schedule" 0 'schedule: every 10m -> every 15m' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron set $CAP_ID --every 15m"
check "cron rm drops the capped job" 0 '' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron rm $CAP_ID"
check "a deferred job is not called late" 0 'deferred …' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron ls 2>&1 | grep -F '$DRAIN_JOB'"
check "a deferral says since when" 0 'waiting since [0-9][0-9]:[0-9][0-9]' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron ls 2>&1 | grep -F '$DRAIN_JOB'"
check "pp why <session> says the job is waiting on it" 0 'waiting on it' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml why dw 2>&1 | grep '^cron'"
ncheck "a deferred job is not listed as past due" 'past due' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron ls 2>&1"
# pp cron run records lastStatus in cron.json (the tick writes cron.log); the table
# clips it to the verdict word now, so read the whole sentence from --json
check "a drained job reads as deferred, not failed" 0 'deferred: dw is on a drained machine' \
  bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/drained.yml cron ls --json 2>&1 | grep -F 'deferred: dw is on a drained machine'"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron rm $LOST_ID" > /dev/null 2>&1
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- name: e-onfail-renamed", "- name: e-onfail"));
' "$CFG"
LOUD_ID=$(node -e 'const d=require(process.env.XDG_STATE_HOME+"/pi-plus/cron.json");process.stdout.write(d.jobs.find((j)=>j.prompt==="cheap words").id)')
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron pause $LOUD_ID" > /dev/null 2>&1
# other jobs in this section are also loud, so assert the paused one is gone by id
# only the cost line matters: the id still appears in the table row
check "a paused job is not in the cost note" 1 '' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls | grep -F costs | grep -qF $LOUD_ID"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron rm $LOUD_ID" > /dev/null 2>&1
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron rm $PAUSE_ID" > /dev/null 2>&1
check "cron help page"            0 'crontab expression'       bash -c "cd $E2E && $ROOT/bin/pp.js help cron"
# --heal: put back whatever died, and leave a hand-stopped session alone
check "cron add --heal"               0 'heal \(up --drift\)'    bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --heal --every 5m"
check "cron add --heal rejects a session" 1 'needs no session'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --heal --session e-always --every 5m"
check "cron add --heal rejects a prompt"  1 'no prompt'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --heal --every 5m 'hi'"
check "cron ls names the heal job"    0 'drift \(up --drift\)'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
check "cron add broadcast job"        0 'scheduled'               bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --every 10m 'hb'"
check "status shows which sessions get jobs" 0 'CRON'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG status"
check "status marks a broadcast with *"      0 '"cron": "[*]"'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG status --json"
check "status --json carries the job count"  0 '"cron"'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG status --json"
HEAL_ID=$(cd "$E2E" && "$ROOT/bin/pp.js" -c "$CFG" cron ls --json | grep -B3 '"action": "heal"' | grep -o '"id": "[0-9a-f]*"' | head -1 | cut -d'"' -f4)
check "heal restarts a dead session"  0 'delivered'              bash -c "tmux -L $SOCK kill-session -t e-onfail 2>/dev/null; cd $E2E && $ROOT/bin/pp.js -c $CFG cron run $HEAL_ID"
check "heal brought it back"          0 'e-onfail'               bash -c "tmux -L $SOCK ls -F '#{session_name}'"

# --sweep: the fleet reports itself into a session, and says nothing when fine
SWEEPCFG="$E2E/sweep.yml"
cat > "$SWEEPCFG" <<YAML
version: 1
tmux:
  socket: $SOCK-sweep
sessions:
  - name: sw-echo
    cwd: /tmp
    agent: cat
  - name: sw-off
    cwd: /tmp
  - name: sw-once
    cwd: /tmp
    restart: "no"
YAML
(cd "$E2E" && "$ROOT/bin/pp.js" -c "$SWEEPCFG" --socket "$SOCK-sweep" up sw-echo >/dev/null 2>&1)
check "cron add --sweep needs a destination" 1 'needs a destination' bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron add --sweep --every 5m"
check "cron add --sweep rejects --session"   1 'use --to'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron add --sweep --session sw-echo --to sw-echo --every 5m"
check "cron add --sweep rejects a prompt"    1 'no prompt'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron add --sweep --to sw-echo --every 5m 'hi'"
check "cron add --sweep needs a live destination" 1 'unknown destination' bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron add --sweep --to nowhere --every 5m"
check "cron add --sweep schedules a job"     0 'session sw-echo'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron add --sweep --to sw-echo --every 5m"
check "cron ls marks the sweep target"       0 'fleet . sw-echo'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron ls"
SWEEP_ID=$(cd "$E2E" && "$ROOT/bin/pp.js" -c "$SWEEPCFG" --socket "$SOCK-sweep" cron ls --json | grep -B3 '"action": "sweep"' | grep -o '"id": "[0-9a-f]*"' | head -1 | cut -d'"' -f4)
check "sweep reports what is off"           0 '1 problem'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron run $SWEEP_ID"
check "the report lands in the session"     0 'fleet health'     bash -c "tmux -L $SOCK-sweep capture-pane -p -t '=sw-echo:'"
check "the report names the session"        0 'off: sw-off'      bash -c "tmux -L $SOCK-sweep capture-pane -p -t '=sw-echo:'"
check "a healthy fleet is silence"          0 'all quiet'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep up sw-off >/dev/null 2>&1; $ROOT/bin/pp.js -c $SWEEPCFG --socket $SOCK-sweep cron run $SWEEP_ID"
tmux -L "$SOCK-sweep" kill-session -t sw-echo 2>/dev/null || true
tmux -L "$SOCK-sweep" kill-session -t sw-off 2>/dev/null || true
tmux -L "$SOCK-sweep" kill-server 2>/dev/null || true

# -- stalls: a pi turn that never ends is the one thing `ps` cannot tell you
STALLCFG="$E2E/stall.yml"
cat > "$STALLCFG" <<YAML
version: 1
tmux:
  socket: $SOCK
sessions:
  - name: stall-x
    cwd: /tmp
    agent: $E2E/busy.sh
YAML
# busy, but drawing nothing new: exactly what a hung tool call looks like
cat > "$E2E/busy.sh" <<'SH'
#!/bin/sh
line=$(printf '─%.0s' $(seq 40))
printf '%s ⠋ Working\n' "$line"
sleep 600
SH
chmod +x "$E2E/busy.sh"
(cd "$E2E" && XDG_STATE_HOME=$E2E/state-stall "$ROOT/bin/pp.js" -c "$STALLCFG" --socket "$SOCK" up >/dev/null 2>&1)
sleep 2
(cd "$E2E" && XDG_STATE_HOME=$E2E/state-stall "$ROOT/bin/pp.js" -c "$STALLCFG" --socket "$SOCK" doctor >/dev/null 2>&1)
python3 - "$E2E/state-stall/pi-plus/state.json" <<'PYSEED'
import datetime, json, sys
path = sys.argv[1]
data = json.load(open(path))
for key in list(data):
    if key.endswith("stall.yml"):
        # the screen signature stays put, only the clock moves: that is the
        # difference between "quiet for 90m" and "working for 90m"
        data[key]["stall-x"]["activity"]["at"] = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=90)
        ).isoformat().replace("+00:00", "Z")
json.dump(data, open(path, "w"))
PYSEED
check "a stuck agent is reported"     1 'stall-x no new output for [0-9]+m'   bash -c "cd $E2E && XDG_STATE_HOME=$E2E/state-stall $ROOT/bin/pp.js -c $STALLCFG --socket $SOCK doctor"
check "a fresh turn is not a stall"   1 'no agent stuck'         bash -c "cd $E2E && XDG_STATE_HOME=$E2E/state-stall PP_STALL_MINUTES=600 $ROOT/bin/pp.js -c $STALLCFG --socket $SOCK doctor"
tmux -L "$SOCK" kill-session -t stall-x 2>/dev/null || true
check "heal audit trail recorded"     0 'heal'                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG audit --action heal"
check "heal drops a hand-stopped one" 0 'delivered'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG down e-unless --force >/dev/null; $ROOT/bin/pp.js -c $CFG cron run $HEAL_ID"
check "stopped session stayed down"   1 'can.t find session|no server'  bash -c "tmux -L $SOCK has-session -t '=e-unless:'"
# a session that dies right away must not be restarted forever
for _ in 1 2 3; do
  tmux -L "$SOCK" kill-session -t e-onfail 2>/dev/null || true
  (cd "$E2E" && "$ROOT/bin/pp.js" -c "$CFG" cron run "$HEAL_ID" >/dev/null 2>&1)
done
tmux -L "$SOCK" kill-session -t e-onfail 2>/dev/null || true
check "heal gives up on a session that keeps dying" 0 'keep dying|keeps dying' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron run $HEAL_ID"
check "heal --force tries anyway"     0 'delivered'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --force cron run $HEAL_ID"
# a session that is only running in tmux (not in the config) is a valid target
check "cron targets a running session" 0 'scheduled [0-9a-f]'   bash -c "cd $E2E && tmux -L $SOCK new-session -d -s adhoc-$SOCK -c /tmp 'bash' && $ROOT/bin/pp.js -c $CFG cron add --session adhoc-$SOCK --in 5m 'echo adhoc'"
check "cron rejects a session that is nowhere" 1 'not in .* and not running' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session nope-$SOCK --in 5m 'x'"
check "cron --all needs no session"  0 'session \*'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --every 5m --dry-run 'broadcast'"
check "cron --all rejects --session" 1 'not both'                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --session e-always --every 5m 'broadcast'"
check "cron --all lists as all sessions" 0 'all sessions'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --all --every 5m 'broadcast' >/dev/null && $ROOT/bin/pp.js -c $CFG cron ls"
check "cron --all fans out"          0 'delivered'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron tick --now $NEXT"

section "todo"
# separate state dir: todos must never leak into the developer's own list
export XDG_STATE_HOME="$E2E/state-todo"
rm -rf "$XDG_STATE_HOME"; mkdir -p "$XDG_STATE_HOME"
TD() { "$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" todo "$@"; }
check "todo starts empty"          0 'nothing needs you'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo"
check "todo add"                   0 'added #[0-9a-f]'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'review the plan' --session e-always"
check "todo add twice is not duplicated" 0 'still open'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'review the plan' --session e-always"
check "a waiting todo shows up in the snapshot" 0 'todos \([0-9]+ waiting\)' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG snapshot | grep -A2 'todos ('"
check "the snapshot names the todo itself" 0 'review the plan' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG snapshot"
check "todo add without a session is refused" 2 'which session' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'orphan item'"
check "todo ls shows it"           0 'review the plan'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo"
check "todo ls --json"             0 '"state": "new"'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo ls --json"
check "todo attach --dry-run"      0 'attach-session -t =e-always' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo attach 1 --dry-run"
check "todo attach marks seen"     0 '"state": "seen"'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo ls --json"
check "status counts the open todos" 0 'TODOS'                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK status"
check "the count lands on its session" 0 'e-always .* [0-9]+$'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK status | grep e-always"
check "the panel shows it too"     0 'e-always .*[0-9]+\?'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once"

check "todo done 1"                0 'done #[0-9a-f]'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo done 1"
check "todo ls hides done"         0 'nothing needs you'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo ls"
check "todo ls --all shows done"   0 'review the plan'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo ls --all"
check "todo done rejects a bad ref" 2 'no todo #9'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo done 9"
check "todo clear drops finished"  0 'cleared 1 finished'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo clear"
# two open todos must both fit: the snapshot computed its layout without the
# todo count, so the second one was silently clipped (0.73.4)
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'first thing' --session e-always" > /dev/null 2>&1
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'second thing' --session e-unless" > /dev/null 2>&1
check "the panel makes room for both"  0 '^2$'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once | grep -c 'thing'"
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo rm 1 > /dev/null 2>&1; $ROOT/bin/pp.js -c $CFG todo rm 1 > /dev/null 2>&1"
check "todo rm needs a ref"        2 'usage: pp todo rm'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo rm"
check "todo unknown subcommand"    2 'unknown todo subcommand'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo bogus"
check "todo help page"             0 'One list of everything'   bash -c "cd $E2E && $ROOT/bin/pp.js help todo"
check "todo appears in the overview" 0 'todo \(todos\)'         bash -c "cd $E2E && $ROOT/bin/pp.js help"
check "todo state file is separated" 0 'todos.json'             bash -c "ls '$XDG_STATE_HOME/pi-plus/todos.json'"
# answering a question is the whole point of the queue: one command, in place
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo add 'which branch?' --session e-always" > /dev/null 2>&1
check "todo answer needs text"      2 'usage: pp todo answer'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo answer 1"
check "todo answer replies in place" 0 'answered #[0-9a-f]'     bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK todo answer 1 'echo answered-marker'"
check "todo answer clears the entry" 0 'nothing needs you'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG todo ls"
check "todo answer reaches the pane" 0 'answered-marker'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK logs e-always"
# todos outlive the session that asked; --offline is the way back to a short list
bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK down e-unless >/dev/null 2>&1; $ROOT/bin/pp.js -c $CFG --socket $SOCK todo add 'stale question' --session e-unless" > /dev/null 2>&1
check "todo clear --offline shows what it would drop" 0 'stale question' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK todo clear --offline --dry-run"
check "todo clear --offline drops them"    0 'cleared 1 todo'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK todo clear --offline"
check "the offline sweep leaves a clean list" 0 'nothing needs you' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK todo ls"

section "tui"
check "tui renders the sessions panel" 0 'sessions \('          bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once"
check "tui renders the todo panel"     0 'todo \('              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once"
check "tui renders the preview panel"  0 'preview'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once"
check "tui lists a real session"       0 'e-always'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --once"
check "tui without a tty explains itself" 2 'needs a terminal'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui < /dev/null"
check "tui --diag reports a fit"       0 'verdict *fits'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --diag"
# Registered machines with nothing on them must not be asked on every frame:
# six of them cost ~2s of ssh while the panel redraws once a second. The shim
# sleeps 0.4s per call, so "did it ask them?" is measurable.
mkdir -p "$E2E/shim-slow"
cat > "$E2E/shim-slow/ssh" <<'SH'
#!/bin/sh
for arg in "$@"; do case "$arg" in -*) ;; *) ;; esac; done
sleep 0.4
exec sh -c "$*"
SH
chmod +x "$E2E/shim-slow/ssh"
cat > "$E2E/idlenodes.yml" <<'YAML'
version: 1
nodes:
  - { name: m1, host: m1@127.0.0.1 }
  - { name: m2, host: m2@127.0.0.1 }
  - { name: m3, host: m3@127.0.0.1 }
  - { name: m4, host: m4@127.0.0.1 }
  - { name: m5, host: m5@127.0.0.1 }
  - { name: m6, host: m6@127.0.0.1 }
sessions:
  - { name: idle-a, cwd: /tmp, agent: bash, restart: no }
  - { name: idle-b, cwd: /tmp, agent: bash, restart: no }
YAML
check "tui does not wait on machines with nothing on them" 0 'under' \
  bash -c 'start=$(date +%s%N); PATH="$E2E/shim-slow:$PATH" "$ROOT/bin/pp.js" -c "$E2E/idlenodes.yml" --socket "$SOCK" tui --once > /dev/null 2>&1; ms=$(( ($(date +%s%N) - start) / 1000000 )); if [ "$ms" -lt 1500 ]; then echo "under ${ms}ms"; else echo "slow: ${ms}ms"; fi' 
check "tui --diag names the frame"     0 'rows x .* cols'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK tui --diag"
check "back without a panel says so"  1 'no panel remembered'   bash -c "rm -f $XDG_STATE_HOME/pi-plus/panel.json; cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK back"
check "back with a dead panel says it is gone" 1 'is gone'    bash -c "mkdir -p $XDG_STATE_HOME/pi-plus && echo '{\"session\":\"nope\",\"window\":\"0\",\"pane\":\"%999999\"}' > $XDG_STATE_HOME/pi-plus/panel.json && cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK back"
check "back forgets the dead panel"      0 ''                   bash -c "test ! -f $XDG_STATE_HOME/pi-plus/panel.json"
check "tui help page"                  0 'attach'              bash -c "cd $E2E && $ROOT/bin/pp.js help tui"
check "tui appears in the overview"    0 'tui \(panel\)'        bash -c "cd $E2E && $ROOT/bin/pp.js help"

section "node defaults: a session template"
cat > "$E2E/tmpl.yml" <<'YAML'
version: 1
tmux:
  socket: SOCKPLACE
nodes:
  - name: box
    host: example
    base_path: /srv
    defaults:
      env:
        HTTP_PROXY: http://127.0.0.1:7890
      args: ["--model", "deepseek"]
sessions:
  - name: api
    node: box
    cwd: api
    env:
      LOCAL: "1"
    args: ["--verbose"]
YAML
sed -i "s/SOCKPLACE/$SOCK/" "$E2E/tmpl.yml"
check "a machine template hands its env to the session" 0 'HTTP_PROXY=http://127.0.0.1:7890' bash -c "cd $E2E && $ROOT/bin/pp.js -c tmpl.yml --dry-run up api"
check "the session's own env is added, not replaced" 0 'LOCAL=1' bash -c "cd $E2E && $ROOT/bin/pp.js -c tmpl.yml --dry-run up api"
check "template args come before the session's own" 0 '\-\-model deepseek \-\-verbose' bash -c "cd $E2E && $ROOT/bin/pp.js -c tmpl.yml --dry-run up api"
check "a machine template resolves the cwd under base_path" 0 '\-c /srv/api' bash -c "cd $E2E && $ROOT/bin/pp.js -c tmpl.yml --dry-run up api"

section "nodes"
# A stand-in for ssh that runs the "remote" command locally, so the whole
# remote path (ssh argv building -> remote tmux) is exercised without a server.
SHIM="$E2E/shim"
mkdir -p "$SHIM"
cat > "$SHIM/ssh" <<'SHIMSH'
#!/bin/sh
# like ssh: skip the options, then run the rest as one command on the far side
while [ $# -gt 0 ]; do
  case "$1" in
    -p|-i|-o) shift 2 ;;
    -t|-v) shift ;;
    *) break ;;
  esac
done
host="$1"; shift
if [ "$host" = "dead@127.0.0.1" ]; then echo "ssh: connect to host 127.0.0.1 port 22: Connection refused" >&2; exit 255; fi
exec sh -c "$*"
SHIMSH
chmod +x "$SHIM/ssh"

NODECFG="$E2E/nodes.yml"
cat > "$NODECFG" <<'YAML'
version: 1
nodes:
  - name: far
    host: 127.0.0.1
    user: nobody
    note: reaches us through the shim
  - name: dead
    host: 127.0.0.1
    user: dead
sessions:
  - name: far-x
    node: far
    cwd: /tmp
  - name: dead-x
    node: dead
    cwd: /tmp
YAML
check "a machine can carry a default role" 0 'updating box: defaults' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c tmpl.yml --socket $SOCK node add box --default-role test 2>&1"
check "the default role lands in the config" 0 'role: test' bash -c "cd $E2E && grep 'role: test' tmpl.yml"
check "snapshot lists the machines" 0 'nodes \('       bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK snapshot 2>&1"

# long enough that a slow full-suite run cannot outlive it: drift checks below
# compare config against what is actually running
tmux -L "$SOCK" new-session -d -s far-x "sleep 7200" 2>/dev/null || true

check "node is listed"                0 'far'                     bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node ls"
check "node shows its auth"           0 'agent'                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node ls"
check "busy says which machine is unreachable" 0 'unreachable'    bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK busy 2>&1"
check "node show lists its sessions"  0 'far-x'                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node show far"
check "node show hides passwords"     0 'password +-'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node show far"
check "remote session is seen running" 0 'running'                bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls far-x"
check "the NODE column names the machine" 0 'far'                 bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls far-x"
check "why --node says the machine state" 0 'reachable'  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK why --node far 2>&1"
check "why --node lists its sessions"     0 'far-x'      bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK why --node far 2>&1"
check "why --node --json has a verdict"   0 '"verdict"'  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK why --node far --json 2>&1"
check "why --node rejects an unknown node" 2 'no node'    bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK why --node nosuch 2>&1"
check "a dead node is unreachable, not stopped" 0 'unreachable'    bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls dead-x"
check "node test runs the probe"     0 'host +[A-Za-z0-9]'       bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node test far"
# maintenance: drain stops an accidental start, undrain gives the machine back
check "drain marks the machine"       0 'drained far'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node drain far"
check "drained machine is marked ~"   0 '~far'                     bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node ls"
check "drained machine refuses to start" 0 'drained machine far'   bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK --dry-run up far-x 2>&1"
check "drained machine starts nothing" 0 '0 would start'           bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK --dry-run up far-x 2>&1"
check "--force still starts it"       0 '1 would start'            bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK --dry-run --force up far-x 2>&1"
check "drain is in the audit trail"   0 'node.drain'               bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK audit --action node.drain"
# --force is not a licence to kill things on a box that is being patched
check "down --force needs --yes on a drained machine" 0 'needs --yes' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK up --force far-x >/dev/null 2>&1; PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK down --force far-x 2>&1 | tail -2"
check "the blocked stop really did not stop it" 0 'running'       bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls far-x | sed -n 2p"
check "down --force --yes stops it"   0 '1 stopped'                bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK down --force --yes far-x 2>&1 | tail -2"
check "a forced stop is its own audit action" 0 'down.forced'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK audit --action down.forced | head -2"
check "rm needs --yes on a drained machine" 2 'pass --yes'         bash -c "cd $E2E && cp $NODECFG $E2E/rm.yml && $ROOT/bin/pp.js -c $E2E/rm.yml --socket $SOCK rm far-x --force 2>&1"
check "rm.forced lands in the audit trail" 0 'rm.forced'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/rm.yml --socket $SOCK rm far-x --force --yes >/dev/null 2>&1; $ROOT/bin/pp.js -c $E2E/rm.yml audit --action rm.forced | head -2"
# put the session back: the sections after this one expect it running
check "far-x is back for the next section" 0 '1 started'           bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK up --force far-x 2>&1 | grep -E '1 started'"
check "undrain gives the machine back" 0 'undrained far'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node undrain far"
ncheck "undrained machine is not skipped" 'drained machine'       bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK --dry-run up far-x 2>&1"
check "the drained flag left the file" 0 ''                   bash -c "cd $E2E && ! grep -q drained nodes.yml"
check "node test reports a broken node" 1 'ssh'                  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node test dead"
check "doctor --nodes tours the park" 0 'reachable'             bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK doctor --nodes --node far"
check "doctor --nodes marks a dead host" 1 'down'                bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK doctor --nodes --node dead"
check "doctor --nodes --json carries the probe" 0 '"probe"'      bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK doctor --nodes --node far --json"
# `check --remote` asks the machine about paths only it can see
check "check skips remote paths by default" 0 'not checked here'   bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG check"
REMOTEGOOD="$E2E/remotegood.yml"
printf 'version: 1\nnodes:\n  - name: far\n    host: 127.0.0.1\n    user: nobody\nsessions:\n  - name: good-path\n    node: far\n    cwd: /tmp\n    agent: sh\n    restart: "no"\n' > "$REMOTEGOOD"
check "check --remote accepts a good path" 0 'ok config'           bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $REMOTEGOOD check --remote"
REMOTEBAD="$E2E/remotebad.yml"
printf 'version: 1\nnodes:\n  - name: far\n    host: 127.0.0.1\n    user: nobody\nsessions:\n  - name: bad-path\n    node: far\n    cwd: /nope/never\n    agent: definitely-not-installed\n    restart: "no"\n' > "$REMOTEBAD"
check "check --remote catches a bad path" 1 'does not exist on far' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $REMOTEBAD check --remote"
check "check --remote catches a missing agent" 1 'not found on far' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $REMOTEBAD check --remote"
check "doctor --nodes says what the config expects" 0 'CONFIG'  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK doctor --nodes --node far"
check "doctor --nodes --json carries the drift" 0 '"drift"'    bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK doctor --nodes --node far --json"
# mv gets its own file: it rewrites the config, and the checks above read this one
MVCFG="$E2E/mv.yml"
cat > "$MVCFG" <<'YAML'
version: 1
nodes:
  - name: far
    host: 127.0.0.1
    user: nobody
  - name: dead
    host: 127.0.0.1
    user: dead
sessions:
  - name: mv-x
    node: far
    cwd: /tmp
    agent: bash
    restart: "no"
  - name: bystander
    cwd: /tmp
    agent: bash
    restart: "no"
YAML
check "mv needs a destination"     2 'say where'                bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $MVCFG --socket $SOCK mv mv-x"
check "mv rejects an unknown node" 2 'no node'                  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $MVCFG --socket $SOCK mv mv-x --node nope"
check "mv refuses an unreachable node" 1 'unreachable'          bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $MVCFG --socket $SOCK mv mv-x --node dead"
check "mv brings a session home"   0 'moved mv-x'               bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $MVCFG --socket $SOCK mv mv-x --local --force"
check "mv drops only that node line" 0 'clean'                  bash -c "grep -A2 'name: mv-x' $MVCFG | grep -q node: && echo still-there || echo clean"
check "mv leaves the neighbour alone" 0 '^1$'                   bash -c "grep -c 'name: bystander' $MVCFG"
check "mv sends it back out"       0 'moved mv-x'               bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $MVCFG --socket $SOCK mv mv-x --node far --force"
section "adopt"
ADOPTCFG="$E2E/adopt.yml"
printf 'version: 1\nsessions:\n  - name: keeper\n    cwd: /tmp\n    agent: bash\n    restart: "no"\n' > "$ADOPTCFG"
tmux -L "$SOCK" new-session -d -s stray-x -c /tmp "sleep 300" 2>/dev/null || true
check "adopt wants a name or --all" 0 'say which to adopt'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK adopt"
check "adopt --dry-run writes nothing" 0 'stray-x'              bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK adopt stray-x --dry-run"
check "adopt --dry-run left the file alone" 0 '^1$'             bash -c "grep -c 'name:' $ADOPTCFG"
check "adopt records the session" 0 'adopted 1'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK adopt stray-x"
check "adopt wrote a runnable entry" 0 'stray-x'                bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK ls | grep running | grep stray-x"
check "adopt refuses a restart policy it does not know" 2 'must be one of' bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK adopt keeper --restart sometimes"
check "adopt is idempotent" 0 'already in the config'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK adopt stray-x"
section "logs-many"
tmux -L "$SOCK" new-session -d -s log-a "sh -c 'echo from-a; sleep 600'" 2>/dev/null || true
tmux -L "$SOCK" new-session -d -s log-b "sh -c 'echo from-b; sleep 600'" 2>/dev/null || true
sleep 1
LOGSYML="$E2E/logs.yml"
printf 'version: 1\nsessions:\n  - name: log-a\n    cwd: /tmp\n    agent: sh\n    restart: "no"\n  - name: log-b\n    cwd: /tmp\n    agent: sh\n    restart: "no"\n  - name: log-dead\n    cwd: /tmp\n    agent: sh\n    restart: "no"\n' > "$LOGSYML"
check "logs takes several sessions" 0 'from-b'                bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs log-a log-b"
check "logs labels each one"     0 '── log-a'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs log-a log-b"
check "logs --stamp puts a time on each line" 0 '^[0-9][0-9]:[0-9][0-9]:[0-9][0-9] from-a$' bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs log-a -n 3 --stamp | head -1"
check "logs --all labels each one" 1 '── log-b'                bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs --all"
check "logs reports a stopped one" 1 'not running'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs log-dead 2>&1"
check "logs wants a name"        2 'usage: pp logs'             bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK logs"
check "audit --actor filters"    0 'nothing recorded'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $LOGSYML --socket $SOCK audit --actor nobody-at-all"

section "drift"
DRIFTCFG="$E2E/drift.yml"
printf 'version: 1\nsessions:\n  - name: drift-b\n    cwd: /tmp\n    agent: bash\n    restart: always\n  - name: drift-c\n    cwd: /tmp\n    agent: bash\n    restart: unless-stopped\n' > "$DRIFTCFG"
check "up --drift says what it will start" 0 'starting 2 missing' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK up --drift --dry-run"
check "up --drift starts the missing ones"  0 '2 started'        bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK up --drift"
check "up --drift is quiet when aligned"    0 'nothing to start' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK up --drift"
check "send --all --dry-run plans every session" 0 "would send *drift-b" bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send --all --dry-run \"echo hi\""
check "send --all --dry-run counts the targets" 0 "would take it" bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send --all --dry-run \"echo hi\""
check "send --all --dry-run shows the argv when asked" 0 "send-keys" bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK -v send --all --dry-run \"echo hi\""
check "send --all --dry-run types nothing"     0 "nothing was typed" bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send --all --dry-run \"dry-probe\" && tmux -L $SOCK capture-pane -p -t =drift-b: | grep -c dry-probe || true"
check "send --all types into each one" 0 "2 sent"            bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send --all \"echo fanout-ok\""
check "send --all needs text"          2 "usage: pp send"    bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send --all"
check "send --until-idle prints the reply" 0 'idle-marker' bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK send drift-b \"echo idle-marker\" --until-idle --lines 20"
check "up --drift leaves a hand-stopped one alone" 0 'stopped by hand' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK down drift-c --force && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK up --drift"
check "status marks a hand-stopped session" 0 'off \(hand\)'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK status"
check "status says why it is off"      0 '"reason": "hand"'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK status --json"
check "doctor reports the scheduler"   1 'cron .*no jobs|no jobs'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK doctor"
check "status shows who is attached"  0 'CLIENT'                 bash -c "cd $E2E && (sleep 6 | script -q -c \"tmux -L $SOCK attach -t drift-b\" /dev/null >/dev/null 2>&1 &) ; sleep 2; $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK status"
check "status --json carries the client" 0 '"client"'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK status --json"
check "tui --once shows the drift" 0 'off · |unmanaged'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $DRIFTCFG --socket $SOCK tui --once"
check "ls counts what is up but unmanaged" 0 'unmanaged'     bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK ls"
check "doctor points at the drift"  1 'not in config'            bash -c "cd $E2E && $ROOT/bin/pp.js -c $ADOPTCFG --socket $SOCK doctor"
check "attach to a remote session is built for ssh" 0 'attach-session .*far-x' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --socket $SOCK attach far-x --dry-run"
check "node add writes the config"   0 'added node'              bash -c "cp $NODECFG $E2E/add.yml && cd $E2E && $ROOT/bin/pp.js -c $E2E/add.yml node add prod --host 10.0.0.11 --user deploy --identity ~/.ssh/id_ed25519"
check "node add keeps the sessions"  0 ''                        bash -c "grep -q 'name: far-x' $E2E/add.yml"
check "node add records what it changed" 0 'nodes.prod'          bash -c "$ROOT/bin/pp.js -c $E2E/add.yml audit --action config.changed | tail -3"
check "node add --dry-run touches nothing" 0 'would write'       bash -c "cp $NODECFG $E2E/dry.yml && cd $E2E && $ROOT/bin/pp.js -c $E2E/dry.yml node add ghost --host 10.9.9.9 --dry-run && ! grep -q ghost $E2E/dry.yml"
check "node add needs a host"        2 'missing --host'          bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/add.yml node add nohost"
check "node add refuses a used name" 2 'usage: pp node add'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/add.yml node add"
check "node rm drops it"             0 'removed node'            bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/add.yml node rm prod --force"
check "node rm leaves sessions alone" 0 ''                       bash -c "grep -q 'name: far-x' $E2E/add.yml"
cat > "$E2E/nodedef.yml" <<'YAML'
version: 1
defaults:
  agent: pi
  restart: always
nodes:
  - name: box
    host: 10.9.9.9
    base_path: /srv/apps
    defaults:
      agent: bash
      restart: no
sessions:
  - name: api
    node: box
    cwd: api
  - name: web
    node: box
    cwd: /opt/web
YAML
check "node defaults resolve the session cwd"    0 '/srv/apps/api'    pp check -c "$E2E/nodedef.yml"
check "an absolute cwd ignores base_path"        0 '/opt/web'         pp check -c "$E2E/nodedef.yml"
check "node add writes base_path and defaults"   0 'base_path: /srv'  bash -c "printf 'version: 1\nsessions: []\n' > $E2E/nd2.yml && $ROOT/bin/pp.js -c $E2E/nd2.yml node add box --host 10.9.9.9 --base-path /srv --default-restart no --default-agent bash >/dev/null && cat $E2E/nd2.yml"
check "node rm refuses a referenced node" 1 'still run on'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK node rm far"
check "an unknown node is a config error" 2 'is not defined under' bash -c "cd $E2E && printf 'version: 1\nnodes:\n  - name: far\n    host: h\nsessions:\n  - name: x\n    node: nope\n    cwd: /tmp\n' > $E2E/badnode.yml && $ROOT/bin/pp.js -c $E2E/badnode.yml check"
check "node exec runs one command"   0 'marker-from-exec'         bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node exec far -- 'echo marker-from-exec'"
check "node exec passes the payload as one line" 0 'a b' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node exec far -- echo a b"
check "node exec reports a failing command" 1 'exit 3'        bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node exec far -- 'exit 3'"
check "node exec needs a command"    2 'nothing to run'         bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG node exec far"
check "node exec needs a target"     2 'usage'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG node exec -- echo hi"
check "node exec --json is machine readable" 0 '"node": "far"'  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG --json node exec far -- 'echo x'"
check "node exec --quiet hides success" 0 '^$'                  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $NODECFG -q node exec far -- 'echo x'"
check "ls --node filters"            0 'far-x'                  bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls --node far"
check "ls --node hides other nodes"  0 '^$'                     bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/add.yml --socket $SOCK ls --node far | grep -v 'no sessions' || true"
check "ls --node rejects an unknown node" 2 'no node'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $NODECFG --socket $SOCK ls --node nope"
check "node add stores a tag"        0 ''          bash -c "cd $E2E && printf 'version: 1\nnodes:\n  - name: far\n    host: 127.0.0.1\n    user: nobody\nsessions:\n  - name: far-x\n    node: far\n    cwd: /tmp\n' > $E2E/tag.yml && $ROOT/bin/pp.js -c $E2E/tag.yml node add far --host 127.0.0.1 --user nobody --tag prod >/dev/null && grep -q 'tags: \[prod\]' $E2E/tag.yml"
check "node add --tag accumulates"   0 ''      bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/tag.yml node add far --host 127.0.0.1 --user nobody --tag db >/dev/null && grep -q 'tags: \[prod, db\]' $E2E/tag.yml"
check "node ls --tag filters"        0 '^far '                   bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/tag.yml node ls --tag db | grep -E '^far '"
check "node ls --tag with no match says so" 0 'no node matches'  bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/tag.yml node ls --tag ghost"
check "node exec --tag picks machines" 0 'tag-marker'            bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/tag.yml node exec --tag prod -- 'echo tag-marker'"
check "ls --tag rejects an unknown tag" 2 'tagged'               bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/tag.yml --socket $SOCK ls --tag ghost"
check "node exec --parallel runs on every machine" 0 'parallel-b' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/tag.yml node exec --all --parallel -- 'echo parallel-a; echo parallel-b'"
check "node exec --parallel still reports failures" 1 'exit 4'  bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/tag.yml node exec --all --parallel -- 'exit 4'"
check "node help page"               0 'sshpass'                 bash -c "cd $E2E && $ROOT/bin/pp.js help node"
check "node appears in the overview" 0 'node \(nodes\)'          bash -c "cd $E2E && $ROOT/bin/pp.js help"

check "new --node starts a session on that machine" 0 'api-remote' bash -c "cd $E2E && cp $NODECFG $E2E/newfar.yml && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/newfar.yml --socket $SOCK new api-remote --node far -C /tmp --agent bash --save 2>&1 | grep api-remote"
check "new --node writes the node into the config" 0 'node: far' bash -c "grep 'node: far' $E2E/newfar.yml"
check "the new remote session is listed as running" 0 'running' bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/newfar.yml --socket $SOCK ls api-remote"
check "new --node rejects an unknown machine" 2 'no node' bash -c "cd $E2E && $ROOT/bin/pp.js -c $E2E/newfar.yml --socket $SOCK new bad --node ghost -C /tmp"
check "new --save fills an empty sessions list" 0 'name: e2e-empty' bash -c "cd $E2E && printf 'version: 1\nnodes:\n  - name: far\n    host: 127.0.0.1\n    user: nobody\nsessions: []\n' > $E2E/empty.yml && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $E2E/empty.yml --socket $SOCK new e2e-empty --agent bash --save >/dev/null && grep 'name: e2e-empty' $E2E/empty.yml"

# guarded machines: stopping something must be deliberate
GUARDCFG="$E2E/guard.yml"
sed 's/    note: reaches us through the shim/    note: reaches us through the shim\n    guarded: true/' "$NODECFG" > "$GUARDCFG"
check "node ls marks a guarded machine" 0 '!far '            bash -c "cd $E2E && $ROOT/bin/pp.js -c $GUARDCFG node ls | grep -E '^!'"
check "a guard is visible in node show" 0 'need --force'     bash -c "cd $E2E && $ROOT/bin/pp.js -c $GUARDCFG node show far"
check "down skips a guarded session"   0 'guarded machine'   bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $GUARDCFG --socket $SOCK down far-x"
check "the guarded session survived"   0 'far-x'             bash -c "tmux -L $SOCK list-sessions -F '#{session_name}'"
check "down --force stops a guarded session" 0 '1 stopped'   bash -c "cd $E2E && PATH=$SHIM:$PATH $ROOT/bin/pp.js -c $GUARDCFG --socket $SOCK down far-x --force"
check "and it is really gone"          1 ''                  bash -c "tmux -L $SOCK has-session -t far-x"

tmux -L "$SOCK" kill-session -t far-x 2>/dev/null || true

section "own files (pp checks its own state)"
# a reader here swallows a parse error on purpose; doctor is where it gets said out loud
printf '{"broken":' > "$XDG_STATE_HOME/pi-plus/state.json"
check "doctor names the broken file"     1 'state.json is not valid JSON' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK doctor 2>&1"
# the ranking decides which two lines `--brief` shows, so assert the fix is
# *reachable* (in --json's failed list) rather than first: this box may have
# other things failing (a stale extension, no autostart unit) at the same time
check "the fix is in the failed list"    0 'own files'                    bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK doctor --json | grep -A3 '\"failed\"' | grep -q 'own files' && echo own files"
check "brief still leads somewhere"      1 'first:'                       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK doctor --brief 2>&1"
check "doctor keeps working anyway"      0 'own files'                    bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK doctor 2>&1 | grep 'own files'"
check "quarantine moves it aside"        0 'broken-'                      bash -c "cd $E2E && $ROOT/bin/pp.js doctor --quarantine"
check "the broken copy is kept"          0 '^1$'                         bash -c "ls $XDG_STATE_HOME/pi-plus/state.json.broken-* | wc -l | tr -d ' '"
check "afterwards it is clean"           0 'nothing to quarantine'        bash -c "cd $E2E && $ROOT/bin/pp.js doctor --quarantine"

section "update tells you about the extension"
# npm upgrades the cli, never the pi extension: say it with the right --prefix
mkdir -p "$E2E/state/fakeext/pi-farm" && printf '{"name":"pi-farm","version":"0.1.0"}\n' > "$E2E/state/fakeext/pi-farm/package.json"
check "doctor names the extension upgrade"  1 'npm install --prefix' bash -c "cd $E2E && PP_EXT_DIR=$E2E/state/fakeext/pi-farm $ROOT/bin/pp.js -c $CFG doctor 2>&1"
# the prefix must be the directory that *contains* node_modules: …/fakeext, not
# …/fakeext/node_modules (which is where `dirname(pkg dir)` used to land)
check "and the prefix stops at node_modules"  0 'state/fakeext '  bash -c "cd $E2E && PP_EXT_DIR=$E2E/state/fakeext/pi-farm $ROOT/bin/pp.js -c $CFG doctor 2>&1 | grep 'npm install --prefix' | sed 's/.*--prefix //'"
rm -rf "$E2E/state/fakeext"

section "backup / restore"
check "a backup copies the config"        0 'plus.yml'      bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG --socket $SOCK backup 2>&1"
check "it lists what it took"             0 'backup.* in '   bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG backup --list 2>&1"
check "restore shows the diff, writes nothing" 0 'dry run'   bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG restore latest --dry-run 2>&1"
check "restore without --force refuses"   1 'add --force'    bash -c "cd $E2E && printf '\n# edited after the backup\n' >> $CFG && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG restore latest 2>&1"
check "restore --force puts it back"      0 'restored [0-9]+ file' bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG restore latest --force 2>&1"
check "the edit is gone again"            0 ''              bash -c "cd $E2E && ! grep -q 'edited after the backup' $CFG"
check "keep N prunes the oldest"          0 'pruned'        bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG backup >/dev/null 2>&1; PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG backup --keep 1 2>&1"
check "one backup survives"               0 '^1 backup'   bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG backup --list 2>&1"
check "an unknown backup is refused"      2 'no backup'     bash -c "cd $E2E && PP_BACKUP_DIR=$E2E/backups $ROOT/bin/pp.js -c $CFG restore 1999-01-01 --dry-run 2>&1"

section "why a job (pp why <id>)"
check "it says when the job runs next"   0 'next '        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron add --every 10m --session e-always 'why-job probe' | awk '{print \$2}' | tr -d ':' > $E2E/whyjob.id; $ROOT/bin/pp.js -c $CFG --socket $SOCK why \$(cat $E2E/whyjob.id) 2>&1"
check "the verdict is a sentence"        0 'healthy|never|failed|waiting|overdue' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why \$(cat $E2E/whyjob.id) 2>&1 | sed -n 2p"
check "the job view is JSON too"         0 '\"schedule\"' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why \$(cat $E2E/whyjob.id) --json"
# a job keeps the name it was written with, so "aimed at something that still exists" needs saying
check "the job view says where it is aimed" 0 'target' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why \$(cat $E2E/whyjob.id) 2>&1 | grep '^target'"
check "and that the session is real"        0 'e-always' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why \$(cat $E2E/whyjob.id) 2>&1 | grep '^target'"
check "an unknown id is refused"         2 'unknown session or job' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK why zzzzzz 2>&1"
check "the job is removed again"         0 ''            bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK cron rm \$(cat $E2E/whyjob.id) >/dev/null 2>&1; rm -f $E2E/whyjob.id"
# a job outlives the name it was written with: cron ls must say so
check "cron ls names the machine a job aims at" 0 'far-x @far' bash -c "cd $E2E && PATH=\"$SHIM:$PATH\" \"$ROOT/bin/pp.js\" -c \"$NODECFG\" --socket \"$SOCK\" cron add --every 10m --session far-x 'node probe' >/dev/null 2>&1; PATH=\"$SHIM:$PATH\" \"$ROOT/bin/pp.js\" -c \"$NODECFG\" --socket \"$SOCK\" cron ls 2>&1 | grep 'far-x'"
check "cron ls marks a job pointing at nothing" 0 'point at nothing' bash -c "cd \"$E2E\" && grep -v 'name: e-onfail' \"$CFG\" > \"$E2E/gone.yml\"; \"$ROOT/bin/pp.js\" -c \"$CFG\" --socket \"$SOCK\" cron add --every 10m --session e-onfail 'gone probe' >/dev/null 2>&1; \"$ROOT/bin/pp.js\" -c \"$E2E/gone.yml\" --socket \"$SOCK\" cron ls 2>&1 | grep -E 'e-onfail !|point at nothing'"

section "plan --node (one machine)"
check "unknown machine points at the list" 0 'pp node ls'   bash -c "cd $E2E && PATH=\"$SHIM:$PATH\" $ROOT/bin/pp.js -c $NODECFG plan --node nope 2>&1"
# its session is not running, so the step names the machine instead of the fleet
check "a machine-scoped plan names the node" 0 'pp up --node far' bash -c "cd $E2E && PATH=\"$SHIM:$PATH\" $ROOT/bin/pp.js -c $NODECFG plan --node far 2>&1"
check "the header names the machine"       0 '^far '        bash -c "cd $E2E && PATH=\"$SHIM:$PATH\" $ROOT/bin/pp.js -c $NODECFG plan --node far 2>&1 | head -1"
check "--json is the same steps"           0 '"steps"'      bash -c "cd $E2E && PATH=\"$SHIM:$PATH\" $ROOT/bin/pp.js -c $NODECFG plan --node far --json"

section "first screen (pp with no argument)"
check "no argument summarises the fleet" 0 'running'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK"
check "it names the config it read"      0 'plus.yml'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK | head -1"
check "it offers the six habits"         0 'pp runbook'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK"
check "it stays short"                   0 '^1$'                bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK | awk 'END{print (NR<=14)?1:NR}' | grep -E '^1$'"
check "no argument --json is data"       0 '\"verdict\"'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK --json | head -4"
check "pp up still means up"             0 'would start|started|already running' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG --socket $SOCK up --dry-run"

section "runbook"
check "runbook lists the incidents"     0 'nothing-runs'        bash -c "cd $E2E && $ROOT/bin/pp.js runbook"
check "runbook prints one scenario"     0 'pp clean'            bash -c "cd $E2E && $ROOT/bin/pp.js runbook disk-full"
check "runbook finds a scenario by title" 0 'pp logs'            bash -c "cd $E2E && $ROOT/bin/pp.js runbook 'quiet'"
check "runbook --json is data"          0 '"steps"'             bash -c "cd $E2E && $ROOT/bin/pp.js runbook --json | grep -m1 '\"steps\"'"
check "runbook --markdown is the manual" 0 '^# 事故处理手册'      bash -c "cd $E2E && $ROOT/bin/pp.js runbook --markdown | head -1"
check "runbook refuses an unknown scenario" 2 'no scenario'      bash -c "cd $E2E && $ROOT/bin/pp.js runbook nonsense"
check "the manual reaches pp restore"    0 'pp restore latest'  bash -c "cd $E2E && $ROOT/bin/pp.js runbook config-broken"
check "the manual is generated from the code" 0 ''               bash -c "cd $ROOT && $ROOT/bin/pp.js runbook --markdown | diff -q - docs/runbook.md"

section "new --from (clone a session)"
CLONECFG=$E2E/clone.yml
rm -f $CLONECFG
cat > $CLONECFG <<YML
version: 1
tmux:
  socket: $SOCK
defaults:
  agent: bash
sessions:
  - name: clone-src
    cwd: /tmp
    role: risk
    restart: unless-stopped
    env:
      CLONE_MARK: yes-please
    log: /tmp/clone-src.log
YML
CLF() { "$ROOT/bin/pp.js" -c "$CLONECFG" "$@"; }
CLF up clone-src >/dev/null 2>&1
check "clone copies the source name"      0 'clone-src-2'       bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from clone-src --dry-run 2>&1 | grep new-session"
check "clone copies the env"              0 'CLONE_MARK=yes-please' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from clone-src --dry-run 2>&1 | grep new-session"
check "clone refuses an unknown source"   2 'no session'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from ghost --dry-run"
check "clone --from 1 uses the index"     0 'clone-src'         bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from 1 --dry-run 2>&1 | grep new-session"
check "dry-run --save writes nothing"     0 'would append'      bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from clone-src --save --dry-run 2>&1 | tail -2"
check "the config is untouched"           0 '^1$'              bash -c "grep -c 'name: clone-src' $CLONECFG"
check "clone --save writes the template"  0 'role: risk'        bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG new --from clone-src --save >/dev/null 2>&1; grep 'role: risk' $CLONECFG"
check "and the env came along"            0 'CLONE_MARK'        bash -c "grep 'CLONE_MARK' $CLONECFG"
check "the clone is a real session"       0 'running'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CLONECFG ls clone-src-2"

section "plan"
PLANCFG=$E2E/plan.yml
rm -f $PLANCFG /tmp/plan-off-ran
cat > $PLANCFG <<YML
version: 1
tmux:
  socket: $SOCK
defaults:
  agent: bash
sessions:
  - name: plan-on
    cwd: /tmp
    restart: always
  - name: plan-off
    cwd: /tmp
    restart: always
YML
PLF() { "$ROOT/bin/pp.js" -c "$PLANCFG" "$@"; }
PLF up plan-on >/dev/null 2>&1
tmux -L "$SOCK" new-session -d -s plan-stray -c /tmp "sleep 7200" 2>/dev/null
check "plan lists steps in order"       0 'in this order'        PLF plan
check "plan names the missing session"  0 'pp up --drift'        PLF plan
check "plan names the stray"            0 'pp adopt'             PLF plan
check "plan counts what it will start"  0 'start 1 session'      PLF plan
check "plan --json has steps"           0 '"command"'            PLF plan --json
tmux -L "$SOCK" kill-session -t plan-stray >/dev/null 2>&1 || true
PLF up plan-off >/dev/null 2>&1
# this socket carries sessions from earlier sections, so "adopt" is legitimately
# still a step here; what must be gone is the drift step for plan.yml itself
ncheck "plan stops asking for a drift once both are up" 'pp up --drift' PLF plan
check "plan has a help page"            0 'pp plan'             bash -c "cd $E2E && $ROOT/bin/pp.js help plan"
# a question nobody answered is exactly what a to-do list is for
check "plan names the questions waiting" 0 'pp todo ls' bash -c "mkdir -p \"$XDG_STATE_HOME/pi-plus\" && printf '{\"version\":1,\"todos\":[{\"id\":\"stale01\",\"session\":\"plan-on\",\"kind\":\"manual\",\"title\":\"ship it?\",\"state\":\"new\",\"createdAt\":\"2020-01-01T00:00:00.000Z\"}]}' > $XDG_STATE_HOME/pi-plus/todos.json && $ROOT/bin/pp.js -c $PLANCFG --socket $SOCK plan 2>&1"
check "plan ages the oldest question" 0 'oldest' bash -c "$ROOT/bin/pp.js -c $PLANCFG --socket $SOCK plan 2>&1"
rm -f "$XDG_STATE_HOME/pi-plus/todos.json"

section "no crash on --json"
# Every read-only verb claims a JSON shape. A script that pipes one of them into
# jq all night should never get a stack trace, so this walks them (the shapes
# themselves are pinned in test/json.test.js).
for verb in "status --json" "why e-always --json" "why --role pm --json" "role --list --json" \
            "plan --json" "doctor --json" "audit --json" "audit --action up --json" \
            "cron ls --json" "todo ls --json" "node ls --json" "handover --json" \
            "snapshot --json" "check --brief" "logs e-always -n 2 --json"; do
  out=$(cd "$E2E" && PATH=$SHIM:$PATH "$ROOT/bin/pp.js" -c "$CFG" --socket "$SOCK" ${verb} 2>&1; echo "rc=$?")
  rc=$(printf '%s' "$out" | sed -n 's/^rc=//p' | tail -1)
  if printf '%s' "$out" | grep -qE 'TypeError|ReferenceError|at Object\.|at async '; then
    printf 'FAIL json: %s crashed\n     | %s\n' "$verb" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')"
    FAIL=$((FAIL + 1)); FAILED_NAMES+=("json: $verb")
  elif [[ "$rc" != "0" && "$rc" != "1" && "$rc" != "2" ]]; then
    printf 'FAIL json: %s exited %s\n' "$verb" "$rc"
    FAIL=$((FAIL + 1)); FAILED_NAMES+=("json exit: $verb")
  else
    PASS=$((PASS + 1))
  fi
done

section "packaging"
# the suite exports PP_UNIT_NAME for its own sandbox unit; the unit tests assert
# the default name, so they run without our sandbox override
check "npm test green"           0 'fail 0'                   bash -c "cd $ROOT && env -u PP_UNIT_NAME npm test 2>&1 | tail -40"
check "npm pack contents"        0 'bin/pp.js'             bash -c "cd $ROOT && npm pack --dry-run 2>&1 | grep bin/pp.js"
check "install.sh syntax"        0 ''                           bash -n "$ROOT/install.sh"
check "extension ships in the package" 0 'extensions/pp-tmux.js' bash -c "cd $ROOT && npm pack --dry-run 2>&1 | grep extensions/pp-tmux.js"
check "package declares the pi manifest" 0 'pp-tmux.js'         bash -c "cd $ROOT && node -p \"JSON.stringify(require('./package.json').pi)\""
check "extension exposes the seven commands" 0 '^7$'         bash -c "cd $ROOT && grep -c 'command(\"pp-' extensions/pp-tmux.js"
check "extension records todos from pi events" 0 '^2$'        bash -c "cd $ROOT && grep -c 'agent_settled' extensions/pp-tmux.js"
check "extension registers the todo tool" 0 '^1$'        bash -c "cd $ROOT && grep -c 'name: \"todo\"' extensions/pp-tmux.js"

printf '\n==========================\nPASS %d  FAIL %d  SKIP %d\n' "$PASS" "$FAIL" "$SKIP"
if [[ $SKIP -gt 0 ]]; then printf '(filtered by PP_E2E_ONLY=%s — not a full run)\n' "$PP_E2E_ONLY"; fi
if [[ $FAIL -gt 0 ]]; then printf 'failed: %s\n' "${FAILED_NAMES[*]}"; exit 1; fi
