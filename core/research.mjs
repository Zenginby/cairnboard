import * as entity from './entity.mjs';

export const create = (ctx, fields, body, opts) => entity.create(ctx, 'research', fields, body, opts);
export const update = (ctx, ref, patch, opts) => entity.update(ctx, 'research', ref, patch, opts);
export const remove = (ctx, ref, opts) => entity.remove(ctx, 'research', ref, opts);
export const resolve = (ctx, ref) => entity.resolve(ctx, 'research', ref);
export const show = resolve;
export const list = (ctx, filters) => entity.list(ctx, 'research', filters);
