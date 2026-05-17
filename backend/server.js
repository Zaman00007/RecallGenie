const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const UPLOADS_DIR = path.join(__dirname, '../uploads');
const PYTHON_PIPELINE = path.join(__dirname, '../python-pipeline/process_pdf.py');
[UPLOADS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Logger ───────────────────────────────────────────────────────────────────
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT_LEVEL = LOG_LEVELS.DEBUG; // Set to INFO in production

function log(level, section, msg, data = null) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
  const icons = { DEBUG: '🔍', INFO: '✅', WARN: '⚠️ ', ERROR: '❌' };
  const time = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
  const prefix = `[${time}] ${icons[level]} [${section}]`;
  if (data !== null) {
    console.log(`${prefix} ${msg}`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

// ── Session store with TTL cleanup ───────────────────────────────────────────
const sessions = {};

// Clean up sessions older than 1 hour every 15 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let cleaned = 0;
  for (const [id, s] of Object.entries(sessions)) {
    if (new Date(s.createdAt).getTime() < cutoff) {
      delete sessions[id];
      cleaned++;
    }
  }
  if (cleaned > 0) log('INFO', 'CLEANUP', `Purged ${cleaned} expired session(s). Active: ${Object.keys(sessions).length}`);
}, 15 * 60 * 1000);

// ── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

// ── Gemini API ────────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, chunkIndex = '?') {
  const section = `GEMINI[chunk-${chunkIndex}]`;

  // if (!apiKey) throw new Error('No Gemini API key provided.');
  const effectiveApiKey = apiKey || process.env.GEMINI_API_KEY;

  if (!effectiveApiKey) {
    throw new Error('No Gemini API key provided (request or .env)');
  }

  log('DEBUG', section, `API key prefix: ${apiKey.substring(0, 8)}...`);
  log('DEBUG', section, `Prompt length: ${prompt.length} chars / ~${Math.ceil(prompt.length / 4)} tokens`);

  // const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${effectiveApiKey}`;


  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      })
    });
  } catch (networkErr) {
    log('ERROR', section, `Network error reaching Gemini: ${networkErr.message}`);
    throw new Error(`Network error: ${networkErr.message}`);
  }

  log('INFO', section, `HTTP status: ${res.status} ${res.statusText}`);

  // Always read as text first — parsing may fail on error responses
  const rawText = await res.text();
  log('DEBUG', section, `Raw response (first 600 chars):\n${rawText.substring(0, 600)}`);

  if (!res.ok) {
    let errMsg = `Gemini API error ${res.status}`;
    try {
      const parsed = JSON.parse(rawText);
      const detail = parsed?.error?.message || parsed?.error?.status || '';
      errMsg = `Gemini ${res.status}: ${detail || rawText.slice(0, 200)}`;
      log('ERROR', section, `API error detail:`, parsed?.error || rawText.slice(0, 300));
    } catch (_) {
      log('ERROR', section, `Non-JSON error body: ${rawText.slice(0, 300)}`);
    }
    throw new Error(errMsg);
  }

  // Parse the outer response envelope
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    log('ERROR', section, `Failed to parse response JSON: ${e.message}`);
    log('ERROR', section, `Raw text was: ${rawText.slice(0, 400)}`);
    throw new Error(`Response JSON parse error: ${e.message}`);
  }

  // Inspect candidates
  const candidates = data?.candidates;
  log('DEBUG', section, `Candidates count: ${candidates?.length ?? 0}`);

  if (!candidates || candidates.length === 0) {
    const blockReason = data?.promptFeedback?.blockReason;
    if (blockReason) {
      log('ERROR', section, `Prompt was BLOCKED by Gemini. Reason: ${blockReason}`);
      log('ERROR', section, `Safety ratings:`, data?.promptFeedback?.safetyRatings);
      throw new Error(`Prompt blocked by Gemini safety filter: ${blockReason}`);
    }
    log('ERROR', section, `No candidates in response. Full data:`, data);
    throw new Error('Gemini returned no candidates');
  }

  const candidate = candidates[0];
  const finishReason = candidate?.finishReason;
  log('DEBUG', section, `Finish reason: ${finishReason}`);

  if (finishReason === 'SAFETY') {
    log('ERROR', section, `Response blocked due to SAFETY. Ratings:`, candidate?.safetyRatings);
    throw new Error('Gemini blocked this response due to safety filters');
  }

  if (finishReason === 'MAX_TOKENS') {
    log('WARN', section, `Response was cut off (MAX_TOKENS). JSON may be incomplete — will attempt parse anyway.`);
  }

  if (finishReason === 'RECITATION') {
    log('WARN', section, `Response stopped due to RECITATION (copyright concern).`);
  }

  const parts = candidate?.content?.parts;
  log('DEBUG', section, `Parts count: ${parts?.length ?? 0}`);

  const text = parts?.[0]?.text || '';

  if (!text) {
    log('ERROR', section, `Empty text in response. Full candidate:`, candidate);
    throw new Error('Gemini returned empty text content');
  }

  log('INFO', section, `Response text length: ${text.length} chars`);
  log('DEBUG', section, `Response text (first 400):\n${text.substring(0, 400)}`);

  return text;
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(chunk, numQ, topic) {
  return `You are an expert quiz maker for competitive exams.

Read the following text and generate exactly ${numQ} multiple-choice questions (MCQs) based ONLY on information in the text.

TOPIC CATEGORY: ${topic}

TEXT:
"""
${chunk}
"""

RULES:
1. Each question has exactly 4 options: a, b, c, d.
2. Exactly one option is correct.
3. Questions must be specific and clearly answerable from the text.
4. Write a brief explanation (1-2 sentences) citing the text.
5. Vary question types: factual, comparison, cause-effect, numerical, definition.
6. Do NOT ask trivial or yes/no questions.

Respond ONLY with a valid JSON array. No markdown, no extra text.

[
  {
    "question": "...",
    "options": { "a": "...", "b": "...", "c": "...", "d": "..." },
    "correct": "b",
    "explanation": "..."
  }
]`;
}

// ── Python pipeline ───────────────────────────────────────────────────────────
function runPipeline(pdfPath) {
  return new Promise((resolve, reject) => {
    log('INFO', 'PIPELINE', `Spawning Python: ${PYTHON_PIPELINE}`);
    log('INFO', 'PIPELINE', `PDF path: ${pdfPath}`);

    const proc = spawn('python3', [PYTHON_PIPELINE, pdfPath, '--chunk-size', '2800']);
    let out = '', err = '';

    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => {
      err += d;
      // Stream Python stderr live so you can see progress/errors immediately
      process.stderr.write(`[PYTHON] ${d}`);
    });

    proc.on('close', code => {
      log('INFO', 'PIPELINE', `Python exited with code: ${code}`);
      if (code !== 0) {
        log('ERROR', 'PIPELINE', `Python stderr:\n${err.slice(0, 1000)}`);
        return reject(new Error(`Python pipeline failed (exit ${code}): ${err.slice(0, 300)}`));
      }
      log('DEBUG', 'PIPELINE', `Python stdout (first 500):\n${out.slice(0, 500)}`);
      try {
        const parsed = JSON.parse(out);
        log('INFO', 'PIPELINE', `Pipeline result status: ${parsed.status}`);
        resolve(parsed);
      } catch (e) {
        log('ERROR', 'PIPELINE', `Failed to parse pipeline JSON output: ${e.message}`);
        log('ERROR', 'PIPELINE', `Raw stdout (first 400): ${out.slice(0, 400)}`);
        reject(new Error(`Pipeline output parse error: ${e.message}`));
      }
    });

    proc.on('error', spawnErr => {
      log('ERROR', 'PIPELINE', `Failed to spawn python3: ${spawnErr.message}`);
      reject(spawnErr);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main generation worker ────────────────────────────────────────────────────
async function generateQuiz(sessionId, pdfPath, numQuestions, apiKey) {
  const s = sessions[sessionId];
  const section = `QUIZ[${sessionId.substring(0, 8)}]`;

  try {
    s.status = 'processing';
    s.progress = { step: 'Extracting & optimising PDF...', pct: 10 };
    log('INFO', section, `Starting quiz generation. numQuestions=${numQuestions}`);

    // ── Step 1: Run Python pipeline ──────────────────────────────────────────
    const result = await runPipeline(pdfPath);

    if (result.status === 'error') {
      log('ERROR', section, `Pipeline returned error: ${result.message}`);
      throw new Error(result.message);
    }

    log('INFO', section, `Pipeline success. Pages=${result.total_pages}, Chunks=${result.total_chunks}, Topics=${result.topics_detected}`);
    log('DEBUG', section, `File size: ${result.file_size_mb} MB`);

    s.meta = {
      filename: result.file,
      pages: result.total_pages,
      chunks: result.total_chunks,
      topics: result.topics_detected,
      fileSizeMb: result.file_size_mb,
      pdfMeta: result.metadata
    };
    s.progress = { step: `✅ PDF parsed: ${result.total_chunks} chunks · ${result.topics_detected?.join(', ')}`, pct: 25 };

    // ── Step 2: Filter chunks ────────────────────────────────────────────────
    const allChunks = result.chunks || [];
    log('INFO', section, `Total chunks from pipeline: ${allChunks.length}`);

    // Log char_count distribution to help debug filtering
    const charCounts = allChunks.map(c => c.char_count);
    log('DEBUG', section, `Chunk char_count distribution: min=${Math.min(...charCounts)}, max=${Math.max(...charCounts)}, avg=${Math.round(charCounts.reduce((a,b)=>a+b,0)/charCounts.length)}`);

    const chunks = allChunks.filter(c => c.char_count > 150);
    log('INFO', section, `Chunks after char_count>150 filter: ${chunks.length} (dropped ${allChunks.length - chunks.length})`);

    if (chunks.length === 0) {
      throw new Error(`No readable text found in PDF. All ${allChunks.length} chunks had char_count ≤ 150.`);
    }

    // ── Step 3: Plan distribution ────────────────────────────────────────────
    const totalQ = Math.min(numQuestions, 100);
    const perChunk = Math.max(1, Math.min(5, Math.ceil(totalQ / Math.min(chunks.length, 20))));
    const chunksNeeded = Math.ceil(totalQ / perChunk);
    const selected = chunks.slice(0, chunksNeeded);

    log('INFO', section, `Plan: totalQ=${totalQ}, perChunk=${perChunk}, chunksNeeded=${chunksNeeded}, selected=${selected.length}`);

    // ── Step 4: Call Gemini per chunk ────────────────────────────────────────
    const allQ = [];

    for (let i = 0; i < selected.length; i++) {
      const chunk = selected[i];
      const want = Math.min(perChunk, totalQ - allQ.length);
      if (want <= 0) {
        log('INFO', section, `Reached question target at chunk ${i}. Stopping.`);
        break;
      }

      const pct = 25 + Math.round(((i + 1) / selected.length) * 68);
      s.progress = { step: `🤖 Gemini: chunk ${i + 1}/${selected.length} [${chunk.topic}]...`, pct };

      log('INFO', section, `--- Chunk ${i + 1}/${selected.length} | topic="${chunk.topic}" | chars=${chunk.char_count} | want=${want} questions ---`);
      log('DEBUG', section, `Chunk text preview (first 200):\n${chunk.text?.substring(0, 200)}`);

      try {
        const raw = await callGemini(buildPrompt(chunk.text, want, chunk.topic), apiKey, i + 1);

        // Strip markdown fences if Gemini added them despite instructions
        const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

        if (cleaned !== raw) {
          log('WARN', section, `Chunk ${i+1}: Gemini added markdown fences despite instructions — stripped them.`);
        }

        log('DEBUG', section, `Cleaned response (first 400):\n${cleaned.substring(0, 400)}`);

        let parsed;
        try {
          parsed = JSON.parse(cleaned);
        } catch (jsonErr) {
          log('ERROR', section, `Chunk ${i+1}: JSON.parse failed — ${jsonErr.message}`);
          log('ERROR', section, `Content that failed to parse:\n${cleaned.substring(0, 600)}`);
          continue; // skip this chunk, don't crash the whole run
        }

        if (!Array.isArray(parsed)) {
          log('WARN', section, `Chunk ${i+1}: Parsed result is not an array. Type=${typeof parsed}. Value:`, parsed);
          continue;
        }

        log('INFO', section, `Chunk ${i+1}: Parsed ${parsed.length} question(s) from Gemini.`);

        let accepted = 0, rejected = 0;
        for (const q of parsed) {
          const hasQ = typeof q.question === 'string' && q.question.trim().length > 0;
          const hasOpts = q.options && typeof q.options === 'object'
            && q.options.a && q.options.b && q.options.c && q.options.d;
          const hasCorrect = typeof q.correct === 'string' && ['a','b','c','d'].includes(q.correct.toLowerCase().trim());

          if (hasQ && hasOpts && hasCorrect) {
            allQ.push({
              id: uuidv4(),
              subject: chunk.topic,
              question: q.question,
              options: {
                a: q.options.a || '',
                b: q.options.b || '',
                c: q.options.c || '',
                d: q.options.d || ''
              },
              correct: q.correct.toLowerCase().trim(),
              explanation: q.explanation || ''
            });
            accepted++;
          } else {
            log('WARN', section, `Chunk ${i+1}: Rejected malformed question. hasQ=${hasQ}, hasOpts=${hasOpts}, hasCorrect=${hasCorrect}`);
            log('DEBUG', section, `Rejected question:`, q);
            rejected++;
          }
        }

        log('INFO', section, `Chunk ${i+1}: accepted=${accepted}, rejected=${rejected}. Running total: ${allQ.length}`);

      } catch (e) {
        log('ERROR', section, `Chunk ${i+1} failed: ${e.message}`);
        // Continue to next chunk instead of aborting everything
      }

      // Rate limit: 1.5s between Gemini calls (free tier = 15 RPM)
      if (i < selected.length - 1) {
        log('DEBUG', section, `Sleeping 1500ms (rate limit)...`);
        await sleep(1500);
      }
    }

    // ── Step 5: Final result ─────────────────────────────────────────────────
    log('INFO', section, `Generation complete. Total valid questions: ${allQ.length}`);

    if (allQ.length === 0) {
      log('ERROR', section, `Zero questions generated. Check logs above for Gemini errors or chunk issues.`);
      throw new Error(
        `Gemini generated no valid questions. ` +
        `Chunks processed: ${selected.length}. ` +
        `Check server logs for Gemini errors, safety blocks, or JSON parse failures.`
      );
    }

    s.questions = allQ;
    s.status = 'done';
    s.progress = { step: `🎉 Done! ${allQ.length} questions generated.`, pct: 100 };

  } catch (e) {
    log('ERROR', section, `Fatal error in generateQuiz: ${e.message}`);
    s.status = 'error';
    s.error = e.message;
    s.progress = { step: 'Error occurred', pct: 0 };
  } finally {
    // Always clean up the uploaded PDF
    try { fs.unlinkSync(pdfPath); log('DEBUG', section, `Deleted temp PDF: ${pdfPath}`); }
    catch (_) {}
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/upload', upload.single('pdf'), (req, res) => {
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };

  if (!req.file) {
    log('WARN', 'UPLOAD', 'Request received with no PDF file');
    return res.status(400).json({ error: 'No PDF uploaded' });
  }

  log('INFO', 'UPLOAD', `Received: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

  const apiKey = req.headers['x-gemini-key'] || req.body.apiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    log('ERROR', 'UPLOAD', 'No Gemini API key provided');
    cleanup();
    return res.status(400).json({ error: 'Gemini API key required. Pass via X-Gemini-Key header.' });
  }
  log('DEBUG', 'UPLOAD', `API key received (prefix): ${apiKey.substring(0, 8)}...`);

  const numQ = Math.min(parseInt(req.body.numQuestions) || 20, 100);
  log('INFO', 'UPLOAD', `numQuestions requested: ${numQ}`);

  const sid = uuidv4();
  sessions[sid] = {
    id: sid,
    status: 'queued',
    filename: req.file.originalname,
    progress: { step: 'Queued...', pct: 0 },
    questions: [],
    meta: null,
    error: null,
    createdAt: new Date().toISOString()
  };

  log('INFO', 'UPLOAD', `Session created: ${sid}`);

  generateQuiz(sid, req.file.path, numQ, apiKey)
    .catch(e => {
      log('ERROR', 'UPLOAD', `Unhandled error in generateQuiz for session ${sid}: ${e.message}`);
      if (sessions[sid]) {
        sessions[sid].status = 'error';
        sessions[sid].error = e.message;
      }
    });

  res.json({ sessionId: sid });
});

app.get('/api/session/:id/status', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: s.id,
    status: s.status,
    progress: s.progress,
    filename: s.filename,
    meta: s.meta,
    error: s.error,
    questionCount: s.questions?.length || 0
  });
});

app.get('/api/session/:id/questions', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'done') return res.status(400).json({ error: 'Not ready yet', status: s.status });
  res.json({ questions: s.questions, meta: s.meta });
});

app.post('/api/session/:id/questions', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const q = { id: uuidv4(), ...req.body };
  s.questions.push(q);
  res.status(201).json(q);
});

app.put('/api/session/:id/questions/:qid', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  const i = s.questions.findIndex(q => q.id === req.params.qid);
  if (i === -1) return res.status(404).json({ error: 'Question not found' });
  s.questions[i] = { ...s.questions[i], ...req.body };
  res.json(s.questions[i]);
});

app.delete('/api/session/:id/questions/:qid', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  s.questions = s.questions.filter(q => q.id !== req.params.qid);
  res.json({ message: 'Deleted' });
});

// Explicit session delete
app.delete('/api/session/:id', (req, res) => {
  if (!sessions[req.params.id]) return res.status(404).json({ error: 'Session not found' });
  delete sessions[req.params.id];
  log('INFO', 'SESSION', `Session ${req.params.id} manually deleted`);
  res.json({ message: 'Session deleted' });
});

// ── Debug route: test Gemini API key directly ─────────────────────────────────
app.post('/api/debug/test-gemini', express.json(), async (req, res) => {
  const apiKey = req.headers['x-gemini-key'] || req.body.apiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) return res.status(400).json({ error: 'No API key provided' });

  log('INFO', 'DEBUG', `Testing Gemini API key: ${apiKey.substring(0, 8)}...`);

  try {
    const text = await callGemini(
      'Generate exactly 1 MCQ about photosynthesis as a JSON array:\n[{"question":"...","options":{"a":"...","b":"...","c":"...","d":"..."},"correct":"a","explanation":"..."}]',
      apiKey,
      'test'
    );
    const cleaned = text.replace(/```json|```/gi, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch (_) {}
    res.json({ success: true, raw: text.substring(0, 500), parsed });
  } catch (e) {
    log('ERROR', 'DEBUG', `Gemini test failed: ${e.message}`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Debug route: inspect a session in detail ──────────────────────────────────
app.get('/api/debug/session/:id', (req, res) => {
  const s = sessions[req.params.id];
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    ...s,
    // Show first question in full for inspection
    questionSample: s.questions?.[0] || null,
    questionCount: s.questions?.length || 0
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: Object.keys(sessions).length,
    pythonPipeline: fs.existsSync(PYTHON_PIPELINE),
    pythonPipelinePath: PYTHON_PIPELINE,
    uploadsDir: UPLOADS_DIR,
    nodeVersion: process.version,
    uptime: `${Math.floor(process.uptime())}s`
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🚀 QuizForge Backend → http://localhost:${PORT}`);
  console.log(`   Python pipeline : ${fs.existsSync(PYTHON_PIPELINE) ? '✅ found' : '❌ NOT found at ' + PYTHON_PIPELINE}`);
  console.log(`   Uploads dir     : ${UPLOADS_DIR}`);
  console.log(`   Log level       : DEBUG (all logs enabled)`);
  console.log(`\n📋 Debug routes:`);
  console.log(`   POST /api/debug/test-gemini   — test your API key directly`);
  console.log(`   GET  /api/debug/session/:id   — inspect any session in detail`);
  console.log(`   GET  /api/health              — server health\n`);
});