/**
 * 跟Gunny学韩语 — quiz submission receiver.
 * Saves each handwritten answer (PNG) to Google Drive and emails a grading sheet to the script owner.
 * Deploy: Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 */
const ROOT_FOLDER = '跟Gunny学韩语 제출';
const TIMEZONE = 'Pacific/Auckland';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const stamp = Utilities.formatDate(new Date(data.submittedAt), TIMEZONE, 'yyyy-MM-dd HH:mm');
    const folder = folder_(ROOT_FOLDER).createFolder(`${stamp} · ${data.student} · ${data.quiz}`);

    const inline = {};
    let rows = '';
    data.answers.forEach((a) => {
      let cell = '<span style="color:#c2410c">（未作答）</span>';
      if (!a.blank) {
        const name = `Q${String(a.n).padStart(2, '0')}.png`;
        const blob = Utilities.newBlob(Utilities.base64Decode(a.png), 'image/png', name);
        folder.createFile(blob);
        inline['q' + a.n] = blob;
        const w = a.type === 'vocab' ? 220 : 460;
        cell = `<img src="cid:q${a.n}" width="${w}" style="border:1px solid #ddd;border-radius:6px">`;
      }
      rows += `<tr><td style="padding:8px;vertical-align:top;font-weight:700;color:#0a66c2">${a.n}</td>
        <td style="padding:8px;vertical-align:top">${esc_(a.prompt)}<br><small style="color:#888">${esc_(a.hint)}</small></td>
        <td style="padding:8px">${cell}</td></tr>`;
    });

    const mins = Math.floor(data.seconds / 60), secs = data.seconds % 60;
    const done = data.answers.filter((a) => !a.blank).length;
    const html = `<div style="font-family:sans-serif">
      <h2 style="margin:0">${esc_(data.student)} · ${esc_(data.quiz)}</h2>
      <p style="color:#666">提交 ${stamp} · 用时 ${mins}分${secs}秒 · 作答 ${done}/${data.answers.length}
      · <a href="${folder.getUrl()}">Drive 폴더</a></p>
      <table style="border-collapse:collapse" border="1" bordercolor="#eee">${rows}</table></div>`;

    MailApp.sendEmail({
      to: Session.getEffectiveUser().getEmail(),
      subject: `[跟Gunny学韩语] ${data.student} 제출 — ${data.quiz}`,
      htmlBody: html,
      inlineImages: inline,
    });
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'gunny-quiz' });
}

function folder_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function esc_(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
