import { sectionProjectId } from '../_shared/journal.js';
import { startDocument, section, el, button, field, link } from '../_shared/doc-frame.js';

const requested = new URLSearchParams(location.search).get('project');
let deleted = false;
const selected = (ctx) => requested === null ? ctx.data.projects[0] : ctx.data.projects.find((project) => project.id === requested);
startDocument({
  copy: {
    empty: ['Proje içeriği görünmüyor', 'Kartlarını ve notlarını görmek için proje görünümüne dön.', 'Projeye dön'],
    loading: ['Proje özeti hesaplanıyor', 'Projeye bağlı kartlar ve sayfalar sayılıyor.'],
    error: ['Proje açılamadı', 'Projenin index.md dosyasına erişimi kontrol et, sonra projeyi yeniden yükle.'],
  },
  firstStep(ctx) { ctx.setState('full'); },
  record: selected,
  reset() { deleted = false; },
  reload(ctx) { ctx.record.description = `${ctx.data.projectSummaries.find((item) => item.projectId === ctx.record.id).description}. Sonraki adımlar kartlarda.`; },
  markdown: (ctx) => `# ${ctx.record.name}\n\n${ctx.record.description || ctx.data.projectSummaries.find((item) => item.projectId === ctx.record.id).description}`,
  sidebar(ctx) {
    const project = selected(ctx);
    return { project, groups: [{ title: project.name, entries: [{ title: 'Genel bakış', href: `../project/?project=${project.id}`, current: true }, { title: 'Notlar', href: `../notes/?project=${project.id}` }, { title: 'Kartlar', href: `../board/?project=${project.id}` }, { title: 'Günlük', href: `../journal/?project=${project.id}` }, { title: 'Araştırmalar', href: `../research/?project=${project.id}` }] }] };
  },
  render(ctx) {
    const project = selected(ctx);
    const summary = ctx.data.projectSummaries.find((item) => item.projectId === project.id);
    ctx.header(project.name, `projects/${project.id}/index.md`, () => `# ${project.name}\n\n${project.description || summary.description}`, true);
    document.querySelector('.project-cover').style.setProperty('--project-wash', `var(--color-tone-${project.tone}-bg)`);
    if (deleted) { ctx.body.replaceChildren(el('p', 'muted', 'Proje çöp kutusuna taşındı. Bağlı notlar ve kartlar yerinde duruyor.')); return; }
    const toolbar = el('div', 'row doc-toolbar');
    const edit = button('Projeyi düzenle', () => {
      if (!ctx.canWrite()) return;
      const name = field('Proje adı'); name.control.value = project.name; name.control.required = true;
      const description = field('Açıklama', 'textarea'); description.control.value = project.description || summary.description;
      ctx.ui.open('Projeyi düzenle', [name.wrapper, description.wrapper], () => {
        if (!ctx.canWrite()) return false;
        if (!name.control.value.trim()) { name.control.setCustomValidity('Bir proje adı yaz.'); name.control.reportValidity(); return false; }
        project.name = name.control.value.trim(); project.description = description.control.value.trim(); ctx.refresh(); ctx.toast('Proje kaydedildi.');
      }, false, 'Projeyi kaydet');
      name.control.addEventListener('input', () => name.control.setCustomValidity(''));
    });
    const archive = button(project.archived ? 'Projeyi arşivden çıkar' : 'Projeyi arşivle', () => ctx.confirm(project.archived ? 'Projeyi arşivden çıkar' : 'Projeyi arşivle', 'Projenin arşiv durumunu bu oturumda değiştirebilirsin.', () => {
      project.archived = !project.archived; ctx.refresh(); ctx.focus('#project-archive'); ctx.toast(project.archived ? 'Proje arşivlendi.' : 'Proje arşivden çıkarıldı.');
    }, project.archived ? 'Projeyi arşivden çıkar' : 'Projeyi arşivle')); archive.id = 'project-archive';
    const remove = button('Projeyi sil', () => ctx.confirm('Projeyi sil', 'Yalnız proje dosyası çöp kutusuna taşınacak. Projeye bağlı notlar ve kartlar yerinde kalır; onları ayrı ayrı taşıyabilir ya da silebilirsin. İşlemi geri alabilirsin.', () => {
      deleted = true; ctx.refresh(); ctx.focus(); ctx.toast('Proje çöp kutusuna taşındı; bağlı sayfalar yerinde.', () => { deleted = false; ctx.refresh(); });
    }, 'Çöp kutusuna taşı'), 'button button--danger');
    [edit, archive, remove].forEach((node) => { node.disabled = ctx.state === 'locked'; });
    toolbar.append(edit, archive, remove);
    if (ctx.state === 'locked') toolbar.append(el('span', 'type-label muted', 'claude üzerinde çalışıyor.'));
    const description = el('p', 'project-description', ctx.text(project.description || summary.description));
    const cards = ctx.data.cards.filter((record) => record.projectId === project.id);
    const completed = cards.filter((record) => record.column === 'done');
    const low = cards.filter((record) => record.column !== 'done' && record.priority === 'low');
    const open = cards.filter((record) => record.column !== 'done' && record.priority !== 'low');
    const box = section('Açık işler', 'open-cards'); box.className = 'project-open';
    const header = el('div', 'project-open-header'); header.append(box.firstElementChild);
    const counts = el('span', 'project-open-summary'); counts.append(`${open.length} açık${low.length ? ` (+${low.length} düşük öncelikli)` : ''} · ${completed.length}/${cards.length} bitti · `, link('Panoda gör', `../board/?project=${project.id}`)); header.append(counts); box.append(header);
    [['urgent', 'Acil'], ['important', 'Önemli'], ['', 'Diğer']].forEach(([priority, title]) => {
      const records = open.filter((record) => (record.priority || '') === priority);
      if (!records.length) return;
      box.append(el('h3', `project-priority project-priority-${priority || 'none'}`, title));
      const list = el('ul'); records.forEach((record) => {
        const li = el('li'); const column = ctx.data.columns.find((column) => column.id === record.column);
        const copy = el('div'); copy.append(link(ctx.text(record.title), `../card/?id=${record.id}`), el('p', '', 'Sonra: Kartın kalan ölçütlerini denetle.'));
        li.append(el('span', `chip chip--${column.role === 'todo' ? 'planned' : column.role}`, column.label), copy); list.append(li);
      }); box.append(list);
    });
    if (!open.length) box.append(el('p', 'type-label muted', low.length ? 'Yalnız düşük öncelikli işler var; Pano’da görünür.' : 'Panoda açık iş yok.'));
    const sections = el('ul', 'project-sections');
    const records = ctx.data.notes.filter((record) => record.projectId === project.id);
    const journalCount = ctx.data.journal.filter((entry) => sectionProjectId(entry, ctx.data.projects) === project.id).length;
    [['Notlar', records.filter((record) => record.kind !== 'research').length, `../notes/?project=${project.id}`], ['Kartlar', cards.length, `../board/?project=${project.id}`], ['Günlük', journalCount, `../journal/?project=${project.id}`], ['Araştırmalar', records.filter((record) => record.kind === 'research').length, `../research/?project=${project.id}`]].forEach(([title, count, href]) => {
      const item = el('li'); const anchor = link('', href, 'project-section-link'); anchor.append(el('span', 'project-section-name', title), el('span', 'project-section-count', `${count} ${title === 'Kartlar' ? 'kart' : title === 'Günlük' ? 'iş' : 'sayfa'}`)); item.append(anchor); sections.append(item);
    });
    ctx.body.replaceChildren(toolbar, description);
    if (project.archived) ctx.body.append(el('p', 'type-label muted', 'Arşivlenmiş proje'));
    ctx.body.append(box, sections);
  }
});
