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
// Browsers submit every line break as CRLF, a lone CR included; all three forms compare and store as LF.
const lines = (text) => text.replace(/\r\n?/gu, '\n');

function isAgentProject(agents, item) {
  if (agents === null) return false;
  return (agents.id !== null && item.id === agents.id)
    || agents.refs.has(item.ref)
    || (item.path ? agents.refs.has(`@${item.path}`) : false);
}

/** A note linked to the agents project, by any reference the note may use for it. */
function belongsToAgents(ctx, agents, current) {
  if (agents === null || !current.data?.project) return false;
  if (agents.refs.has(current.data.project)) return true;
  try {
    return isAgentProject(agents, project.resolve(ctx, current.data.project));
  } catch { return false; /* Unknown project reference on the note is not the agents project. */ }
}

/** The note a web form may address: an id or, for a note without one, its note key (as the note page reads it). */
const noteRef = (rawRef) => {
  const ref = isNoteKey(rawRef) ? rawRef : normalizeId(rawRef);
  return ref && ref.startsWith('n-') ? ref : null;
};
const EDIT_PATH = /^\/notes\/(?<ref>[Nn]-[0-9A-Za-z]{1,24})$/u;
const DELETE_PATH = /^\/notes\/(?<ref>[Nn]-[0-9A-Za-z]{1,24})\/delete$/u;
/** The fixed overview page and notes whose identity needs repair (a shared or invalid id) are edited in files. */
const fixedOrBroken = (current) => current.kind === 'overview' || current.warnings.includes('duplicate_id')
  || (current.id === null && Object.hasOwn(current.data ?? {}, 'id'));
/** A front matter value as a form field carries it; a missing one is the empty choice. */
const stored = (value) => (value === undefined || value === null ? '' : String(value));

/**
 * Web note write routes (quick note `POST /notes`, pin and edit) and their form view loaders, using the shared
 * `writes.mjs` checks.
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
        const ref = noteRef(rawRef);
        if (!ref) return NOT_FOUND;
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        let current;
        try { current = note.resolve(ctx, ref); } catch (error) {
          if (error instanceof CairnError && error.code === 'not_found') return NOT_FOUND;
          throw error;
        }
        if (belongsToAgents(ctx, agentProject(ctx), current)) return bad('noteForm.invalidProject');
        const target = current.id ?? current.ref;
        note.update(openWrite(), target, { pinned: values.pinned === 'on' }, { ifRevision: values.revision });
        return `/notes/${encodeURIComponent(target)}`;
      } },
    { path: EDIT_PATH, form: 'note', back: pinBack, failure: pinFailure, bodyLimit,
      run({ values, params: { ref: rawRef } }) {
        const names = ['title', 'body', 'project', 'revision'];
        if (Object.keys(values).length !== names.length || names.some((name) => !Object.hasOwn(values, name))) {
          return bad('noteForm.invalidFields');
        }
        const title = values.title.trim();
        if (!title || title.length > 200 || /[\t\r\n\u0085]/u.test(values.title)
          || stripHidden(values.title).removed > 0) return bad('noteForm.invalidTitle');
        const body = lines(values.body);
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY) return bad('noteForm.invalidBody');
        if (!REVISION.test(values.revision)) return bad('noteEdit.invalidRevision');
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        const found = editable(ctx, rawRef);
        if (found.refusal) return found.refusal;
        const { current, agents } = found;
        // Only what the owner changed is written, as on the card form: an untouched title stays where it came from
        // and an untouched project keeps the value the file has.
        const patch = {};
        if (title !== current.title) patch.title = title;
        if (values.project !== stored(current.data.project)) {
          patch.project = undefined;
          if (values.project) {
            let resolved;
            try { resolved = project.resolve(ctx, values.project); } catch (error) {
              if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
                return bad('noteForm.invalidProject');
              }
              throw error;
            }
            // The form offers active projects only; a changed project must be one of them.
            const status = resolved.data?.status;
            if (isAgentProject(agents, resolved) || (status !== undefined && status !== 'active')) {
              return bad('noteForm.invalidProject');
            }
            patch.project = resolved.id ?? resolved.ref;
          }
        }
        const target = current.id ?? current.ref;
        const address = `/notes/${encodeURIComponent(target)}`;
        const same = body === lines(current.body);
        if (same && !Object.keys(patch).length) return address;
        // The file keeps the line endings it already has.
        const text = same ? {} : { body: current.body.includes('\r\n') ? body.replace(/\n/gu, '\r\n') : body };
        // A refusal the owner can fix in the form brings the form back with their text (`view`).
        const view = (revision) => ({ url: `${address}/edit`, ref: target,
          draft: { title: values.title, body, project: values.project, ...(revision ? { revision } : {}) } });
        let changed;
        try {
          changed = note.update(openWrite(), target, patch, { ...text, ifRevision: values.revision });
        } catch (error) {
          if (error instanceof CairnError && error.code === 'conflict') {
            // The form takes the note's new revision: saving again replaces the change made elsewhere.
            return { status: 409, title: 'noteEdit.conflictTitle', message: 'noteEdit.conflict', view: view() };
          }
          const rule = error instanceof CairnError && error.code === 'validation'
            && Array.isArray(error.details?.rules) ? error.details.rules[0]?.rule : undefined;
          if (rule !== undefined) {
            const message = RULE_NAMES.includes(rule) ? `noteForm.rule.${rule}` : 'noteForm.rule.other';
            return { status: 422, title: 'noteForm.ruleTitle', message, view: view(values.revision) };
          }
          throw error;
        }
        // A `warn` rule lets the save through; the note page names it once.
        const warned = changed.warnings.map((code) => /^rule:(.+)$/u.exec(code)?.[1])
          .find((rule) => RULE_NAMES.includes(rule));
        return warned ? `${address}?warning=${warned}` : address;
      } },
    // Delete moves the note file to the data folder's trash (`cairn trash restore` brings it back).
    { path: DELETE_PATH, form: 'note', back: pinBack, failure: pinFailure, bodyLimit: 4096,
      run({ values, params: { ref: rawRef } }) {
        if (Object.keys(values).length !== 1 || !Object.hasOwn(values, 'revision')) {
          return bad('noteForm.invalidFields');
        }
        if (!REVISION.test(values.revision)) return bad('noteDelete.invalidRevision');
        const { ctx, refusal } = opened();
        if (refusal) return refusal;
        const found = editable(ctx, rawRef);
        if (found.refusal) return found.refusal;
        const target = found.current.id ?? found.current.ref;
        try {
          note.remove(openWrite(), target, { ifRevision: values.revision });
        } catch (error) {
          if (error instanceof CairnError && error.code === 'conflict') {
            return { status: 409, title: 'noteDelete.conflictTitle', message: 'noteDelete.conflict' };
          }
          throw error;
        }
        return '/notes?deleted=1';
      } },
  ];

  /**
   * The note a web edit may change, or the refusal: unknown refs, the overview page, notes with a broken identity and
   * notes of the agents project (the pin route's check) are all not found.
   */
  function editable(ctx, rawRef) {
    const ref = noteRef(rawRef);
    if (!ref) return { refusal: NOT_FOUND };
    let current;
    try { current = note.resolve(ctx, ref); } catch (error) {
      if (error instanceof CairnError && error.code === 'not_found') return { refusal: NOT_FOUND };
      throw error;
    }
    if (fixedOrBroken(current)) return { refusal: NOT_FOUND };
    const agents = agentProject(ctx);
    if (belongsToAgents(ctx, agents, current)) return { refusal: NOT_FOUND };
    return { current, agents };
  }

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

  /** What the edit page shows; any note the edit route refuses is `notFound` here. */
  function editView(cookieHeader, rawRef) {
    const csrf = writes.token(cookieHeader, 'note');
    let ctx;
    try { ctx = open(); } catch (error) {
      if (notReady(error)) return { state: 'notReady', csrf };
      throw error;
    }
    const { current, agents, refusal } = editable(ctx, rawRef);
    if (refusal) return { state: 'notFound', csrf };
    const chosen = stored(current.data.project);
    const active = ({ data }) => data.status === undefined || data.status === 'active';
    // The note's own project stays selectable as it is, so saving leaves it alone.
    const projects = project.list(ctx).filter((item) => (active(item) && !isAgentProject(agents, item))
      || item.id === chosen || item.ref === chosen);
    return { state: 'ready', csrf, projects, project: chosen,
      note: { ref: current.id ?? current.ref, title: current.title, body: current.body, revision: current.revision } };
  }

  /** Whether the note page offers Edit for this ref. */
  function canEdit(rawRef) {
    try { return !editable(open(), rawRef).refusal; } catch { return false; }
  }

  return { routes, view, editView, canEdit, token: (cookieHeader) => writes.token(cookieHeader, 'note') };
}
