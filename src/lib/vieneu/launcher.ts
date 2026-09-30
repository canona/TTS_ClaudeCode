import 'server-only';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, renameSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { serverConfig } from '../config';

/**
 * Starts the local VieNeu-TTS server as a child process, so users never have
 * to run `uv run python -m apps.openai_speech` themselves.
 *
 * Called at boot (instrumentation.ts) and again whenever the server is found
 * unreachable. If something already listens on VIENEU_URL (e.g. a server the
 * user started by hand) we leave it alone. The child is killed with us.
 */

export type LaunchState = 'idle' | 'starting' | 'running' | 'failed' | 'unavailable';

interface Launcher {
  state: LaunchState;
  child: ChildProcess | null;
  /** Last lines of the child's output – shown to the user when it crashes. */
  log: string[];
  error: string | null;
  /** The next exit of `child` is a restart we asked for: relaunch instead of reporting a crash. */
  restartRequested: boolean;
  /** Unexpected exits in the last 10 minutes – beyond 3, stop relaunching (it would loop). */
  crashTimes: number[];
}

const config = serverConfig.vieneu;
const g = globalThis as typeof globalThis & { __vieneuLauncher?: Launcher };
// Pinned on globalThis – ALL of it: a dev hot reload re-evaluates this module
// while the child's 'exit' listener still belongs to the previous copy, so
// any module-level flag would be split between the two and a restart lost.
const launcher: Launcher = (g.__vieneuLauncher ??= {
  state: 'idle',
  child: null,
  log: [],
  error: null,
  restartRequested: false,
  crashTimes: [],
});
launcher.restartRequested ??= false;
launcher.crashTimes ??= [];

function isLocalUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Why autostart can't work here, or null if it can. */
function unavailableReason(): string | null {
  if (!config.autostart) return 'Tự khởi động VieNeu đang tắt (VIENEU_AUTOSTART=0).';
  if (!isLocalUrl(config.url)) return `VieNeu-TTS ở máy khác (${config.url}), không tự khởi động được.`;
  if (!existsSync(path.join(config.dir, 'apps', 'openai_speech.py'))) {
    return `Không tìm thấy VieNeu-TTS tại ${config.dir}. Đặt VIENEU_DIR tới thư mục đã clone.`;
  }
  return null;
}

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.url}/health`, { cache: 'no-store', signal: AbortSignal.timeout(1_500) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Log file: VieNeu's own output + our lifecycle events, so a hang or crash can
// be diagnosed afterwards (the in-memory tail dies with the process).
// ---------------------------------------------------------------------------

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const gl = globalThis as typeof globalThis & { __vieneuLog?: WriteStream };

function logStream(): WriteStream | null {
  if (!config.logFile) return null;
  if (!gl.__vieneuLog) {
    try {
      if ((statSync(config.logFile, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) {
        renameSync(config.logFile, `${config.logFile}.1`);
      }
    } catch {
      // rotation is best effort
    }
    gl.__vieneuLog = createWriteStream(config.logFile, { flags: 'a' });
    gl.__vieneuLog.on('error', () => undefined);
  }
  return gl.__vieneuLog;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Records an app-side event (restart, timeout…) in .vieneu.log. */
export function logVieneuEvent(message: string): void {
  logStream()?.write(`${stamp()} [app] ${message}\n`);
}

function remember(chunk: Buffer): void {
  const out = logStream();
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    launcher.log.push(line);
    if (launcher.log.length > 40) launcher.log.shift();
    out?.write(`${stamp()} [vieneu] ${line}\n`);
  }
}


function spawnServer(): void {
  const port = new URL(config.url).port || '8000';
  console.log(`[vieneu] starting server in ${config.dir} on port ${port}`);
  logVieneuEvent(`starting server in ${config.dir} on port ${port}`);
  const child = spawn(config.uv, ['run', 'python', '-m', 'apps.openai_speech'], {
    cwd: config.dir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: port,
      // Our client gate (vieneu/client.ts) never sends more than max_streams requests, so nothing
      // should queue there. Keep the server queue short anyway: a request that waits in it and whose
      // client gives up leaks its slot once admitted (VieNeu only releases it when streaming starts).
      VIENEU_QUEUE: '8',
      VIENEU_QUEUE_TIMEOUT: '30',
      ...(config.apiKey ? { VIENEU_API_KEY: config.apiKey } : {}),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  });
  launcher.child = child;
  launcher.state = 'starting';
  launcher.log = [];
  launcher.error = null;
  child.stdout?.on('data', remember);
  child.stderr?.on('data', remember);

  const onError = (message: string, canRelaunch = true): void => {
    if (launcher.child !== child) return;
    launcher.child = null;
    logVieneuEvent(message);
    if (launcher.restartRequested) {
      launcher.restartRequested = false;
      spawnServer();
      return;
    }
    const now = Date.now();
    while (launcher.crashTimes.length && now - launcher.crashTimes[0]! > 10 * 60_000) launcher.crashTimes.shift();
    if (canRelaunch && launcher.crashTimes.length < 3) {
      launcher.crashTimes.push(now);
      logVieneuEvent(`relaunching after unexpected exit (${launcher.crashTimes.length}/3 in 10 min)`);
      console.warn(`[vieneu] ${message} – relaunching`);
      launcher.state = 'starting';
      setTimeout(spawnServer, 2_000);
      return;
    }
    launcher.state = 'failed';
    launcher.error = message;
    console.error(`[vieneu] ${message}\n${launcher.log.slice(-10).join('\n')}`);
  };
  child.on('error', (err) => onError(`Không chạy được "${config.uv}": ${err.message}. Cài uv hoặc đặt VIENEU_UV.`, false));
  child.on('exit', (code) => onError(`VieNeu-TTS đã dừng (mã ${code ?? '?'}).`));
}

/**
 * Kills the server together with its children: `uv run` starts python as a
 * child process, and on Windows killing uv alone can leave python holding the port.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    if (launcher.child) killTree(launcher.child);
  });
}

/** PID listening on the VieNeu port (Windows: netstat, elsewhere: lsof), or null. */
function portOwner(): number | null {
  const port = new URL(config.url).port || '8000';
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'utf8' }).stdout ?? '';
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1]?.endsWith(`:${port}`) && cols[3] === 'LISTENING') return Number(cols[4]) || null;
    }
    return null;
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
  return Number(out.trim().split(/\s+/)[0]) || null;
}

/**
 * Restarts a stuck server. One we launched is simply relaunched. One we did
 * not launch (typically left over by a previous run of this app) is taken
 * over – killed and replaced – but only when autostart could replace it.
 * Returns false when we can't: then only its owner can restart it.
 */
export async function restartVieneuServer(): Promise<boolean> {
  const child = launcher.child;
  if (child) {
    console.warn('[vieneu] restarting stuck server');
    launcher.restartRequested = true;
    launcher.state = 'starting';
    killTree(child);
    return true;
  }
  if (unavailableReason()) return false;
  const pid = portOwner();
  if (!pid || pid === process.pid) return false;
  console.warn(`[vieneu] taking over stuck server (pid ${pid})`);
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  await new Promise((r) => setTimeout(r, 1_000)); // let the OS free the port
  launcher.state = 'idle';
  await ensureVieneuServer();
  return launcherInfo().state === 'starting';
}

let checking: Promise<void> | null = null;

/** Idempotent: makes sure a VieNeu server is running or starting. */
export function ensureVieneuServer(): Promise<void> {
  if (launcher.state === 'starting' || launcher.state === 'running') return Promise.resolve();
  checking ??= (async () => {
    if (await reachable()) {
      launcher.state = 'running'; // started elsewhere
      return;
    }
    const reason = unavailableReason();
    if (reason) {
      launcher.state = 'unavailable';
      launcher.error = reason;
      return;
    }
    installExitHook();
    spawnServer();
  })().finally(() => {
    checking = null;
  });
  return checking;
}

/** Called once the server answered: our child (if any) is up. */
export function markVieneuReady(): void {
  if (launcher.state === 'starting') console.log('[vieneu] server ready');
  launcher.state = 'running';
}

/** Called when a running server stopped answering (crashed, closed by hand…). */
export function markVieneuLost(): void {
  if (launcher.state === 'running' && !launcher.child) launcher.state = 'idle';
}

export function launcherInfo(): { state: LaunchState; error: string | null; log: string[] } {
  return { state: launcher.state, error: launcher.error, log: launcher.log.slice(-6) };
}
