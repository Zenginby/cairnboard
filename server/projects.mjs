// Project forms use the same write layer as the card forms: one table of routes handed to `createWrites`.
import * as project from '../core/project.mjs';
import { CairnError } from '../core/errors.mjs';
import { stripHidden } from '../core/text.mjs';
import { createWrites } from './writes.mjs';

const STATUSES = ['active', 'paused', 'archived'];
const TONES = [1, 2, 3, 4, 5, 6, 7, 8];
const MAX_BODY = 5 * 1024 * 1024;
const ID = 'p-[0-9a-hjkmnp-tv-z]{6}';
const bad = (message) => ({ status: 400, title: 'write.badRequestTitle', message });
const NOT_READY = Object.freeze({ status: 409, title: 'state.notReadyTitle', message: 'projectForm.notReady' });
const notReady = (error) => error instanceof CairnError
  && ['validation', 'not_found', 'format_too_new'].includes(error.code);
const lines = (text) => text.replace(/\r\n/gu, '\n');
const stored = (value) => (value === undefined || value === null ? '' : String(value));

function checkCommon(values) {
  const title = values.title.trim();
  if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
    || stripHidden(values.title).removed > 0) return bad('projectForm.invalidTitle');
  if (!STATUSES.includes(values.status)) return bad('projectForm.invalidStatus');
  if (values.tone !== undefined && !TONES.map(String).includes(values.tone)) return bad('projectForm.invalidTone');
  if (Buffer.byteLength(lines(values.body)) > MAX_BODY) return bad('projectForm.invalidBody');
  return undefined;
}

export function createProjects({ key, port, open, openWrite }) {
  const back = { href: '/projects', label: 'projectForm.back' };
  const editBack = ({ id }) => ({ href: `/projects/${id}`, label: 'projectForm.backToProject' });
  const bodyLimit = 4 * MAX_BODY + 4096;
  const CONFLICT = Object.freeze({ status: 409, title: 'projectForm.conflictTitle', message: 'projectForm.conflict' });
  const failure = (error) => error.code === 'conflict' ? CONFLICT
    : ['duplicate_id', 'unsupported_frontmatter'].includes(error.code)
      ? { status: 409, title: 'projectForm.blockedTitle', message: 'projectForm.blocked' }
      : error.code === 'validation' ? bad('projectForm.invalidWrite') : undefined;
  const exact = (values, names, optional = []) => names.every((name) => Object.hasOwn(values, name))
    && Object.keys(values).every((name) => [...names, ...optional].includes(name));
  const opened = () => {
    try { return { ctx: open() }; } catch (error) {
      if (notReady(error)) return { refusal: NOT_READY };
      throw error;
    }
  };

  const routes = [
    { path: '/projects', form: 'project', back, failure, bodyLimit,
      run({ values }) {
        if (!exact(values, ['title', 'body', 'status'], ['tone'])) return bad('projectForm.invalidFields');
        const invalid = checkCommon(values);
        if (invalid) return invalid;
        const { refusal } = opened();
        if (refusal) return refusal;
        const fields = { title: values.title.trim(), status: values.status };
        if (values.tone !== undefined) fields.tone = Number(values.tone);
        const changed = project.create(openWrite(), fields, lines(values.body), {});
        return `/projects/${changed.entity.id}`;
      } },
    { path: new RegExp(`^/projects/(?<id>${ID})$`, 'u'), form: 'project', back: editBack, failure, bodyLimit,
      run({ values, params: { id } }) {
        if (!exact(values, ['title', 'body', 'status', 'revision'], ['tone'])) return bad('projectForm.invalidFields');
        const invalid = checkCommon(values);
        if (invalid) return invalid;
        if (!/^[0-9a-f]{16}$/iu.test(values.revision)) return bad('projectForm.invalidRevision');
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        const current = project.resolve(ctx, id);
        const patch = {};
        const title = values.title.trim();
        if (title !== current.title) patch.title = title;
        if (values.status !== stored(current.data.status)) patch.status = values.status;
        if (values.tone !== undefined && values.tone !== stored(current.data.tone)) patch.tone = Number(values.tone);
        const text = lines(values.body);
        const same = text === lines(current.body);
        if (same && !Object.keys(patch).length) return `/projects/${id}`;
        const body = same ? {} : { body: current.body.includes('\r\n') ? text.replace(/\n/gu, '\r\n') : text };
        project.update(openWrite(), id, patch, { ...body, ifRevision: values.revision });
        return `/projects/${id}`;
      } },
  ];
  const writes = createWrites({ key, port, routes });

  /** What the form pages show; `state` is 'notReady' or 'notFound' when the form cannot open. */
  function view(cookieHeader, id) {
    const csrf = writes.token(cookieHeader, 'project');
    const { ctx, refusal } = opened();
    if (refusal) return { state: 'notReady', csrf };
    let item;
    if (id !== undefined) {
      if (typeof id !== 'string' || !new RegExp(`^${ID}$`, 'u').test(id)) return { state: 'notFound', csrf };
      try { item = project.resolve(ctx, id); } catch (error) {
        if (error instanceof CairnError && error.code === 'not_found') return { state: 'notFound', csrf };
        throw error;
      }
      if (!item.id) return { state: 'notFound', csrf };
    }
    const tone = Number.isInteger(item?.data.tone) && item.data.tone >= 1 && item.data.tone <= 8
      ? item.data.tone : item ? undefined : project.list(ctx).length % 8 + 1;
    const status = item ? stored(item.data.status) || 'active' : 'active';
    return { state: 'ready', csrf, item, tones: TONES, tone, status, statuses: STATUSES };
  }

  return { routes, view };
}
