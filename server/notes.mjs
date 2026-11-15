import * as note from '../core/note.mjs';
import * as project from '../core/project.mjs';
import { CairnError } from '../core/errors.mjs';
import { isNoteKey, normalizeId } from '../core/ids.mjs';
import { RULE_NAMES } from '../core/rules.mjs';
import { stripHidden } from '../core/text.mjs';
import { agentProject } from '../cli/views.mjs';
import { createWrites } from './writes.mjs';

const MAX_BODY = 256 * 1024;
const REVISION = /^[0-9a-f]{16}$/iu;
const bad = (message) => ({ status: 400, title: 'write.badRequestTitle', message });
const NOT_READY = Object.freeze({ status: 409, title: 'state.notReadyTitle', message: 'noteForm.notReady' });
const NOT_FOUND = Object.freeze({ status: 404, title: 'write.notFoundTitle', message: 'write.notFound' });
const notReady = (error) => error instanceof CairnError
  && ['validation', 'not_found', 'format_too_new'].includes(error.code);
const lines = (text) => text.replace(/\r\n/gu, '\n');

function isAgentProject(agents, item) {
  if (agents === null) return false;
  return (agents.id !== null && item.id === agents.id)
    || agents.refs.has(item.ref)
    || (item.path ? agents.refs.has(`@${item.path}`) : false);
}

/**
 * Web quick-note write route (`POST /notes`) and form view loader (`view`), using the shared `writes.mjs` checks.
 * @param {{ key: Buffer, port: number, open: () => any, openWrite: () => any }} options
 */
export function createNotes({ key, port, open, openWrite }) {
  const back = { href: '/notes/new', label: 'noteForm.backToForm' };
  // A URL-encoded form spends three bytes on most non-ASCII bytes and six on a line break.
  const bodyLimit = 4 * MAX_BODY + 4096;

  const failure = (error) => {
    if (error.code === 'locked') {
      return { status: 503, title: 'noteForm.busyTitle', message: 'noteForm.busy', headers: { 'Retry-After': '1' } };
    }
    if (error.code === 'validation' && Array.isArray(error.details?.rules) && error.details.rules.length > 0) {
      const rule = error.details.rules[0]?.rule;
      const message = RULE_NAMES.includes(rule) ? `noteForm.rule.${rule}` : 'noteForm.rule.other';
      return { status: 422, title: 'noteForm.ruleTitle', message };
    }
    if (error.code === 'conflict' || error.code === 'duplicate_id') {
      return { status: 409, title: 'noteForm.conflictTitle', message: 'noteForm.conflict' };
    }
    if (error.code === 'validation' || error.code === 'unsupported_frontmatter') {
      return bad('noteForm.invalidWrite');
    }
    if (notReady(error)) return NOT_READY;
    return undefined;
  };

  const opened = () => {
    try { return { ctx: open() }; } catch (error) {
      if (notReady(error)) return { refusal: NOT_READY };
      throw error;
    }
  };

  const pinBack = ({ ref }) => ({ href: `/notes/${encodeURIComponent(ref)}`, label: 'noteForm.backToNote' });
  const pinFailure = (error) => (error.code === 'not_found' ? NOT_FOUND : failure(error));

  const routes = [
    { path: '/notes', form: 'note', back, failure, bodyLimit,
      run({ values }) {
        if (Object.keys(values).some((name) => !['title', 'body', 'project', 'pinned'].includes(name))
          || typeof values.title !== 'string'
          || (values.body !== undefined && typeof values.body !== 'string')
          || (values.project !== undefined && typeof values.project !== 'string')
          || (values.pinned !== undefined && values.pinned !== 'on')) {
          return bad('noteForm.invalidFields');
        }
        const title = values.title.trim();
        if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
          || stripHidden(values.title).removed > 0) return bad('noteForm.invalidTitle');
        const body = lines(values.body ?? '');
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY) return bad('noteForm.invalidBody');
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        const agents = agentProject(ctx);
        const fields = { kind: 'note', title, ...(values.pinned === 'on' ? { pinned: true } : {}) };
        if (values.project) {
          let resolved;
          try {
            resolved = project.resolve(ctx, values.project);
          } catch (error) {
            if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
              return bad('noteForm.invalidProject');
            }
            throw error;
          }
          if (isAgentProject(agents, resolved)) return bad('noteForm.invalidProject');
          fields.project = resolved.id ?? resolved.ref;
        }
        const changed = note.create(openWrite(), fields, body, {});
        return `/notes/${encodeURIComponent(changed.entity.id ?? changed.entity.ref)}`;
      } },
    { path: /^\/notes\/(?<ref>[Nn]-[0-9A-Za-z]{1,24})\/pin$/u, form: 'note', back: pinBack, failure: pinFailure,
      bodyLimit: 4096,
      run({ values, params: { ref: rawRef } }) {
        if (Object.keys(values).length !== 2 || !Object.hasOwn(values, 'pinned')
          || !Object.hasOwn(values, 'revision')) {
          return bad('noteForm.invalidFields');
        }
        if (!['on', 'off'].includes(values.pinned)) return bad('noteForm.invalidPinned');
        if (!REVISION.test(values.revision)) return bad('noteForm.invalidRevision');
        const ref = isNoteKey(rawRef) ? rawRef : normalizeId(rawRef);
        if (!ref || !ref.startsWith('n-')) return NOT_FOUND;
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        let current;
        try { current = note.resolve(ctx, ref); } catch (error) {
          if (error instanceof CairnError && error.code === 'not_found') return NOT_FOUND;
          throw error;
        }
        const agents = agentProject(ctx);
        if (agents !== null && current.data?.project) {
          if (agents.refs.has(current.data.project)) return bad('noteForm.invalidProject');
          try {
            if (isAgentProject(agents, project.resolve(ctx, current.data.project))) {
              return bad('noteForm.invalidProject');
            }
          } catch { /* Unknown project reference on the note is not the agents project. */ }
        }
        const target = current.id ?? current.ref;
        note.update(openWrite(), target, { pinned: values.pinned === 'on' }, { ifRevision: values.revision });
        return `/notes/${encodeURIComponent(target)}`;
      } },
  ];

  const writes = createWrites({ key, port, routes });

  function view(cookieHeader) {
    const csrf = writes.token(cookieHeader, 'note');
    let ctx;
    try { ctx = open(); } catch (error) {
      if (notReady(error)) return { state: 'notReady', csrf };
      throw error;
    }
    const agents = agentProject(ctx);
    const active = ({ data }) => data.status === undefined || data.status === 'active';
    const projects = project.list(ctx).filter((item) => active(item) && !isAgentProject(agents, item));
    return { state: 'ready', csrf, projects };
  }

  return { routes, view, token: (cookieHeader) => writes.token(cookieHeader, 'note') };
}
