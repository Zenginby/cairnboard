import { el, field } from './app-ui.js';
import { journalTypes } from './journal.js';

// The fields for one new journal section (a job title plus one item), shared by the month page's dialog and the day page's
// form. The core stores a title, an optional label and typed items; a project is only a `[[project-id]]` link in an item.
// read() returns { title, items } or null (the invalid field reports itself).
export function journalFields(data, defaultProject = '') {
  const title = field('İş başlığı');
  title.control.required = true;
  const type = field('Madde türü', 'select');
  [['', 'Türsüz'], ...Object.entries(journalTypes)].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; type.control.append(option); });
  const text = field('Madde', 'textarea');
  text.control.required = true;
  const project = field('Proje', 'select');
  [{ id: '', name: 'Proje yok' }, ...data.projects].forEach((record) => { const option = el('option', '', record.name); option.value = record.id; project.control.append(option); });
  project.control.value = data.projects.some((record) => record.id === defaultProject) ? defaultProject : '';
  [title, text].forEach((item) => item.control.addEventListener('input', () => item.control.setCustomValidity('')));
  return {
    nodes: [title.wrapper, type.wrapper, text.wrapper, project.wrapper],
    controls: { title: title.control, text: text.control },
    read() {
      const heading = title.control.value.trim();
      const body = text.control.value.trim();
      const bad = !heading ? [title.control, 'Bir iş başlığı yaz.'] : !body ? [text.control, 'Kısa bir madde yaz.'] : null;
      if (bad) { bad[0].setCustomValidity(bad[1]); bad[0].reportValidity(); return null; }
      const owner = data.projects.find((record) => record.id === project.control.value);
      return { title: heading, items: [{ ...(type.control.value ? { type: type.control.value } : {}), text: owner ? `${body} [[${owner.id}|${owner.name}]]` : body }] };
    },
  };
}
