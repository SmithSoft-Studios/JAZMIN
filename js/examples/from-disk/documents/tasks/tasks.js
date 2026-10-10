// The task list's page: every row is editable; the changes (edited, added and removed rows) are saved together with
// jazmin.saveChanges, which the viewer checks against what the file allows (its package's edit), shows to the person,
// and saves as a change file once they confirm.
(function () {
  const $ = (id) => document.getElementById(id);
  const edit = jazmin.edit; // { key, columns, add, delete }, or null where nothing can be saved
  const day = (date) => (date ? new Date(date).toISOString().slice(0, 10) : '');
  const original = new Map(jazmin.rows().map((r) => [r.id, { ...r, due: day(r.due) }]));
  const rows = [...original.values()].map((r) => ({ ...r }));
  const removed = new Set();
  let next = Math.max(...rows.map((r) => Number(r.id.slice(2)))) + 1;

  if (jazmin.metadata && jazmin.metadata.title) $('title').textContent = jazmin.metadata.title;
  $('readonly').hidden = Boolean(edit);
  $('add').hidden = !(edit && edit.add);

  const COLUMNS = ['task', 'owner', 'due', 'priority', 'status'];
  const changed = (r) => original.has(r.id) && COLUMNS.some((c) => original.get(r.id)[c] !== r[c]);

  /** The changes as saveChanges takes them: the key with the columns that changed, the new rows, the removed keys. */
  function changes() {
    const update = [];
    const add = [];
    for (const r of rows) {
      if (removed.has(r.id)) continue;
      if (!original.has(r.id)) add.push({ ...r, due: r.due ? new Date(`${r.due}T15:00:00Z`) : null });
      else if (changed(r)) {
        const was = original.get(r.id);
        const row = { id: r.id };
        for (const c of COLUMNS) if (was[c] !== r[c]) row[c] = c === 'due' ? (r.due ? new Date(`${r.due}T15:00:00Z`) : null) : r[c];
        update.push(row);
      }
    }
    return { update, add, delete: [...removed].filter((id) => original.has(id)).map((id) => ({ id })) };
  }

  function refresh() {
    const c = changes();
    const parts = [c.update.length && `${c.update.length} changed`, c.add.length && `${c.add.length} added`, c.delete.length && `${c.delete.length} removed`].filter(Boolean);
    $('pending').textContent = parts.join(' · ');
    $('save').disabled = !edit || parts.length === 0;
    const open = rows.filter((r) => !removed.has(r.id) && r.status !== 'Done').length;
    $('summary').textContent = `${rows.length - removed.size} tasks · ${open} still to do`;
  }

  const input = (r, column, make) => {
    const el = make();
    el.value = r[column] || '';
    el.disabled = !edit || (edit.columns && !edit.columns.includes(column) && original.has(r.id));
    el.setAttribute('aria-label', `${column} of ${r.id}`);
    el.addEventListener('input', () => {
      r[column] = el.value;
      draw();
    });
    return el;
  };
  const select = (options) => () => {
    const el = document.createElement('select');
    el.append(...options.map((o) => new Option(o, o)));
    return el;
  };

  function draw() {
    $('tasks').tBodies[0].replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      tr.className = [removed.has(r.id) ? 'removed' : !original.has(r.id) ? 'added' : changed(r) ? 'changed' : '', `status-${r.status.replace(/\s/g, '')}`, `priority-${r.priority}`].join(' ');
      const cells = [
        ['task', input(r, 'task', () => document.createElement('input'))],
        ['owner', input(r, 'owner', () => document.createElement('input'))],
        ['due', input(r, 'due', () => Object.assign(document.createElement('input'), { type: 'date' }))],
        ['priority', input(r, 'priority', select(['High', 'Medium', 'Low']))],
        ['status', input(r, 'status', select(['Open', 'In progress', 'Done']))],
      ];
      for (const [name, el] of cells) {
        const td = document.createElement('td');
        td.className = name;
        td.append(el);
        tr.append(td);
      }
      const td = document.createElement('td');
      td.className = 'remove';
      if (edit && edit.delete) {
        const button = Object.assign(document.createElement('button'), { type: 'button', textContent: removed.has(r.id) ? '↺' : '✕', title: removed.has(r.id) ? 'Keep' : 'Remove' });
        button.setAttribute('aria-label', `${removed.has(r.id) ? 'Keep' : 'Remove'} ${r.id}`);
        button.addEventListener('click', () => {
          if (removed.has(r.id)) removed.delete(r.id);
          else if (original.has(r.id)) removed.add(r.id);
          else rows.splice(rows.indexOf(r), 1); // a row added here and not saved: simply dropped
          draw();
        });
        td.append(button);
      }
      tr.append(td);
      return tr;
    }));
    refresh();
  }

  $('add').addEventListener('submit', (event) => {
    event.preventDefault();
    rows.push({ id: `T-${next++}`, task: $('new-task').value.trim(), owner: $('new-owner').value.trim(), due: $('new-due').value, priority: $('new-priority').value, status: 'Open' });
    $('add').reset();
    draw();
  });

  $('save').addEventListener('click', async () => {
    $('save').disabled = true;
    $('result').hidden = true;
    try {
      const r = await jazmin.saveChanges(changes());
      $('result').className = 'banner ok';
      $('result').textContent = `Saved ${r.file}: ${r.updated} changed, ${r.added} added, ${r.deleted} removed. Send it to the list's owner, who applies it.`;
      for (const id of removed) original.delete(id);
      for (const row of rows.filter((x) => !removed.has(x.id))) original.set(row.id, { ...row });
      for (const id of removed) rows.splice(rows.findIndex((x) => x.id === id), 1);
      removed.clear();
      draw();
    } catch (error) {
      $('result').className = 'banner bad';
      $('result').textContent = `Not saved: ${error.message || error}`;
      refresh();
    }
    $('result').hidden = false;
  });

  draw();
  jazmin.ready({ rows: rows.length });
}());
