import { priorities, priorityChip, lockMessage } from '../_shared/app-ui.js';
import { startDocument, markdownEditor, renderMarkdown, section, el, button, field, link, projectChip } from '../_shared/doc-frame.js';

const id = new URLSearchParams(location.search).get('id') || 'card-1';
let editing = false;
let deleted = false;
let closeMoveMenu = () => {};
document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.card-move-dropdown')) closeMoveMenu(); });
const bodyFor = (ctx) => ctx.record.body || ctx.data.body;
startDocument({
  record: (ctx) => ctx.data.cards.find((record) => record.id === id) || ctx.data.cards[0],
  markdown: bodyFor,
  reset(ctx, value) { editing = value === 'conflict'; deleted = false; },
  reload(ctx) { ctx.record.body = `${bodyFor(ctx)}\n\nDışarıda eklenen not: Birlikte yeniden gözden geçir.`; editing = false; },
  firstStep(ctx) { if (ctx.canWrite()) ctx.ui.create('card'); },
  emptyLabel: 'Kart ekle',
  sidebar: (ctx) => ({ groups: [{ title: 'Proje', entries: [{ title: ctx.data.projects.find((project) => project.id === ctx.record.projectId).name, href: `../project/?project=${ctx.record.projectId}` }] }, { title: 'Kartlar', entries: ctx.data.cards.filter((record) => !record.trashed && record.projectId === ctx.record.projectId).map((record) => ({ title: ctx.text(record.title), href: `../card/?id=${record.id}`, current: record.id === ctx.record.id })) }] }),
  render(ctx) {
    const record = ctx.record;
    ctx.header(record.title, `cards/${record.id}.md`, () => `# ${record.title}\n\n${bodyFor(ctx)}`);
    if (deleted) { ctx.body.replaceChildren(el('p', 'muted', 'Kart çöp kutusuna taşındı.')); return; }
    const locked = ctx.state === 'locked';
    const column = ctx.data.columns.find((item) => item.id === record.column);
    const project = ctx.data.projects.find((item) => item.id === record.projectId);
    const toolbar = el('div', 'row doc-toolbar');
    const dropdown = el('div', 'dropdown card-move-dropdown');
    const menu = el('div', 'menu card-move-menu'); menu.id = 'card-move'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Hedef sütun'); menu.inert = true;
    const close = (restore = false) => {
      menu.classList.remove('is-open'); menu.inert = true; move.setAttribute('aria-expanded', 'false');
      if (restore) move.focus({ preventScroll: true });
    };
    closeMoveMenu = close;
    const open = (instant = false, last = false) => {
      menu.classList.toggle('is-instant', instant); menu.classList.add('is-open'); menu.inert = false; move.setAttribute('aria-expanded', 'true');
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    };
    const move = button('Taşı…', (event) => menu.inert ? open(event.detail === 0) : close(true));
    move.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(true, event.key === 'ArrowUp'); }
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      const positions = { ArrowDown: (index + 1) % items.length, ArrowUp: (index - 1 + items.length) % items.length, Home: 0, End: items.length - 1 };
      if (event.key in positions) { event.preventDefault(); items[positions[event.key]].focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(true); }
      else if (event.key === 'Tab') close();
    });
    dropdown.addEventListener('focusout', (event) => { if (!dropdown.contains(event.relatedTarget)) close(); });
    move.setAttribute('aria-haspopup', 'menu'); move.setAttribute('aria-expanded', 'false'); move.setAttribute('aria-controls', menu.id);
    ctx.data.columns.forEach((target) => {
      const item = button(target.label, () => {
        close(true);
        if (!ctx.canWrite()) return;
        record.column = target.id; ctx.refresh(); ctx.focus('#card-move-trigger'); ctx.toast(`Kart ${target.label} sütununa taşındı.`);
      });
      item.setAttribute('role', 'menuitem'); item.disabled = target.id === record.column; menu.append(item);
    });
    move.id = 'card-move-trigger'; dropdown.append(move, menu);
    const edit = button('Düzenle', () => { if (!ctx.canWrite()) return; editing = true; ctx.refresh(); ctx.focus('.doc-editor textarea'); }); edit.id = 'card-edit';
    const remove = button('Sil', () => ctx.confirm('Kartı çöp kutusuna taşı', 'Kartı ve yorumlarını bu oturumda geri alabilirsiniz.', () => {
      deleted = true; record.trashed = true; editing = false; ctx.refresh(); ctx.focus(); ctx.toast('Kart çöp kutusuna taşındı.', () => { deleted = false; record.trashed = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [move, edit, remove].forEach((node) => { node.disabled = locked; });
    toolbar.append(dropdown, edit, remove);
    const badges = el('div', 'row card-badges');
    badges.append(el('span', `chip chip--${column.role === 'todo' ? 'planned' : column.role}`, column.label), priorityChip(record.priority), projectChip(project));
    const ownerId = locked ? 'claude' : record.assigneeId;
    const owner = ctx.data.people.find((person) => person.id === ownerId);
    badges.append(el('span', owner ? 'chip' : 'badge', owner ? owner.name : `${ownerId} · ajan`));
    ctx.body.replaceChildren(toolbar, badges);
    if (locked) ctx.body.append(lockMessage());
    const criteria = section('Kabul ölçütleri', 'criteria');
    const done = record.criteria.filter((criterion) => criterion.done).length;
    const progressText = el('p', 'type-label muted', `${done}/${record.criteria.length} tamamlandı`);
    progressText.setAttribute('role', 'status');
    const progress = el('progress', 'criteria-progress'); progress.max = record.criteria.length || 1; progress.value = done; progress.setAttribute('aria-label', 'Kabul ölçütleri ilerlemesi');
    const list = el('ol', 'criteria-steps');
    record.criteria.forEach((criterion, index) => {
      const item = el('li'); const label = el('label'); const check = el('input');
      check.id = `criterion-${index}`; check.type = 'checkbox'; check.checked = criterion.done; check.disabled = locked;
      check.addEventListener('change', () => { if (!ctx.canWrite()) { check.checked = criterion.done; return; } criterion.done = check.checked; ctx.refresh(); ctx.focus(`#criterion-${index}`); ctx.ui.announce(`Kabul ölçütü ${criterion.done ? 'tamamlandı' : 'yeniden açıldı'}.`); });
      label.append(check, el('span', '', ctx.text(criterion.text)));
      item.append(el('span', 'criterion-date', criterion.done ? '3 Kasım' : 'sırada'), label); list.append(item);
    });
    criteria.append(progressText, progress, list); ctx.body.append(criteria);
    if (editing) {
      const title = field('Kart başlığı'); title.control.value = record.title; title.control.required = true;
      const priority = field('Öncelik', 'select');
      Object.entries(priorities).forEach(([value, text]) => { const option = el('option', '', text); option.value = value; priority.control.append(option); }); priority.control.value = record.priority;
      const editor = markdownEditor(ctx, bodyFor(ctx), (value) => {
        if (!title.control.value.trim()) { title.control.reportValidity(); return; }
        record.title = title.control.value.trim(); record.priority = priority.control.value; record.body = value; editing = false;
        ctx.refresh(); ctx.focus('#card-edit'); ctx.toast('Kart kaydedildi.');
      }, () => { editing = false; ctx.refresh(); ctx.focus('#card-edit'); });
      ctx.body.append(title.wrapper, priority.wrapper, editor.node);
    } else ctx.body.append(renderMarkdown(bodyFor(ctx), ctx.data.notes));
    const comments = section('Yorumlar', 'comments'); const thread = el('ol', 'comment-thread');
    ctx.data.commentThread.forEach((comment) => {
      const row = el('li'); const meta = el('div', 'comment-meta');
      const person = ctx.data.people.find((person) => person.id === comment.authorId);
      meta.append(el('strong', '', person?.name || `${comment.authorId} · ajan`), el('time', '', comment.time));
      row.append(meta, el('p', '', ctx.text(comment.body))); thread.append(row);
    });
    const form = el('form', 'stack'); const comment = field('Yorum ekle', 'textarea'); comment.control.id = 'comment-input'; comment.control.required = true; comment.control.disabled = locked;
    const submit = el('button', 'button', 'Yorum ekle'); submit.type = 'submit'; submit.disabled = locked;
    form.append(comment.wrapper, submit);
    form.addEventListener('submit', (event) => {
      event.preventDefault(); if (!ctx.canWrite()) return;
      const value = comment.control.value.trim();
      if (!value) { comment.control.setCustomValidity('Bir yorum yazın.'); comment.control.reportValidity(); return; }
      ctx.data.commentThread.push({ authorId: 'ada', time: 'Şimdi', body: value }); record.comments++;
      ctx.refresh(); ctx.focus('#comment-input'); ctx.toast('Yorum eklendi.');
    });
    comment.control.addEventListener('input', () => comment.control.setCustomValidity(''));
    comments.append(thread, form); ctx.body.append(comments, link('Panoda gör', `../board/?project=${record.projectId}`, 'type-label'));
  }
});
