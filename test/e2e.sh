#!/usr/bin/env bash
# End-to-end feature test for pp (manual, not part of `npm test`).
#
# What it does: exercises every feature against a throw-away tmux socket
# (pfe2e), its own XDG_STATE_HOME and config, up to and including installing a
# real `pi-plus.service` systemd user unit and starting ONE real pi agent.
#
# Requirements: tmux, bash, a working `pi` CLI (only the last two sections).
#
#   ./test/e2e.sh              # full run (~3 minutes)
#
# It cleans up after itself (kills its tmux server, stops/uninstalls the unit,
# removes /tmp/e2e-pifarm). Do not run it on a machine where you rely on a
# `pi-plus.service` of your own: the autostart section installs and removes it.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
E2E=/tmp/e2e-pifarm
SOCK=pfe2e
export XDG_STATE_HOME=$E2E/state
CFG=$E2E/plus.yml
PASS=0; FAIL=0; FAILED_NAMES=()

check() { # name want_rc pattern cmd...
  local name="$1" want_rc="$2" pat="$3"; shift 3
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

section() { printf '\n### %s\n' "$1"; }

cleanup() {
  [[ -n ${INBOX_PID:-} ]] && kill "$INBOX_PID" >/dev/null 2>&1
  [[ -n ${INBOX_JSON_PID:-} ]] && kill "$INBOX_JSON_PID" >/dev/null 2>&1
  [[ -n ${FAKE_PID:-} ]] && kill "$FAKE_PID" >/dev/null 2>&1
  systemctl --user stop pi-plus.service >/dev/null 2>&1
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

section "help"
check "help overview"            0 'Commands:'                 pp help
check "help up"                  0 '\-\-reconcile'             pp help up
check "help alias ls"            0 'status \(alias'            pp help ls
check "up --help"                0 'Usage:'                    pp up --help
check "help typo suggestion"     2 "did you mean 'pp help install'" pp help instal
check "unknown command"          2 "run 'pp help'"        pp upstat
VERSION=$(node -p "require('$ROOT/package.json').version")
check "version"                  0 "^$VERSION$"                 pp -V
check "no args shows help"       0 'Usage:'                    node "$ROOT/bin/pp.js"

section "init / check"
check "init --path"              0 'wrote'                     pp init --path "$E2E/init.yml"
check "init refuses overwrite"   1 'already exists'            pp init --path "$E2E/init.yml"
check "init --force"             0 'wrote'                     pp init --path "$E2E/init.yml" --force
check "check flags missing cwd"  1 'cwd does not exist'        pp check -c "$E2E/init.yml"
check "check --json ok"          0 '"ok": true'                pp check -c "$CFG" --json

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

section "up / status"
check "bare up starts 3"         0 '3 started'                  PFc up
check "up is idempotent"         0 '0 started'                  PFc up
check "status table"             0 'e-no +off'                  PFc status
check "status shows restart col" 0 'RESTART'                    PFc status
check "status --json valid"      0 '"sessions"|e-always'        bash -c "pp -c $CFG --socket $SOCK status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d)[:40])'"
check "status named row only"    0 'e-always'                   bash -c "pp -c $CFG --socket $SOCK status e-always | sed -n 2p"
check "status unknown name"      2 'unknown session'            PFc status nosuch

section "logs / send"
check "send text"                0 'sent to e-always'           PFc send e-always 'echo hello-e2e'
sleep 1
check "logs see output"          0 'hello-e2e'                  PFc logs e-always -n 50
check "log file written"         0 '^[1-9][0-9]*$'              bash -c "sleep 1; grep -c hello-e2e $E2E/e-always.log"
check "send --no-enter"          0 'sent to e-onfail'           PFc send e-onfail 'touch /tmp/e2e-pifarm/noenter.flag' --no-enter
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
check "state cleared"            0 'no state'                   bash -c "grep -q e-unless $XDG_STATE_HOME/pi-plus/state.json || echo 'no state'"

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
check "doctor --json"            0 '"checks"|"ok"'              PFc doctor --json

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
node "$ROOT/test/fake-broker.js" "$MESH_HOME/.pi/remote/sessions/local/broker.sock" &
FAKE_PID=$!
sleep 0.6
# exec so the background pid *is* node (a subshell would swallow the SIGINT)
bash -c "cd '$E2E' && exec env REMOTE_PI_HOME='$MESH_HOME' pp mesh inbox --as e-inbox" > "$E2E/inbox.out" 2>&1 &
INBOX_PID=$!
bash -c "cd '$E2E' && exec env REMOTE_PI_HOME='$MESH_HOME' pp --json mesh inbox --as e-inbox-json" > "$E2E/inbox.jsonl" 2>&1 &
INBOX_JSON_PID=$!
sleep 1.5
check "mesh ls sees the inbox"    0 '@e-inbox'          "${MESH[@]}" pp mesh ls
check "mesh send to an inbox"     0 'delivered'         "${MESH[@]}" pp mesh send "$E2E@e-inbox" "hello-inbox"
check "mesh send --reply"         0 'reply from .*: pong' "${MESH[@]}" pp mesh send "$E2E@e-inbox" "?reply pong" --reply 5000
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
  check "unit is enabled"        0 '^enabled$'                  bash -c 'systemctl --user is-enabled pi-plus.service'
  sleep 3
  check "unit started sessions"  0 'e-always +running'          PFc status
  # the oneshot stays "active (exited)", so install must *restart* it
  PFc down >/dev/null 2>&1
  check "install reruns a stale unit" 0 'e-always +running'     bash -c "pp --socket $SOCK -c $CFG install >/dev/null 2>&1; sleep 2; pp --socket $SOCK -c $CFG status"
  check "uninstall removes unit" 0 'removed|disabled'           PFc uninstall
  check "unit is gone"          4 'not-found'                  bash -c 'systemctl --user is-enabled pi-plus.service' 
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
check "pi joined mesh"           0 'connected as "e-pi-mesh"'   bash -c "grep -o 'connected as \"e-pi-mesh\"[^\"]*' $E2E/e-pi.log | head -1"
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
CMD_ID=$(cd "$E2E" && "$ROOT/bin/pp.js" -c "$CFG" cron ls --json | grep -o '"id": "[0-9a-f]*"' | head -1 | cut -d'"' -f4)
check "cron add once job"         0 'scheduled [0-9a-f]'           bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session e-always --in 1m 'echo from-cron'"
check "cron ls lists both"        0 'every 5m'                 bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron ls"
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
check "cron help page"            0 'crontab expression'       bash -c "cd $E2E && $ROOT/bin/pp.js help cron"
# a session that is only running in tmux (not in the config) is a valid target
check "cron targets a running session" 0 'scheduled [0-9a-f]'   bash -c "cd $E2E && tmux -L $SOCK new-session -d -s adhoc-$SOCK -c /tmp 'bash' && $ROOT/bin/pp.js -c $CFG cron add --session adhoc-$SOCK --in 5m 'echo adhoc'"
check "cron rejects a session that is nowhere" 1 'not in .* and not running' bash -c "cd $E2E && $ROOT/bin/pp.js -c $CFG cron add --session nope-$SOCK --in 5m 'x'"

section "packaging"
check "npm test green"           0 'fail 0'                   bash -c "cd $ROOT && npm test 2>&1 | tail -20"
check "npm pack contents"        0 'bin/pp.js'             bash -c "cd $ROOT && npm pack --dry-run 2>&1 | grep bin/pp.js"
check "install.sh syntax"        0 ''                           bash -n "$ROOT/install.sh"
check "extension ships in the package" 0 'extensions/pp-tmux.js' bash -c "cd $ROOT && npm pack --dry-run 2>&1 | grep extensions/pp-tmux.js"
check "package declares the pi manifest" 0 'pp-tmux.js'         bash -c "cd $ROOT && node -p \"JSON.stringify(require('./package.json').pi)\""
check "extension exposes the five commands" 0 '^5$'         bash -c "cd $ROOT && grep -c 'command(\"pp-' extensions/pp-tmux.js"

printf '\n==========================\nPASS %d  FAIL %d\n' "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then printf 'failed: %s\n' "${FAILED_NAMES[*]}"; exit 1; fi
