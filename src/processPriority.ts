/**
 * HS-8308 — best-effort macOS QoS bump at server boot. macOS schedules
 * threads / processes by Quality of Service class; the `user-interactive`
 * class is the highest user-space tier and is what apps like Terminal.app
 * implicitly run with. Without an explicit bump, a Node process launched
 * from npm / Tauri sidecar inherits the parent's QoS — typically
 * `user-initiated` or lower — which gives keystroke handling no
 * preferential scheduling under load. The user reported (HS-8308) that
 * terminal keystroke entry was being disrupted + the slow-server banner
 * appeared while heavy tests ran inside the embedded terminal, while the
 * macOS Terminal.app stayed snappy under the same load.
 *
 * `taskpolicy(8)` is the macOS-bundled CLI for adjusting QoS without
 * sudo. It maps the named class onto the underlying
 * `proc_set_dirty / proc_setpriority / proc_set_qos_class` calls.
 *
 * Linux + Windows are no-ops — the equivalent on Linux is `nice -n -10`
 * which requires CAP_SYS_NICE (root), and on Windows the SetPriorityClass
 * Win32 API which Node doesn't expose without a native module. Both are
 * out of scope; the user explicitly chose the macOS-taskpolicy direction
 * (HS-8308 Q1).
 */
import { spawnSync } from 'child_process';

/** HS-8358 — kept for documentation / call sites that historically named
 *  the target QoS class. The macOS `taskpolicy(8)` `-c <clamp>` flag does
 *  NOT accept QoS class names (only `utility` / `background`) AND is only
 *  valid on form-1 (wrapping a new program), not form-2 (`-p <pid>`),
 *  which the original HS-8308 implementation tried to use. The constant
 *  records what we'd LIKE the running process to be scheduled as; the
 *  actual taskpolicy invocation below uses `-B -t 0 -l 0 -p <pid>` —
 *  clear-background + highest throughput tier + best latency tier — which
 *  is the closest available approximation to `user-interactive` via the
 *  form-2 interface. */
export const TASKPOLICY_QOS_CLASS = 'user-interactive';

/** Pure: should this platform attempt a QoS bump? Currently darwin only.
 *  Exported for unit tests so we don't have to monkey-patch `process.platform`. */
export function shouldBumpProcessPriority(platform: NodeJS.Platform): boolean {
  return platform === 'darwin';
}

/**
 * Pure: argv to spawn for the given pid. Exported so the unit test can
 * pin the exact command without invoking `spawnSync`.
 *
 * HS-8358 — the pre-fix form `['-p', '<pid>', '-c', 'user-interactive']`
 * triggered macOS taskpolicy's "Could not parse 'user-interactive' as a
 * QoS clamp" + a usage dump on every boot (exit 64). Two bugs in one
 * call: (1) `-c <clamp>` accepts only `utility` / `background`, never QoS
 * class names; (2) `-c` is not a valid flag on form-2 (`-p <pid>`) — the
 * man page restricts form-2 to `[-b|-B] [-t <tier>] [-l <tier>] -p pid`.
 * Post-fix uses the form-2 maximum-priority combination — clear
 * background mode + throughput tier 0 (highest) + latency tier 0 (best).
 */
export function buildTaskpolicyArgs(pid: number): string[] {
  return ['-B', '-t', '0', '-l', '0', '-p', String(pid)];
}

/**
 * Best-effort macOS QoS bump. Returns `true` when `taskpolicy` exited
 * cleanly, `false` otherwise (non-darwin / `taskpolicy` missing / non-zero
 * exit / spawn threw). Never throws — the caller treats the bump as
 * an opportunistic optimization, not a hard requirement.
 *
 * Logs a single concise success / skip line to `console.log` so the user
 * can see the bump happened in the boot output (parallel to the existing
 * `Data directory:` line). Failures log to `console.warn` with the reason
 * so a regression (e.g. macOS rename of the binary) is visible.
 */
export function bumpProcessPriorityBestEffort(): boolean {
  if (!shouldBumpProcessPriority(process.platform)) return false;
  const args = buildTaskpolicyArgs(process.pid);
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('taskpolicy', args, { encoding: 'utf8', timeout: 2000 });
  } catch (err) {
    console.warn(`[priority] taskpolicy spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (result.error !== undefined) {
    console.warn(`[priority] taskpolicy spawn error: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.toString().trim();
    console.warn(`[priority] taskpolicy exited ${result.status}${stderr !== '' ? `: ${stderr}` : ''}`);
    return false;
  }
  console.log(`  Process priority: macOS taskpolicy boost applied (-B -t 0 -l 0, targeting ${TASKPOLICY_QOS_CLASS} equivalent)`);
  return true;
}
