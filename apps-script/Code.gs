/**
 * 跟Gunny学韩语 — quiz submission receiver + AI grading.
 * - Saves each handwritten answer (PNG) to Google Drive
 * - Grades it with Gemini against ANSWER_KEYS (defined in Answers.gs, which is NOT in the public repo)
 * - Emails a grading sheet to the script owner (grading.json is also saved in the Drive folder)
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

    mail_(data, stamp, blobs, grading, gradeError, folder.getUrl());
    const res = { ok: true, graded: !!grading, gradeError: gradeError || undefined };
    if (/^TEST/.test(data.student)) res.grading = grading;   // test submissions only: echo results for checking
    return json_(res);
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

  // Pass 1 — transcribe the handwriting WITHOUT showing the answers, so the model can't "fix" spelling toward them.
  const tParts = [{ text: READER_PROMPT }];
  data.answers.forEach((a) => {
    if (a.blank) return;
    tParts.push({ text: `\n### Image ${a.n}` });
    tParts.push({ inline_data: { mime_type: 'image/png', data: a.png } });
  });
  const read = {};
  if (tParts.length > 1) {
    const t = callGemini_(apiKey, {
      contents: [{ role: 'user', parts: tParts }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: {
        type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
          n: { type: 'INTEGER' }, jamo: { type: 'STRING' }, read: { type: 'STRING' } }, required: ['n', 'jamo', 'read'] } } }, required: ['items'] } },
    });
    JSON.parse(t.text).items.forEach((it) => { read[it.n] = it.read; });
  }

  // Pass 2 — grade the transcriptions (text only) against the reference answers.
  let list = '';
  data.answers.forEach((a) => {
    const k = key[a.n] || {};
    list += `\n### Question ${a.n} (${a.type})\nPrompt (Chinese): ${a.prompt}\nHint/grammar: ${a.hint}\n` +
      `Reference answer: ${k.answer || '(none)'}\n` +
      `Student wrote: ${a.blank ? 'BLANK' : JSON.stringify(read[a.n] || '(无法辨认)')}\n`;
  });
  const body = {
    contents: [{ role: 'user', parts: [{ text: GRADER_PROMPT + '\n' + list }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          results: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
            n: { type: 'INTEGER' },
            score: { type: 'NUMBER', description: '1, 0.5 or 0' },
            feedback_zh: { type: 'STRING', description: 'Short feedback for the student in Simplified Chinese' },
            note_ko: { type: 'STRING', description: 'Short note for the teacher in Korean' },
          }, required: ['n', 'score', 'feedback_zh', 'note_ko'] } },
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
    r.read = blank[r.n] ? '' : (read[r.n] || '(无法辨认)');
    r.score = blank[r.n] ? 0 : Math.max(0, Math.min(1, Math.round((Number(r.score) || 0) * 2) / 2));
  });
  g.total = g.results.reduce((s, r) => s + r.score, 0);
  g.max = data.answers.length;
  g.model = model;
  return g;
}

const READER_PROMPT = `You are an OCR engine for handwritten Korean written by a Chinese learner with a stylus.
For each image, transcribe EXACTLY what is written, as a strict copyist. The student may have made spelling mistakes; your job is to record them, not fix them.
Method — for every syllable block, look at the strokes and decompose it into jamo FIRST, then compose:
- "jamo": the decomposition, syllables separated by spaces, e.g. "ㅎㅏㄱ ㅅㅐㅇ" for 학생.
- Vowel check: ㅐ has its short horizontal tick pointing RIGHT (between the two vertical lines); ㅔ has the tick pointing LEFT (outside, before the first vertical). ㅒ/ㅖ likewise. Look at every vowel, do not infer it from the word.
- "read": the syllables composed from your jamo, with spaces and punctuation as written.
- Do NOT correct spelling, spacing, grammar or conjugation, and do not guess the intended word. Non-words are expected.
- Ignore the pink guide lines. If one syllable is unreadable use "?"; if the whole image is illegible return "(无法辨认)".
Return one item per image number.`;

const GRADER_PROMPT = `You are grading a handwritten Korean quiz for a Chinese-speaking learner (beginner–intermediate, textbook unit on holidays/vacation).
Each question has a Chinese prompt, a reference answer, and "Student wrote": an exact transcription of the student's handwriting.
Treat the transcription as exactly what the student wrote — do not assume OCR errors and do not fix anything.

For every question:
1. "score":
   - vocab questions: 1 if the word is spelled exactly right (ignore handwriting style); 0 otherwise. No partial credit.
   - grammar questions: 1 if the sentence is natural, means the same as the Chinese, uses the required grammar pattern correctly, and has no spelling errors.
     0.5 if the required grammar is used correctly but there is a minor mistake (one spelling error, wrong particle, small vocabulary slip, missing word).
     0 if the required grammar is missing/wrong or the meaning is different.
     Accept valid alternatives to the reference answer (different but correct word choice, 해요체 or 합니다체, omitted subject, etc.).
   - BLANK answers get 0.
2. "feedback_zh": 1 short sentence in Simplified Chinese for the student. If wrong, show the correct form in Korean. Friendly tone.
3. "note_ko": 1 short note in Korean for the teacher (what the error was, or "정답").
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

function mail_(data, stamp, blobs, g, gradeError, url) {
  const byN = {};
  if (g) g.results.forEach((r) => { byN[r.n] = r; });
  const mark = (s) => s === 1 ? '⭕' : s === 0.5 ? '🔺' : '❌';
  let rows = '';
  data.answers.forEach((a) => {
    const r = byN[a.n];
    const w = a.type === 'vocab' ? 300 : 420;
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
