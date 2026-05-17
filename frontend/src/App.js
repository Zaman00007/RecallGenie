import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';

// const API = 'http://localhost:4000/api';
const API = 'https://recallgenie.onrender.com/api';

function useInterval(cb, delay) {
  const saved = useRef(cb);
  useEffect(() => { saved.current = cb; }, [cb]);
  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}

function Toast({ toasts }) {
  return (
    <div className="toast-stack">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

function UploadPage({ onSessionStart }) {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [numQ, setNumQ] = useState(30);
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_key') || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef();

  const handleFile = f => {
    if (f && f.type === 'application/pdf') { setFile(f); setError(''); }
    else setError('Please upload a PDF file.');
  };

  const onDrop = e => {
    e.preventDefault(); setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file) return setError('Please select a PDF.');
    // if (!apiKey.trim()) return setError('Enter your Gemini API key.');
    setLoading(true); setError('');
    localStorage.setItem('gemini_key', apiKey.trim());
    const form = new FormData();
    form.append('pdf', file);
    form.append('numQuestions', numQ);
    form.append('topicFilter', 'All');
    try {
      const res = await axios.post(`${API}/upload`, form, {
        headers: { 'X-Gemini-Key': apiKey.trim() }
      });
      onSessionStart(res.data.sessionId, file.name);
    } catch (e) {
      setError(e.response?.data?.error || 'Upload failed. Is the backend running on port 4000?');
    }
    setLoading(false);
  };

  return (
    <div className="upload-page">
      <div className="hero">
        <div className="hero-badge">⚡ Powered by Gemini 2.0 Flash</div>
        <h1 className="hero-title">Turn any <span className="accent">PDF</span> into a quiz</h1>
        <p className="hero-sub">Upload a document. Python extracts & optimises the text. Gemini AI generates smart MCQs. You play.</p>
      </div>

      <div className="upload-card">
        <div
          className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current.click()}
        >
          <input ref={inputRef} type="file" accept=".pdf" hidden onChange={e => handleFile(e.target.files[0])} />
          {file ? (
            <div className="file-selected">
              <span className="file-icon">📄</span>
              <div>
                <div className="file-name">{file.name}</div>
                <div className="file-size">{(file.size / 1024 / 1024).toFixed(2)} MB · PDF</div>
              </div>
              <button className="remove-btn" onClick={e => { e.stopPropagation(); setFile(null); }}>✕</button>
            </div>
          ) : (
            <div className="drop-content">
              <div className="drop-icon">⬆</div>
              <div className="drop-text">Drop PDF here or <span>click to browse</span></div>
              <div className="drop-sub">Max 50MB · PDF only</div>
            </div>
          )}
        </div>

        <div className="config-row">
          <div className="config-group">
            <label className="config-label">Questions to generate</label>
            <div className="slider-wrap">
              <input type="range" min={5} max={80} value={numQ} onChange={e => setNumQ(+e.target.value)} className="slider" />
              <span className="slider-val">{numQ}</span>
            </div>
          </div>
        </div>

        <div className="config-group api-group">
          <label className="config-label">
            Gemini API Key
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="get-key-link">Get free key →</a>
          </label>
          <input type="password" className="api-input" placeholder="AIza..." value={apiKey} onChange={e => setApiKey(e.target.value)} />
          <div className="api-hint">Free tier: 15 req/min · 1M tokens/day. Saved in browser only.</div>
        </div>

        {error && <div className="error-msg">⚠ {error}</div>}

        <button className="submit-btn" onClick={submit} disabled={loading || !file}>
          {loading && <span className="btn-spinner" />}
          {loading ? 'Uploading...' : '🚀 Generate Quiz'}
        </button>
      </div>

      <div className="how-it-works">
        <h3 className="how-title">How it works</h3>
        <div className="steps">
          {[
            { icon: '📤', label: 'Upload PDF', desc: 'Textbooks, notes, reports, any PDF up to 50MB' },
            { icon: '🐍', label: 'Python Pipeline', desc: 'PyMuPDF + pdfplumber extracts, cleans, and chunks text' },
            { icon: '✨', label: 'Gemini 2.0 Flash', desc: 'Generates contextual MCQs with explanations' },
            { icon: '🎯', label: 'Play & Learn', desc: 'Quiz yourself, review answers, add your own questions' }
          ].map((s, i) => (
            <div key={i} className="step">
              <div className="step-icon">{s.icon}</div>
              <div className="step-label">{s.label}</div>
              <div className="step-desc">{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProcessingPage({ sessionId, filename, onDone, onError }) {
  const [status, setStatus] = useState({ step: 'Initialising...', pct: 0 });
  const [dots, setDots] = useState('');

  useInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 500);

  const poll = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/session/${sessionId}/status`);
      const d = res.data;
      if (d.progress) setStatus(d.progress);
      if (d.status === 'done') onDone(d.meta);
      if (d.status === 'error') onError(d.error);
    } catch (_) {}
  }, [sessionId, onDone, onError]);

  useInterval(poll, 2000);
  useEffect(() => { poll(); }, [poll]);

  return (
    <div className="processing-page">
      <div className="processing-card">
        <div className="processing-orb">
          <div className="orb-ring r1" />
          <div className="orb-ring r2" />
          <div className="orb-ring r3" />
          <div className="orb-core">✨</div>
        </div>
        <h2 className="processing-title">Crafting your quiz{dots}</h2>
        <div className="processing-file">{filename}</div>
        <div className="processing-step">{status.step}</div>
        <div className="proc-bar-wrap">
          <div className="proc-bar-fill" style={{ width: `${status.pct}%` }} />
        </div>
        <div className="proc-pct">{status.pct}%</div>
        <div className="processing-note">🐍 Python pipeline → ✨ Gemini AI → ❓ MCQs</div>
      </div>
    </div>
  );
}

function QuizPlayer({ questions }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const [answers, setAnswers] = useState([]);

  const q = questions[idx];
  const pct = (idx / questions.length) * 100;

  const pick = opt => {
    if (selected) return;
    setSelected(opt);
    const correct = opt === q.correct;
    if (correct) setScore(s => s + 1);
    setAnswers(a => [...a, { qIdx: idx, selected: opt, correct: q.correct, isCorrect: correct }]);
  };

  const next = () => {
    if (idx + 1 >= questions.length) { setDone(true); return; }
    setIdx(i => i + 1); setSelected(null);
  };

  const restart = () => { setIdx(0); setSelected(null); setScore(0); setDone(false); setAnswers([]); };

  if (done) {
    const pctScore = Math.round((score / questions.length) * 100);
    const grade = pctScore >= 80 ? { label: 'Outstanding!', color: '#22c55e', emoji: '🏆' }
      : pctScore >= 60 ? { label: 'Good Work!', color: '#f59e0b', emoji: '👍' }
      : { label: 'Keep Studying', color: '#ef4444', emoji: '📚' };

    return (
      <div className="results-page">
        <div className="results-card">
          <div className="result-emoji">{grade.emoji}</div>
          <h2 className="result-grade" style={{ color: grade.color }}>{grade.label}</h2>
          <div className="result-ring">
            <svg viewBox="0 0 120 120" className="ring-svg">
              <circle cx="60" cy="60" r="50" fill="none" stroke="#27272a" strokeWidth="10" />
              <circle cx="60" cy="60" r="50" fill="none" stroke={grade.color} strokeWidth="10"
                strokeDasharray={`${pctScore * 3.14} 314`} strokeLinecap="round"
                transform="rotate(-90 60 60)" />
            </svg>
            <div className="ring-text">
              <div className="ring-score">{pctScore}%</div>
              <div className="ring-label">{score}/{questions.length}</div>
            </div>
          </div>
          <div className="result-stats">
            <div className="rstat green"><span>{score}</span>Correct</div>
            <div className="rstat red"><span>{questions.length - score}</span>Wrong</div>
            <div className="rstat blue"><span>{questions.length}</span>Total</div>
          </div>
          <button className="quiz-btn primary" onClick={restart}>↺ Try Again</button>
        </div>
        <div className="review-section">
          <h3 className="review-title">Review Answers</h3>
          {answers.map((a, i) => {
            const qq = questions[a.qIdx];
            return (
              <div key={i} className={`review-item ${a.isCorrect ? 'rev-correct' : 'rev-wrong'}`}>
                <div className="review-q">{i + 1}. {qq?.question}</div>
                <div className="review-ans">
                  {a.isCorrect
                    ? <span className="ra-correct">✓ {qq?.options?.[a.correct]}</span>
                    : <>
                      <span className="ra-wrong">✗ Your answer: {qq?.options?.[a.selected]}</span>
                      <span className="ra-correct">✓ Correct: {qq?.options?.[a.correct]}</span>
                    </>}
                </div>
                {qq?.explanation && <div className="review-exp">💡 {qq.explanation}</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="quiz-player">
      <div className="qp-header">
        <div className="qp-counter"><span className="qp-cur">{idx + 1}</span><span className="qp-sep">/</span>{questions.length}</div>
        <div className="qp-subject">{q.subject}</div>
        <div className="qp-score">Score: <strong>{score}</strong></div>
      </div>
      <div className="qp-progress"><div className="qp-prog-fill" style={{ width: `${pct}%` }} /></div>
      <div className="question-card">
        <p className="question-text">{q.question}</p>
        <div className="options">
          {['a', 'b', 'c', 'd'].map(opt => {
            let cls = '';
            if (selected) {
              if (opt === q.correct) cls = 'opt-correct';
              else if (opt === selected) cls = 'opt-wrong';
            }
            return (
              <button key={opt} className={`option ${cls} ${selected === opt ? 'opt-selected' : ''}`}
                onClick={() => pick(opt)} disabled={!!selected}>
                <span className="opt-letter">{opt}</span>
                <span>{q.options[opt]}</span>
              </button>
            );
          })}
        </div>
        {selected && q.explanation && (
          <div className="explanation">
            <span className="exp-label">💡 Explanation</span>
            <p>{q.explanation}</p>
          </div>
        )}
      </div>
      <div className="qp-footer">
        <button className="quiz-btn secondary" onClick={restart}>↺ Restart</button>
        <button className="quiz-btn primary" onClick={next} disabled={!selected}>
          {idx + 1 >= questions.length ? 'Finish 🏁' : 'Next →'}
        </button>
      </div>
    </div>
  );
}

function ManageQuestions({ sessionId, questions, onUpdate, onToast }) {
  const blank = { subject: 'General', question: '', options: { a: '', b: '', c: '', d: '' }, correct: 'a', explanation: '' };
  const [form, setForm] = useState(blank);
  const [editId, setEditId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const setOpt = (k, v) => setForm(f => ({ ...f, options: { ...f.options, [k]: v } }));

  const submit = async () => {
    if (!form.question || !form.options.a || !form.options.b || !form.options.c || !form.options.d) {
      onToast('Fill all fields', 'error'); return;
    }
    setSubmitting(true);
    try {
      if (editId) {
        const res = await axios.put(`${API}/session/${sessionId}/questions/${editId}`, form);
        onUpdate(questions.map(q => q.id === editId ? res.data : q));
        onToast('Updated!', 'success');
      } else {
        const res = await axios.post(`${API}/session/${sessionId}/questions`, form);
        onUpdate([...questions, res.data]);
        onToast('Question added!', 'success');
      }
      setForm(blank); setEditId(null);
    } catch { onToast('Error saving', 'error'); }
    setSubmitting(false);
  };

  const del = async id => {
    if (!window.confirm('Delete?')) return;
    await axios.delete(`${API}/session/${sessionId}/questions/${id}`);
    onUpdate(questions.filter(q => q.id !== id));
    onToast('Deleted', 'success');
  };

  const edit = q => {
    setEditId(q.id);
    setForm({ subject: q.subject, question: q.question, options: { ...q.options }, correct: q.correct, explanation: q.explanation || '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="manage-page">
      <div className="manage-form">
        <h3 className="manage-title">{editId ? '✏️ Edit Question' : '➕ Add Question'}</h3>
        <div className="mf-row two">
          <div className="mf-group">
            <label className="mf-label">Subject</label>
            <input className="mf-input" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="e.g. Polity, Economy..." />
          </div>
          <div className="mf-group">
            <label className="mf-label">Correct Answer</label>
            <select className="mf-input" value={form.correct} onChange={e => setForm(f => ({ ...f, correct: e.target.value }))}>
              {['a','b','c','d'].map(o => <option key={o} value={o}>{o.toUpperCase()}</option>)}
            </select>
          </div>
        </div>
        <div className="mf-group">
          <label className="mf-label">Question</label>
          <textarea className="mf-input mf-textarea" value={form.question} onChange={e => setForm(f => ({ ...f, question: e.target.value }))} placeholder="Enter your question..." rows={3} />
        </div>
        <div className="mf-row two">
          {['a','b','c','d'].map(opt => (
            <div key={opt} className="mf-opt-group">
              <span className="mf-opt-badge">{opt}</span>
              <input className="mf-input" value={form.options[opt]} onChange={e => setOpt(opt, e.target.value)} placeholder={`Option ${opt.toUpperCase()}`} />
            </div>
          ))}
        </div>
        <div className="mf-group">
          <label className="mf-label">Explanation (optional)</label>
          <textarea className="mf-input mf-textarea" value={form.explanation} onChange={e => setForm(f => ({ ...f, explanation: e.target.value }))} rows={2} />
        </div>
        <div className="mf-actions">
          {editId && <button className="quiz-btn secondary" onClick={() => { setForm(blank); setEditId(null); }}>Cancel</button>}
          <button className="quiz-btn primary" onClick={submit} disabled={submitting}>{submitting ? '...' : editId ? 'Update' : 'Add Question'}</button>
        </div>
      </div>
      <div className="qlist">
        <h3 className="manage-title">All Questions <span className="qcount">({questions.length})</span></h3>
        {questions.map((q, i) => (
          <div key={q.id} className="qlist-item">
            <div className="qlist-num">{String(i + 1).padStart(2, '0')}</div>
            <div className="qlist-body">
              <div className="qlist-subject">{q.subject}</div>
              <div className="qlist-q">{q.question}</div>
              <div className="qlist-ans">✓ ({q.correct.toUpperCase()}) {q.options[q.correct]}</div>
            </div>
            <div className="qlist-actions">
              <button className="icon-btn" onClick={() => edit(q)}>✏️</button>
              <button className="icon-btn red" onClick={() => del(q.id)}>🗑</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionDashboard({ sessionId, meta, questions, setQuestions, onToast }) {
  const [tab, setTab] = useState('quiz');
  const [subjectFilter, setSubjectFilter] = useState('All');

  const subjects = ['All', ...new Set(questions.map(q => q.subject))];
  const filtered = subjectFilter === 'All' ? questions : questions.filter(q => q.subject === subjectFilter);

  return (
    <div className="dashboard">
      {meta && (
        <div className="meta-bar">
          <div className="meta-item"><span>📄</span>{meta.filename}</div>
          <div className="meta-item"><span>📋</span>{meta.pages} pages</div>
          <div className="meta-item"><span>🧩</span>{meta.chunks} chunks processed</div>
          <div className="meta-item"><span>❓</span>{questions.length} questions</div>
          {meta.topics?.length > 0 && <div className="meta-item"><span>🏷</span>{meta.topics.slice(0,4).join(', ')}</div>}
        </div>
      )}
      <div className="tab-bar">
        {[{id:'quiz',label:'🎯 Take Quiz'},{id:'manage',label:'⚙️ Manage Questions'}].map(t => (
          <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {tab === 'quiz' && (
        <div>
          <div className="filter-bar">
            {subjects.map(s => (
              <button key={s} className={`filter-chip ${subjectFilter === s ? 'active' : ''}`} onClick={() => setSubjectFilter(s)}>{s}</button>
            ))}
          </div>
          {filtered.length === 0
            ? <div className="empty">No questions for this filter.</div>
            : <QuizPlayer key={subjectFilter + filtered.length} questions={filtered} />}
        </div>
      )}
      {tab === 'manage' && <ManageQuestions sessionId={sessionId} questions={questions} onUpdate={setQuestions} onToast={onToast} />}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('upload');
  const [sessionId, setSessionId] = useState(null);
  const [filename, setFilename] = useState('');
  const [meta, setMeta] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [toasts, setToasts] = useState([]);

  const addToast = (msg, type = 'success') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  };

  const onSessionStart = (sid, fname) => { setSessionId(sid); setFilename(fname); setScreen('processing'); };

  const onDone = useCallback(async m => {
    setMeta(m);
    try {
      const res = await axios.get(`${API}/session/${sessionId}/questions`);
      setQuestions(res.data.questions);
    } catch (e) { console.error(e); }
    setScreen('dashboard');
  }, [sessionId]);

  const onError = useCallback(msg => {
    addToast(msg || 'Processing failed', 'error');
    setScreen('upload');
  }, []);

  const goHome = () => { setScreen('upload'); setSessionId(null); setFilename(''); setMeta(null); setQuestions([]); };

  return (
    <div className="app">
      <header className="header">
        <button className="logo" onClick={goHome}>
          <span className="logo-icon">⚡</span>
          <span className="logo-text">Recall<span>Genie</span></span>
        </button>
        <div className="header-right">
          {screen === 'dashboard' && <button className="header-btn" onClick={goHome}>+ New Quiz</button>}
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="header-link">Get Gemini Key</a>
        </div>
      </header>
      <main className="main">
        {screen === 'upload' && <UploadPage onSessionStart={onSessionStart} />}
        {screen === 'processing' && <ProcessingPage sessionId={sessionId} filename={filename} onDone={onDone} onError={onError} />}
        {screen === 'dashboard' && <SessionDashboard sessionId={sessionId} meta={meta} questions={questions} setQuestions={setQuestions} onToast={addToast} />}
      </main>
      <Toast toasts={toasts} />
    </div>
  );
}
