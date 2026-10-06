/**
 * Money Lab service launcher.
 *
 * systemd starts this as root with the owner's keys in the environment.
 * It drops to the bot's user (MONEY_LAB_USER) before loading the runtime:
 * a process that changed its user is not dumpable, so the kernel makes its
 * /proc/<pid> files root-owned and refuses to let the bot's own shell
 * (same user) read /proc/<pid>/environ or attach to the process. Started
 * directly as the bot's user, the runtime's keys are readable by any
 * command the bot runs.
 *
 * Fails closed: it never runs the runtime as root.
 */

const user = process.env.MONEY_LAB_USER;
// POSIX-only process methods (present on Linux).
const posix = process as NodeJS.Process & {
  initgroups(user: string, extraGroup: string): void;
  setgid(id: string | number): void;
  setuid(id: string | number): void;
  getuid(): number;
  getgid(): number;
};

if (posix.getuid() === 0) {
  if (!user) {
    console.error("Money Lab: refusing to run as root. Set MONEY_LAB_USER to the bot's user (see money-lab.service).");
    process.exit(1);
  }
  try {
    posix.initgroups(user, user);
    posix.setgid(user);
    posix.setuid(user);
  } catch (err: any) {
    console.error(`Money Lab: could not switch to user "${user}": ${err?.message ?? err}`);
    process.exit(1);
  }
  if (posix.getuid() === 0 || posix.getgid() === 0) {
    console.error("Money Lab: still root after switching users; stopping.");
    process.exit(1);
  }
  process.env.USER = user;
  process.env.LOGNAME = user;
}

await import("./index.js");
