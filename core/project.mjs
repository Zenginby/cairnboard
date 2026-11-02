import * as entity from './entity.mjs';

export const create = (ctx, fields, body, opts) => entity.create(ctx, 'project', fields, body, opts);
export const update = (ctx, ref, patch, opts) => entity.update(ctx, 'project', ref, patch, opts);
export const remove = (ctx, ref, opts) => entity.remove(ctx, 'project', ref, opts);
export const resolve = (ctx, ref) => entity.resolve(ctx, 'project', ref);
export const show = resolve;
export const list = (ctx, filters) => entity.list(ctx, 'project', filters);
