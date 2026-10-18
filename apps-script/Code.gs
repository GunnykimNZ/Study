/**
 * 跟Gunny学韩语 — quiz submission inbox.
 *
 * Student page  → POST submission          → saved to Drive (one folder per submission), teacher gets an email
 * Teacher tools → GET  ?action=list&token  → list submissions
 *                 GET  ?action=get&id&token → full submission (answers + handwriting PNGs)
 *                 POST {action:'result', token, id, result} → save grading, email teacher
 *                 POST {action:'trash', token, id} → move a test / junk submission to the Drive trash
 * Student page  → GET  ?action=result&id    → grading result (only once published)
 *                 GET  ?action=status&key   → id of the submission sent with this client key (to confirm a submit whose response was lost)
 *                 GET  ?action=find&quizId&student → latest submission id for that quiz/student (recovery for pages from before client keys)
 *
 * ADMIN_TOKEN lives in Script properties or in a private Secrets.gs (never in the public repo).
 * Deploy: Deploy → Manage deployments → ✏️ Edit → Version: New version (keeps the same URL).
 */
const ROOT_FOLDER = '跟Gunny学韩语 제출';
const TIMEZONE = 'Pacific/Auckland';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'result') return json_(saveResult_(data));
    if (data.action === 'trash') { auth_(data.token); submissionFolder_(data.id).setTrashed(true); return json_({ ok: true }); }
    return json_(saveSubmission_(data));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'result') return json_(readResult_(p.id));
    if (p.action === 'status') return json_({ ok: true, id: findByKey_(p.key) });
    if (p.action === 'find') return json_({ ok: true, id: findLatest_(p.quizId, p.student) });
    if (p.action === 'list') { auth_(p.token); return json_({ ok: true, items: list_() }); }
    if (p.action === 'get') { auth_(p.token); return json_({ ok: true, submission: readJson_(submissionFolder_(p.id), 'submission.json') }); }
    return json_({ ok: true, service: 'gunny-quiz' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/* ---------------- submissions ---------------- */

function saveSubmission_(data) {
  // retries of the same submit (same client key) return the first one instead of saving a duplicate
  const existing = findByKey_(data.clientKey);
  if (existing) return { ok: true, id: existing, duplicate: true };
  const stamp = Utilities.formatDate(new Date(data.submittedAt), TIMEZONE, 'yyyy-MM-dd HH:mm');
  const folder = folder_(ROOT_FOLDER).createFolder(`${stamp} · ${data.student} · ${data.quiz}`);
  if (data.clientKey) folder.setDescription('key:' + data.clientKey);
  // only one file, so the response comes back in a few seconds (saving ~50 PNGs one by one took ~50 s and Safari gave up);
  // the handwriting images stay inside submission.json and are extracted by tools/submissions.py
  folder.createFile('submission.json', JSON.stringify(data), MimeType.PLAIN_TEXT);
  const done = data.answers.filter((a) => !a.blank).length;
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: `[跟Gunny学韩语] ${data.student} 제출 — ${data.quiz}`,
    htmlBody: `<div style="font-family:-apple-system,sans-serif">
      <h2 style="margin:0">${esc_(data.student)} 님이 시험을 제출했습니다</h2>
      <p>${esc_(data.quiz)} · ${stamp} · 작성 ${done}/${data.answers.length} · 소요 ${Math.round(data.seconds / 60)}분</p>
      <p>Claude에게 <b>"아리엘 제출했어, 채점해 줘"</b>라고 말하면 채점 후 결과가 시험 페이지에 표시됩니다.</p>
      <p><a href="${folder.getUrl()}">Drive 폴더 열기</a> · 제출 ID: <code>${folder.getId()}</code></p></div>`,
  });
  return { ok: true, id: folder.getId() };
}

function findByKey_(key) {
  if (!key) return null;
  const it = folder_(ROOT_FOLDER).getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getDescription() === 'key:' + key) return f.getId();
  }
  return null;
}

function findLatest_(quizId, student) {
  let best = null;
  const it = folder_(ROOT_FOLDER).getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (student && f.getName().indexOf(student) < 0) continue;
    const files = f.getFilesByName('submission.json');
    if (!files.hasNext()) continue;
    const sub = JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));
    if (sub.quizId !== quizId || sub.student !== student) continue;
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  }
  return best ? best.getId() : null;
}

function list_() {
  const out = [];
  const it = folder_(ROOT_FOLDER).getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.getFilesByName('submission.json').hasNext()) continue;
    out.push({ id: f.getId(), name: f.getName(), created: f.getDateCreated().toISOString(), graded: f.getFilesByName('result.json').hasNext() });
  }
  return out.sort((a, b) => (a.created < b.created ? 1 : -1));
}

/* ---------------- results ---------------- */

function saveResult_(data) {
  auth_(data.token);
  const folder = submissionFolder_(data.id);
  const old = folder.getFilesByName('result.json');
  while (old.hasNext()) old.next().setTrashed(true);
  const result = Object.assign({}, data.result, { publishedAt: new Date().toISOString() });
  folder.createFile('result.json', JSON.stringify(result), MimeType.PLAIN_TEXT);
  mailResult_(readJson_(folder, 'submission.json'), result, folder.getUrl());
  return { ok: true };
}

function readResult_(id) {
  const folder = submissionFolder_(id);
  if (!folder.getFilesByName('result.json').hasNext()) return { ok: true, ready: false };
  return { ok: true, ready: true, result: readJson_(folder, 'result.json') };
}

function mailResult_(sub, r, url) {
  const byN = {};
  (r.items || []).forEach((x) => { byN[x.n] = x; });
  const imgs = {};
  let rows = '';
  sub.answers.forEach((a) => {
    const x = byN[a.n] || {};
    let ans = '<span style="color:#c2410c">（未作答）</span>';
    if (!a.blank && a.type === 'mc') ans = `선택: <b>${esc_('①②③④'[a.choice] + ' ' + a.options[a.choice])}</b>`;
    else if (!a.blank) {
      imgs['q' + a.n] = Utilities.newBlob(Utilities.base64Decode(a.png), 'image/png', `q${a.n}.png`);
      ans = `<img src="cid:q${a.n}" width="${a.type === 'vocab' ? 300 : 420}" style="border:1px solid #f0dde3;border-radius:6px">`;
    }
    const mark = x.score === 1 ? '⭕' : x.score === 0.5 ? '🔺' : '❌';
    rows += `<tr><td style="padding:8px;vertical-align:top;font-weight:700;color:#d6457a">${a.n}</td>
      <td style="padding:8px;vertical-align:top">${esc_(a.prompt)}<br><small style="color:#888">${esc_(a.hint)}</small><div style="margin-top:6px">${ans}</div></td>
      <td style="padding:8px;vertical-align:top;min-width:200px"><div style="font-size:17px">${mark} <b>${x.score == null ? '' : x.score}</b></div>
        ${x.read ? `<div>읽은 답: <b>${esc_(x.read)}</b></div>` : ''}<div style="color:#b0305f">${esc_(x.note_ko || '')}</div>
        <div style="color:#666">${esc_(x.feedback_zh || '')}</div></td></tr>`;
  });
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: `[跟Gunny学韩语] ${sub.student} ${r.score}/${r.max}점 — ${sub.quiz}`,
    htmlBody: `<div style="font-family:-apple-system,sans-serif;max-width:760px">
      <h2 style="margin:0">${esc_(sub.student)} · ${esc_(sub.quiz)}</h2>
      <div style="font-size:30px;font-weight:800;color:#d6457a">${r.score} / ${r.max}</div>
      <p><b>총평</b> ${esc_(r.summary_ko || '')}</p><p style="color:#555"><b>给学生</b> ${esc_(r.summary_zh || '')}</p>
      <p style="color:#999;font-size:12px">채점: Claude · 결과는 학생의 시험 페이지에도 표시됩니다. <a href="${url}">Drive 폴더</a></p>
      <table style="border-collapse:collapse;width:100%" border="1" bordercolor="#f0dde3">${rows}</table></div>`,
    inlineImages: imgs,
  });
}

/* ---------------- helpers ---------------- */

function auth_(token) {
  const want = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') ||
    ((typeof SECRET_ADMIN_TOKEN !== 'undefined' && SECRET_ADMIN_TOKEN) || '');
  if (!want || token !== want) throw new Error('unauthorized');
}

/** Only folders directly inside ROOT_FOLDER can be read — ids from anywhere else are rejected. */
function submissionFolder_(id) {
  if (!id) throw new Error('missing id');
  const f = DriveApp.getFolderById(id);
  const parents = f.getParents();
  const root = folder_(ROOT_FOLDER).getId();
  while (parents.hasNext()) if (parents.next().getId() === root) return f;
  throw new Error('not a submission');
}

function readJson_(folder, name) {
  const it = folder.getFilesByName(name);
  if (!it.hasNext()) throw new Error(`${name} not found`);
  return JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
}

function folder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
