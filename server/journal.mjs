// The journal form uses the same write layer as the card and project forms: one route handed to `createWrites`.
import * as journal from '../core/journal.mjs';
import * as project from '../core/project.mjs';
import { localDate, validateDate } from '../core/entity.mjs';
import { CairnError } from '../core/errors.mjs';
import { stripHidden } from '../core/text.mjs';
import { createWrites } from './writes.mjs';

const MAX_ITEMS = 50;
const MAX_ITEM = 2000;
const MAX_TITLE = 200;
const MAX_LABEL = 100;
const bad = (message) => ({ status: 400, title: 'write.badRequestTitle', message });
const NOT_READY = Object.freeze({ status: 409, title: 'state.notReadyTitle', message: 'journalForm.notReady' });
const notReady = (error) => error instanceof CairnError
  && ['validation', 'not_found', 'format_too_new'].includes(error.code);
/** One visible line: no line breaks or tabs, and none of the invisible characters the core strips elsewhere. */
const oneLine = (text, max) => {
  const value = text.trim();
  return Boolean(value) && value.length <= max && !/[\t\r\n\u0085]/u.test(text) && stripHidden(text).removed === 0;
};

export function createJournal({ key, port, open, openWrite }) {
  const DATE = '(?<date>[0-9]{4}-[0-9]{2}-[0-9]{2})';
  const back = ({ date }) => ({ href: `/journal/${date}`, label: 'journalForm.back' });
  const failure = (error) => error.code === 'validation' ? bad('journalForm.invalidWrite') : undefined;
  const bodyLimit = 4 * MAX_ITEMS * (MAX_ITEM + 2) + 4096;
  const opened = () => {
    try { return { ctx: open() }; } catch (error) {
      if (notReady(error)) return { refusal: NOT_READY };
      throw error;
    }
  };

  const routes = [{ path: new RegExp(`^/journal/${DATE}$`, 'u'), form: 'journal', back, failure, bodyLimit,
    run({ values, params: { date } }) {
      if (Object.keys(values).some((name) => !['title', 'label', 'project', 'items'].includes(name))
        || typeof values.title !== 'string') return bad('journalForm.invalidFields');
      try { validateDate(date); } catch (error) {
        if (error instanceof CairnError) return bad('journalForm.invalidDate');
        throw error;
      }
      if (!oneLine(values.title, MAX_TITLE)) return bad('journalForm.invalidTitle');
      const label = values.label?.trim() ? values.label : undefined;
      if (label !== undefined && !oneLine(label, MAX_LABEL)) return bad('journalForm.invalidLabel');
      const items = (values.items ?? '').replace(/\r\n|\r/gu, '\n').split('\n').map((line) => line.trim())
        .filter(Boolean);
      if (items.length > MAX_ITEMS || items.some((line) => line.length > MAX_ITEM
        || stripHidden(line).removed > 0)) return bad('journalForm.invalidItems');
      const { ctx, refusal } = opened();
      if (refusal) return refusal;
      const fields = { date, title: values.title.trim(), entries: items.map((text) => ({ type: null, text })) };
      if (label !== undefined) fields.label = label.trim();
      if (values.project) {
        try { fields.project = project.resolve(ctx, values.project).id ?? undefined; } catch (error) {
          if (error instanceof CairnError && ['not_found', 'validation'].includes(error.code)) {
            return bad('journalForm.invalidProject');
          }
          throw error;
        }
        if (fields.project === undefined) return bad('journalForm.invalidProject');
      }
      journal.addEntry(openWrite(), fields, {});
      return `/journal/${date}`;
    } }];
  const writes = createWrites({ key, port, routes });

  /** What the day page shows: the token, today's date and the active projects the job can link to. */
  function view(cookieHeader) {
    const csrf = writes.token(cookieHeader, 'journal');
    const { ctx, refusal } = opened();
    if (refusal) return { state: 'notReady', csrf };
    const projects = project.list(ctx)
      .filter(({ id, data }) => id && (data.status === undefined || data.status === 'active'));
    return { state: 'ready', csrf, today: localDate(ctx), projects };
  }

  return { routes, view };
}
