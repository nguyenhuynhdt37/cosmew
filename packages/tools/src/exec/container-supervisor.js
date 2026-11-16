// Trusted PID1 supervisor inside the pinned image (ADR 0032/0034). Runs as `bun -e <this file>`.
//
// argv[1] is one JSON launch record: {lease, command, cwd, uid, gid, tty, cols, rows, shell, login, verify?}.
// The supervisor validates it, drops to the unprivileged uid with no capabilities, and runs the
// shell on pipes or on a pseudo-terminal it allocates inside the namespace. Output leaves as
// base64 `data` frames and one final `result` frame, so command text can never forge a receipt.
// The host sends control frames on stdin: input bytes, resize, interrupt, EOF.

const {spawn} = require('node:child_process');
const fs = require('node:fs');
const signals = require('node:os').constants.signals;

const MAX_QUEUED_PTY_BYTES = 8 * 1024 * 1024;
const PIPE_DRAIN_AFTER_EXIT_MS = 1000;
const PTY_DRAIN_AFTER_EXIT_MS = 100;
const FINAL_FLUSH_MS = 250;

// ---------------------------------------------------------------------------------------------
// Launch record

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

let launch;
try {
  launch = JSON.parse(process.argv[1]);
} catch {
  process.exit(126);
}

const validLaunch =
  launch &&
  typeof launch.command === 'string' &&
  typeof launch.cwd === 'string' &&
  launch.cwd.startsWith('/') &&
  isInt(launch.lease, 1000, 1800000) &&
  isInt(launch.uid, 1, 4294967294) &&
  isInt(launch.gid, 1, 4294967294) &&
  typeof launch.tty === 'boolean' &&
  ['bash', 'sh'].includes(launch.shell) &&
  typeof launch.login === 'boolean' &&
  (!launch.tty || (isInt(launch.cols, 10, 1000) && isInt(launch.rows, 5, 500)));
if (!validLaunch) process.exit(126);

// ---------------------------------------------------------------------------------------------
// State

/** A PTY merges stdout and stderr into one stream. */
const streams = launch.tty ? 1 : 2;
let finishing = false;
let observedExit = false;
let closedStreams = 0;
let result;
let child;
let terminal;

// A PTY master cannot be paused, so its frames queue while the host transport is blocked. The queue
// is bounded; beyond it bytes are dropped and the receipt reports the output as cut off.
let blocked = false;
let queuedBytes = 0;
let dropped = false;
const pending = [];

// ---------------------------------------------------------------------------------------------
// Output frames and the final receipt

function dataFrame(stream, chunk) {
  return JSON.stringify({type: 'data', stream, data: Buffer.from(chunk).toString('base64')}) + '\n';
}

function flushQueue() {
  blocked = false;
  while (pending.length) {
    const next = pending.shift();
    queuedBytes -= next.length;
    if (!process.stdout.write(next)) {
      blocked = true;
      process.stdout.once('drain', flushQueue);
      return;
    }
  }
}

function emit(stream, chunk) {
  const line = dataFrame(stream, chunk);
  if (blocked) {
    if (queuedBytes + line.length > MAX_QUEUED_PTY_BYTES) {
      dropped = true;
      return;
    }
    pending.push(line);
    queuedBytes += line.length;
    return;
  }
  if (!process.stdout.write(line)) {
    blocked = true;
    process.stdout.once('drain', flushQueue);
  }
}

/** Write the receipt and exit. A dead owner or blocked output cannot delay the exit past FINAL_FLUSH_MS. */
function finish(value, status) {
  if (finishing) return;
  finishing = true;
  const receipt = {
    type: 'result',
    ...value,
    outputClosed: closedStreams >= streams && !dropped,
    wrapperExitCode: status,
  };
  setTimeout(() => process.exit(status), FINAL_FLUSH_MS);
  while (pending.length) process.stdout.write(pending.shift());
  process.stdout.write(JSON.stringify(receipt) + '\n', () => process.exit(status));
}

function onLeaderExit(code, signal) {
  observedExit = true;
  result = {
    value: {kind: 'exited', exitCode: code, signal: signal ?? null},
    status: code ?? 128 + (signals[signal] ?? 0),
  };
  if (closedStreams >= streams) finish(result.value, result.status);
  else setTimeout(() => finish(result.value, result.status), PIPE_DRAIN_AFTER_EXIT_MS);
}

// The lease is the hard deadline: it ends the namespace whatever the command or the owner does.
setTimeout(() => finish({kind: 'timeout', exitCode: null, signal: null}, 124), launch.lease);
process.on('SIGINT', () => finish({kind: 'cancelled', exitCode: null, signal: 'SIGINT'}, 130));
process.on('SIGTERM', () => finish({kind: 'cancelled', exitCode: null, signal: 'SIGTERM'}, 143));

// ---------------------------------------------------------------------------------------------
// Mask verification

/**
 * While another write-capable session runs, it could move a protected file between the host's mask
 * scan and these mounts. Masks follow the files once mounted, so verify before any command runs:
 * every protected entry under /workspace must itself be a mountpoint.
 */
function verifyMasks(verify) {
  let mountpoints;
  try {
    const lines = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter(Boolean);
    // Field 5 is the mount point, with octal escapes such as \040 for spaces.
    mountpoints = new Set(
      lines.map(line =>
        line.split(' ')[4].replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(parseInt(octal, 8))),
      ),
    );
  } catch {
    return false;
  }

  const secret = verify.secret.map(pattern => new RegExp(pattern, 'i'));
  const except = verify.except.map(pattern => new RegExp(pattern, 'i'));
  let entries = 0;

  const isProtected = (entry, relative, name) =>
    (name === '.git' && !(relative === '.git' && verify.gitPinned)) ||
    name === '.futryn' ||
    name === '.hannes' ||
    name.startsWith('.futryn-patch-') ||
    name.startsWith('.hannes-patch-') ||
    verify.hidden.includes(relative) ||
    (!entry.isDirectory() && secret.some(r => r.test(name)) && !except.some(r => r.test(name)));

  const walk = directory => {
    let list;
    try {
      list = fs.readdirSync(directory, {withFileTypes: true});
    } catch {
      return false;
    }
    for (const entry of list) {
      if (++entries > 250000) return false;
      if (entry.isSymbolicLink()) continue;
      const path = directory + '/' + entry.name;
      const relative = path.slice('/workspace/'.length);
      const name = entry.name.toLowerCase();

      if (isProtected(entry, relative, name)) {
        if (!mountpoints.has(path)) return false;
        continue;
      }
      if (relative === '.git') {
        for (const file of ['config', 'config.worktree']) {
          if (fs.existsSync(path + '/' + file) && !mountpoints.has(path + '/' + file)) return false;
        }
        continue;
      }
      if (entry.isDirectory() && !mountpoints.has(path) && !walk(path)) return false;
    }
    return true;
  };
  return walk('/workspace');
}

const aborted = !!launch.verify && !verifyMasks(launch.verify);
if (aborted) {
  finishing = true;
  const receipt = {
    type: 'result',
    kind: 'spawn-failed',
    exitCode: null,
    signal: null,
    outputClosed: true,
    wrapperExitCode: 125,
  };
  process.stdout.write(JSON.stringify(receipt) + '\n', () => process.exit(125));
  setTimeout(() => process.exit(125), FINAL_FLUSH_MS);
}

// ---------------------------------------------------------------------------------------------
// The command

// Codex UNIFIED_EXEC_ENV, adjusted for a terminal. Nothing is inherited from the host.
const env = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'HOME=/tmp',
  'TMPDIR=/tmp',
  'LANG=C.UTF-8',
  'LC_CTYPE=C.UTF-8',
  'LC_ALL=C.UTF-8',
  'PAGER=cat',
  'GIT_PAGER=cat',
  'GH_PAGER=cat',
  'GIT_OPTIONAL_LOCKS=0',
  'CODEX_CI=1',
  'FUTRYN_SANDBOX=1',
  ...(launch.tty ? ['TERM=xterm-256color'] : ['TERM=dumb', 'NO_COLOR=1', 'COLORTERM=']),
];

// A login shell reads only the image's read-only /etc/profile (HOME is the private /tmp).
const shell = launch.login
  ? launch.shell === 'sh'
    ? ['/bin/sh', '-l']
    : ['/bin/bash', '--login']
  : launch.shell === 'sh'
    ? ['/bin/sh']
    : ['/bin/bash', '--noprofile', '--norc'];

// setpriv drops to the command's uid/gid with no groups and an empty capability set.
const argv = [
  '/usr/bin/setpriv',
  '--reuid=' + launch.uid,
  '--regid=' + launch.gid,
  '--clear-groups',
  '--bounding-set=-all',
  '--inh-caps=-all',
  '--ambient-caps=-all',
  '/usr/bin/env',
  '-i',
  ...env,
  ...shell,
  '-c',
  launch.command,
  'futryn-command',
];

function startPty() {
  try {
    child = Bun.spawn(argv, {
      cwd: launch.cwd,
      terminal: {
        cols: launch.cols,
        rows: launch.rows,
        data(_terminal, data) {
          emit('stdout', data);
        },
      },
    });
    terminal = child.terminal;
  } catch {
    finish({kind: 'spawn-failed', exitCode: null, signal: null}, 126);
    return;
  }
  child.exited.then(() => {
    // The PTY master still delivers output briefly after the leader exits; then it counts as closed.
    setTimeout(() => {
      closedStreams = streams;
      onLeaderExit(child.exitCode, child.signalCode);
    }, PTY_DRAIN_AFTER_EXIT_MS);
  });
}

function startPipes() {
  child = spawn(argv[0], argv.slice(1), {cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true});
  child.stdin.on('error', () => {});
  for (const stream of ['stdout', 'stderr']) {
    const readable = child[stream];
    let paused = false;
    // Pull-based reads with backpressure: never read faster than the host transport accepts.
    const pump = () => {
      if (paused) return;
      let chunk;
      while ((chunk = readable.read(Math.min(16384, Math.max(1, readable.readableLength)))) !== null) {
        if (!process.stdout.write(dataFrame(stream, chunk))) {
          paused = true;
          process.stdout.once('drain', () => {
            paused = false;
            pump();
          });
          return;
        }
      }
    };
    readable.on('readable', pump);
    readable.on('close', () => {
      closedStreams++;
      if (observedExit && closedStreams >= streams) finish(result.value, result.status);
    });
  }
  child.on('error', () => finish({kind: 'spawn-failed', exitCode: null, signal: null}, 126));
  child.on('exit', onLeaderExit);
}

if (!aborted) {
  if (launch.tty) startPty();
  else startPipes();
}

// ---------------------------------------------------------------------------------------------
// Host control frames: input bytes, resize, interrupt of the session's own process group, EOF.

let wire = '';

function handleControl(frame) {
  if (!child || finishing) return;
  if (frame.t === 'in' && typeof frame.d === 'string' && frame.d.length <= 16384) {
    const data = Buffer.from(frame.d, 'base64');
    if (terminal) terminal.write(data);
    else child.stdin.write(data);
  } else if (frame.t === 'rs' && terminal && isInt(frame.c, 10, 1000) && isInt(frame.r, 5, 500)) {
    terminal.resize(frame.c, frame.r);
  } else if (frame.t === 'int') {
    if (terminal) terminal.write('\x03');
    else {
      try {
        process.kill(-child.pid, 'SIGINT');
      } catch {
        /* already gone */
      }
    }
  } else if (frame.t === 'eof' && !terminal) {
    child.stdin.end();
  }
}

process.stdin.on('data', bytes => {
  wire += bytes.toString('utf8');
  for (;;) {
    const end = wire.indexOf('\n');
    if (end < 0) {
      if (wire.length > 65536) wire = '';
      return;
    }
    const line = wire.slice(0, end);
    wire = wire.slice(end + 1);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handleControl(frame);
  }
});
process.stdin.on('error', () => {});
