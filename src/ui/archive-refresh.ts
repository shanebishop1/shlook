/** One completion-relative timer; inactive pages and blocked interactions never poll. */
export function archiveRefreshScript(): string {
  // Keep browser code literal, like the other shared client scripts. Serializing a
  // bundled function would capture Wrangler's injected function-name helpers.
  return `(environment) => {
  let active = environment.active();
  let pending = false;
  let running = false;
  let generation = 0;
  let timer;
  let controller;
  const clear = () => {
    if (timer !== undefined) environment.clearTimeout(timer);
    timer = undefined;
  };
  const invalidate = () => {
    generation++;
    if (running) pending = true;
    controller?.abort();
  };
  const arm = () => {
    clear();
    if (!active || pending || running) return;
    timer = environment.setTimeout(() => {
      timer = undefined;
      pending = true;
      drain();
    }, 120000);
  };
  const drain = () => {
    if (!pending || running || !active || !environment.active() || !environment.safe()) return;
    clear();
    pending = false;
    running = true;
    const revision = generation;
    const requestController = new AbortController();
    controller = requestController;
    const fresh = () => revision === generation && !requestController.signal.aborted && environment.active() && environment.safe();
    // Failed passive refreshes deliberately keep the current archive and retry normally.
    Promise.resolve().then(() => {
      if (fresh()) return environment.request(requestController.signal, fresh);
    }).catch(() => {}).finally(() => {
      running = false;
      controller = undefined;
      if (pending) drain();
      else arm();
    });
  };
  const notify = (restored = false) => {
    const next = environment.active();
    if (!next) {
      clear();
      if (active) invalidate();
      active = false;
      return;
    }
    if (!active || restored) {
      if (!running) pending = true;
    }
    active = true;
    if (!environment.safe() && running) invalidate();
    drain();
    if (!pending && !running && timer === undefined) arm();
  };
  arm(); // The server-rendered document is fresh: do not fetch on initial load.
  return {
    notify,
    interaction: () => { invalidate(); },
  };
}`;
}
