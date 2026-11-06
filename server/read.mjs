import { homeView } from '../cli/views.mjs';
import { okEnvelope } from '../cli/output.mjs';

export class DataNotReadyError extends Error {
  constructor(cause) {
    super('The data directory is not ready.', { cause });
    this.code = 'data_not_ready';
  }
}

export function homeResult(ctx) {
  const view = homeView(ctx);
  return okEnvelope(view.data, [...ctx.warnings, ...(view.warnings ?? [])]);
}

export function createRead({ open }) {
  return {
    async home() {
      let ctx;
      try { ctx = await open(); } catch (error) { throw new DataNotReadyError(error); }
      return homeResult(ctx);
    },
  };
}
