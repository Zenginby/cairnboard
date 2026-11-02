import * as entity from './entity.mjs';

export const create = (ctx, fields, body, opts) => entity.create(ctx, 'note', fields, body, opts);
export const update = (ctx, ref, patch, opts) => entity.update(ctx, 'note', ref, patch, opts);
export const remove = (ctx, ref, opts) => entity.remove(ctx, 'note', ref, opts);
export const resolve = (ctx, ref) => entity.resolve(ctx, 'note', ref);
export const show = resolve;
export const list = (ctx, filters) => entity.list(ctx, 'note', filters);
