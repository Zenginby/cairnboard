export const liveBudgetMs = process.env.CAIRN_LIVE_STRICT === '1' ? 2000 : 15_000;

export function liveUnavailable(t, reason) {
  if (process.env.CAIRN_LIVE_STRICT === '1') throw new Error(reason);
  t.skip(reason);
}

// Register before temporary directories: resources stop before their backing files are removed.
export function liveCleanup(t) {
  const callbacks = [];
  t.after(async () => {
    const errors = [];
    for (const close of callbacks.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Live test cleanup failed.');
  });
  return (close) => callbacks.push(close);
}
