/**
 * Ends this process when the one that started it dies. A test run that is
 * killed cannot reap its children, and a helper that holds a lock for its test
 * would otherwise outlive the run holding it.
 */
export function exitWithParent(): void {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent) process.exit(1);
  }, 100).unref();
}
