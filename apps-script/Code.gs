/**
 * 跟Gunny学韩语 — quiz submission receiver + AI grading.
 * - Saves each handwritten answer (PNG) to Google Drive
 * - Grades it with Gemini against ANSWER_KEYS (defined in Answers.gs, which is NOT in the public repo)
 * - Logs the score to a Google Sheet and emails a grading sheet to the script owner
 *
 * Setup:
 *   1. GEMINI_API_KEY in Script properties, or SECRET_GEMINI_API_KEY in a private Secrets.gs
 *      (free key from https://aistudio.google.com/apikey)
 *      Optional: GEMINI_MODEL to try first (otherwise MODELS below)
 *   2. Add a second file "Answers.gs" with the answer keys.
 *   3. Run setup() once from the editor to authorize and check the Gemini key.
 *   4. Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy (keeps the same URL).
 */
const ROOT_FOLDER = '跟Gunny学韩语 제출';
const SHEET_NAME = '跟Gunny学韩语 成绩记录';
const TIMEZONE = 'Pacific/Auckland';
// tried in order; overloaded (429/5xx) or retired (404) models fall through to the next
const MODELS = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.5-flash'];

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const stamp = Utilities.formatDate(new Date(data.submittedAt), TIMEZONE, 'yyyy-MM-dd HH:mm');
    const root = folder_(ROOT_FOLDER);
    const folder = root.createFolder(`${stamp} · ${data.student} · ${data.quiz}`);

    const blobs = {};
    data.answers.forEach((a) => {
      if (a.blank) return;
      const blob = Utilities.newBlob(Utilities.base64Decode(a.png), 'image/png', `Q${String(a.n).padStart(2, '0')}.png`);
      folder.createFile(blob);
      blobs[a.n] = blob;
    });

    let grading = null, gradeError = '';
    try {
      grading = grade_(data);
      folder.createFile('grading.json', JSON.stringify(grading, null, 2), MimeType.PLAIN_TEXT);
    } catch (err) {
      gradeError = String(err);
    }

    log_(root, stamp, data, grading, folder.getUrl());
    mail_(data, stamp, blobs, grading, gradeError, folder.getUrl());
    return json_({ ok: true, graded: !!grading, gradeError: gradeError || undefined });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() {
  return json_({ ok: true, service: 'gunny-quiz' });
}

/* ---------------- grading ---------------- */

function grade_(data) {
  const key = (typeof ANSWER_KEYS !== 'undefined') && ANSWER_KEYS[data.quizId];
  if (!key) throw new Error(`No answer key for quizId "${data.quizId}" (check Answers.gs)`);
  const apiKey = geminiKey_();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set in Script properties');

  const parts = [{ text: GRADER_PROMPT }];
  data.answers.forEach((a) => {
    const k = key[a.n] || {};
    parts.push({ text:
      `\n### Question ${a.n} (${a.type})\nPrompt (Chinese): ${a.prompt}\nHint/grammar: ${a.hint}\n` +
      `Reference answer: ${k.answer || '(none)'}\n` +
      (a.blank ? 'Student answer: BLANK (no image)' : 'Student answer image:') });
    if (!a.blank) parts.push({ inline_data: { mime_type: 'image/png', data: a.png } });
  });

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          results: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
            n: { type: 'INTEGER' },
            read: { type: 'STRING', description: 'Exact transcription of the handwriting, including mistakes' },
            score: { type: 'NUMBER', description: '1, 0.5 or 0' },
            feedback_zh: { type: 'STRING', description: 'Short feedback for the student in Simplified Chinese' },
            note_ko: { type: 'STRING', description: 'Short note for the teacher in Korean' },
          }, required: ['n', 'read', 'score', 'feedback_zh', 'note_ko'] } },
          summary_zh: { type: 'STRING', description: 'Encouraging 2–3 sentence overall comment for the student in Simplified Chinese' },
          summary_ko: { type: 'STRING', description: 'Overall weak points for the teacher in Korean' },
        },
        required: ['results', 'summary_zh', 'summary_ko'],
      },
    },
  };

  const { text, model } = callGemini_(apiKey, body);
  const g = JSON.parse(text);

  // trust nothing about blanks or score range from the model
  const blank = {};
  data.answers.forEach((a) => { blank[a.n] = a.blank; });
  g.results.forEach((r) => {
    r.score = blank[r.n] ? 0 : Math.max(0, Math.min(1, Math.round((Number(r.score) || 0) * 2) / 2));
    if (blank[r.n]) { r.read = ''; }
  });
  g.total = g.results.reduce((s, r) => s + r.score, 0);
  g.max = data.answers.length;
  g.model = model;
  return g;
}

const GRADER_PROMPT = `You are grading a handwritten Korean quiz for a Chinese-speaking learner (beginner–intermediate, textbook unit on holidays/vacation).
Each question has a Chinese prompt, a reference answer, and an image of the student's handwriting (written with a stylus).

For every question:
1. "read": transcribe EXACTLY what the student wrote in Hangul, keeping spelling mistakes. Do not correct it. If illegible, write "(无法辨认)".
2. "score":
   - vocab questions: 1 if the word is spelled exactly right (ignore handwriting style); 0 otherwise. No partial credit.
   - grammar questions: 1 if the sentence is natural, means the same as the Chinese, uses the required grammar pattern correctly, and has no spelling errors.
     0.5 if the required grammar is used correctly but there is a minor mistake (one spelling error, wrong particle, small vocabulary slip, missing word).
     0 if the required grammar is missing/wrong or the meaning is different.
     Accept valid alternatives to the reference answer (different but correct word choice, 해요체 or 합니다체, omitted subject, etc.).
   - BLANK answers get 0.
3. "feedback_zh": 1 short sentence in Simplified Chinese for the student. If wrong, show the correct form in Korean. Friendly tone.
4. "note_ko": 1 short note in Korean for the teacher (what the error was, or "정답").
Return results for every question number, in order.`;

function callGemini_(apiKey, body) {
  const first = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  const models = (first ? [first] : []).concat(MODELS.filter((m) => m !== first));
  const errors = [];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
        payload: JSON.stringify(body), muteHttpExceptions: true });
      const code = res.getResponseCode();
      if (code === 200) {
        const out = JSON.parse(res.getContentText());
        const text = out.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
        return { text, model };
      }
      errors.push(`${model} ${code}`);
      if (code === 404 || code === 400) break;          // model gone / bad request: next model
      if (code === 401 || code === 403) throw new Error(`Gemini key rejected (${code})`);
      Utilities.sleep(3000);                             // 429 / 5xx: wait, retry once, then next model
    }
  }
  throw new Error('All Gemini models failed: ' + errors.join(', '));
}

/* ---------------- outputs ---------------- */

function log_(root, stamp, data, g, url) {
  const it = root.getFilesByName(SHEET_NAME);
  let ss;
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(SHEET_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(root);
    ss.getSheets()[0].appendRow(['提交时间', '学生', '测验', '得分', '满分', '用时(分)', '作答', 'Drive']);
  }
  const done = data.answers.filter((a) => !a.blank).length;
  ss.getSheets()[0].appendRow([stamp, data.student, data.quiz, g ? g.total : '채점 실패', data.answers.length,
    Math.round(data.seconds / 6) / 10, `${done}/${data.answers.length}`, url]);
}

function mail_(data, stamp, blobs, g, gradeError, url) {
  const byN = {};
  if (g) g.results.forEach((r) => { byN[r.n] = r; });
  const mark = (s) => s === 1 ? '⭕' : s === 0.5 ? '🔺' : '❌';
  let rows = '';
  data.answers.forEach((a) => {
    const r = byN[a.n];
    const w = a.type === 'vocab' ? 200 : 420;
    const img = a.blank ? '<span style="color:#c2410c">（未作答）</span>'
      : `<img src="cid:q${a.n}" width="${w}" style="border:1px solid #f0dde3;border-radius:6px">`;
    const verdict = r ? `<div style="font-size:18px">${mark(r.score)} <b>${r.score}</b></div>
        <div style="margin-top:4px">인식: <b>${esc_(r.read)}</b></div>
        <div style="color:#b0305f;margin-top:2px">${esc_(r.note_ko)}</div>
        <div style="color:#666;margin-top:2px">${esc_(r.feedback_zh)}</div>` : '';
    rows += `<tr>
      <td style="padding:10px;vertical-align:top;font-weight:700;color:#d6457a">${a.n}</td>
      <td style="padding:10px;vertical-align:top">${esc_(a.prompt)}<br><small style="color:#888">${esc_(a.hint)}</small>
        <div style="margin-top:8px">${img}</div></td>
      <td style="padding:10px;vertical-align:top;min-width:200px">${verdict}</td></tr>`;
  });

  const mins = Math.floor(data.seconds / 60), secs = data.seconds % 60;
  const done = data.answers.filter((a) => !a.blank).length;
  const scoreLine = g
    ? `<div style="font-size:30px;font-weight:800;color:#d6457a">${g.total} / ${g.max}</div>
       <p style="margin:6px 0"><b>총평 (선생님용)</b> ${esc_(g.summary_ko)}</p>
       <p style="margin:6px 0;color:#555"><b>给学生</b> ${esc_(g.summary_zh)}</p>
       <p style="color:#999;font-size:12px">AI 채점(${esc_(g.model)}) — 틀린 인식이 있을 수 있으니 이미지를 함께 확인하세요.</p>`
    : `<p style="color:#c2410c"><b>자동 채점 실패:</b> ${esc_(gradeError)}</p>`;
  const html = `<div style="font-family:-apple-system,sans-serif;max-width:760px">
    <h2 style="margin:0">${esc_(data.student)} · ${esc_(data.quiz)}</h2>
    <p style="color:#666">提交 ${stamp} · 用时 ${mins}分${secs}秒 · 作答 ${done}/${data.answers.length} · <a href="${url}">Drive 폴더</a></p>
    ${scoreLine}
    <table style="border-collapse:collapse;width:100%" border="1" bordercolor="#f0dde3">${rows}</table></div>`;

  const inline = {};
  Object.keys(blobs).forEach((n) => { inline['q' + n] = blobs[n]; });
  MailApp.sendEmail({
    to: Session.getEffectiveUser().getEmail(),
    subject: `[跟Gunny学韩语] ${data.student} ${g ? `${g.total}/${g.max}점` : '제출'} — ${data.quiz}`,
    htmlBody: html,
    inlineImages: inline,
  });
}

/* ---------------- helpers ---------------- */

/** Key from Script properties, or from the private Secrets.gs pushed by clasp (never in the public repo). */
function geminiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') ||
    ((typeof SECRET_GEMINI_API_KEY !== 'undefined' && SECRET_GEMINI_API_KEY) || '');
}

/** Run once from the editor: authorizes Drive/Gmail/Sheets/UrlFetch and checks the Gemini key. */
function setup() {
  folder_(ROOT_FOLDER);
  const apiKey = geminiKey_();
  if (!apiKey) throw new Error('GEMINI_API_KEY가 없습니다 (Script properties 또는 Secrets.gs).');
  if (typeof ANSWER_KEYS === 'undefined') throw new Error('Answers.gs 파일을 추가하세요.');
  const r = callGemini_(apiKey, { contents: [{ parts: [{ text: 'Reply with: OK' }] }] });
  Logger.log(`Gemini (${r.model}) → ${r.text}`);
  Logger.log(`Answer keys loaded: ${Object.keys(ANSWER_KEYS).join(', ')}`);
  Logger.log(`Mail quota left today: ${MailApp.getRemainingDailyQuota()}`);
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
