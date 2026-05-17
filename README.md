# ⚡ QuizForge — AI Quiz from Any PDF

Upload any PDF → Python pipeline cleans & chunks it → Gemini 2.0 Flash generates MCQs → You play.

---

## Architecture

```
┌─────────────────┐     PDF      ┌──────────────────────────┐
│   React App     │ ──────────→  │  Node.js Backend (4000)  │
│   (port 3000)   │ ←──────────  │  Express + Multer        │
└─────────────────┘   questions  └────────────┬─────────────┘
                                              │ spawns
                                              ▼
                                 ┌──────────────────────────┐
                                 │  Python Pipeline         │
                                 │  pdfplumber + PyMuPDF    │
                                 │  Text clean + chunking   │
                                 └────────────┬─────────────┘
                                              │ chunks JSON
                                              ▼
                                 ┌──────────────────────────┐
                                 │  Gemini 2.0 Flash API    │
                                 │  (Free tier: 15 RPM)     │
                                 │  Generates MCQs + expl.  │
                                 └──────────────────────────┘
```

---

## Setup

### Prerequisites
- Node.js 16+
- Python 3.8+
- A free Gemini API key: https://aistudio.google.com/app/apikey

### 1. Install Python dependencies
```bash
pip install pdfplumber pymupdf
```

### 2. Install Node dependencies
```bash
cd backend && npm install
cd ../frontend && npm install
```

### 3. Run

**Terminal 1 — Backend (port 4000):**
```bash
cd backend
npm run dev
```

**Terminal 2 — Frontend (port 3000):**
```bash
cd frontend
DANGEROUSLY_DISABLE_HOST_CHECK=true npm run dev
```

Open **http://localhost:3000**

---

## Usage

1. Enter your Gemini API key (stored locally in browser)
2. Drag & drop any PDF (textbooks, notes, reports — up to 50MB)
3. Set number of questions (5–80)
4. Click **Generate Quiz** and watch the pipeline work
5. Take the quiz, filter by topic, add your own questions

---

## Python Pipeline (python-pipeline/process_pdf.py)

### What it does:
1. **Extracts** text using `pdfplumber` (primary) or `PyMuPDF` (fallback)
2. **Extracts tables** and embeds them inline as text
3. **Cleans** the text: fixes hyphenated breaks, removes noise, page numbers, headers/footers
4. **Chunks** intelligently at paragraph boundaries with 200-char overlap (prevents context loss)
5. **Detects topic** per chunk using keyword matching (Polity, Economy, Environment, etc.)
6. **Outputs** structured JSON with chunk metadata

### CLI usage:
```bash
python3 python-pipeline/process_pdf.py my_doc.pdf --chunk-size 2800
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload PDF + start generation |
| GET | `/api/session/:id/status` | Poll processing status |
| GET | `/api/session/:id/questions` | Get generated questions |
| POST | `/api/session/:id/questions` | Add question manually |
| PUT | `/api/session/:id/questions/:qid` | Edit question |
| DELETE | `/api/session/:id/questions/:qid` | Delete question |
| GET | `/api/health` | Backend health check |

### Upload headers:
```
X-Gemini-Key: AIza...   (your Gemini API key)
Content-Type: multipart/form-data
```

### Upload body:
```
pdf: <file>
numQuestions: 30
```

---

## Gemini Free Tier Limits
- 15 requests per minute
- 1,000,000 tokens per day
- The backend automatically adds 1.5s delays between calls to stay within limits

---

## Project Structure
```
quizforge/
├── backend/
│   ├── server.js           ← Express API, orchestrates pipeline + Gemini
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.js          ← Full React UI (Upload, Processing, Quiz, Manage)
│   │   └── App.css         ← Dark editorial design system
│   └── package.json
├── python-pipeline/
│   └── process_pdf.py      ← PDF extraction, cleaning, chunking, topic detection
├── uploads/                ← Temp PDF storage (auto-cleaned after processing)
└── README.md
```
