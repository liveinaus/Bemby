const Database = require('better-sqlite3');
const AFTER = 929;
const DEADLINE = Date.now() + 55 * 60 * 1000;

function poll() {
  const db = new Database('/git/Bemby/backend/data/bemby.db', { readonly: true });
  const row = db
    .prepare("select id,job_id,status,detail from job_logs where id>? and job_id in (195,196) and status!='running' order by id desc limit 1")
    .get(AFTER);
  db.close();
  return row;
}

(async () => {
  for (;;) {
    const row = poll();
    if (row) {
      console.log('log', row.id, 'job', row.job_id, row.status);
      try {
        const ws = JSON.parse(row.detail)[0].steps[0].webSteps || [];
        ws.slice(74).forEach((s, i) => console.log(i + 74, s.type, '|', (s.outcome || s.error || '').slice(0, 260)));
      } catch (e) { console.log('no step detail:', e.message); }
      return;
    }
    if (Date.now() > DEADLINE) { console.log('no new run within the watch window'); return; }
    await new Promise((r) => setTimeout(r, 30000));
  }
})();
