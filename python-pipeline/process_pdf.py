#!/usr/bin/env python3
"""
QuizForge PDF Processing Pipeline
- Extracts text from PDF using pdfplumber + PyMuPDF fallback
- Cleans, chunks, and optimizes text for LLM consumption
- Outputs structured JSON for the Node.js backend
"""

import sys
import json
import re
import os
import argparse

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


# ─── TEXT EXTRACTION ────────────────────────────────────────────────────────

def extract_with_pdfplumber(pdf_path):
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        meta = pdf.metadata or {}
        for i, page in enumerate(pdf.pages):
            text = page.extract_text() or ""
            tables = []
            for tbl in (page.extract_tables() or []):
                rows = []
                for row in tbl:
                    cleaned = [str(c).strip() if c else "" for c in row]
                    if any(cleaned):
                        rows.append(" | ".join(cleaned))
                if rows:
                    tables.append("\n".join(rows))
            pages.append({
                "page": i + 1,
                "text": text.strip(),
                "tables": tables
            })
    return pages, meta


def extract_with_pymupdf(pdf_path):
    pages = []
    doc = fitz.open(pdf_path)
    meta = doc.metadata or {}
    for i, page in enumerate(doc):
        text = page.get_text("text") or ""
        pages.append({
            "page": i + 1,
            "text": text.strip(),
            "tables": []
        })
    doc.close()
    return pages, meta


def extract_text(pdf_path):
    if pdfplumber:
        try:
            return extract_with_pdfplumber(pdf_path)
        except Exception:
            pass
    if fitz:
        return extract_with_pymupdf(pdf_path)
    raise RuntimeError("No PDF library available. Install pdfplumber or pymupdf.")


# ─── TEXT CLEANING ───────────────────────────────────────────────────────────

def clean_text(text):
    # Remove null bytes and control chars
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    # Fix hyphenated line breaks
    text = re.sub(r'-\n(\w)', r'\1', text)
    # Normalize whitespace but preserve paragraph breaks
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Remove repeated punctuation noise
    text = re.sub(r'[_=\-]{4,}', '', text)
    # Remove page numbers (standalone digits or "Page X of Y")
    text = re.sub(r'(?m)^\s*(?:Page\s+)?\d+\s*(?:of\s+\d+)?\s*$', '', text)
    # Remove headers/footers that repeat (short lines appearing often)
    text = re.sub(r'(?m)^.{1,4}$', '', text)
    # Remove URLs
    text = re.sub(r'https?://\S+', '', text)
    # Collapse multiple blank lines
    text = re.sub(r'\n\s*\n\s*\n', '\n\n', text)
    return text.strip()


def detect_heading(line):
    """Heuristically detect if a line is a section heading."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    # All caps or title case short lines
    if stripped.isupper() and len(stripped) > 3:
        return True
    # Numbered headings like "1.", "1.1", "Chapter 1"
    if re.match(r'^(?:Chapter\s+\d+|\d+[\.\d]*\.?\s+[A-Z])', stripped):
        return True
    return False


def build_structured_text(pages):
    """Merge pages into structured text with table data."""
    sections = []
    for p in pages:
        lines = p["text"].split("\n")
        section_text = []
        for line in lines:
            if detect_heading(line):
                if section_text:
                    sections.append(" ".join(section_text))
                section_text = [line.strip()]
            else:
                section_text.append(line.strip())
        # Add tables inline
        for tbl in p.get("tables", []):
            section_text.append("[TABLE]\n" + tbl + "\n[/TABLE]")
        if section_text:
            sections.append(" ".join(section_text))
    return "\n\n".join(sections)


# ─── CHUNKING ────────────────────────────────────────────────────────────────

def smart_chunk(text, max_chars=3000, overlap=200):
    """
    Split text into overlapping chunks at paragraph/sentence boundaries.
    Returns list of chunk strings.
    """
    paragraphs = re.split(r'\n\n+', text)
    chunks = []
    current = []
    current_len = 0

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if current_len + len(para) > max_chars and current:
            chunk_text = "\n\n".join(current)
            chunks.append(chunk_text)
            # Overlap: keep last paragraph(s) up to `overlap` chars
            overlap_text = ""
            for p in reversed(current):
                if len(overlap_text) + len(p) <= overlap:
                    overlap_text = p + "\n\n" + overlap_text
                else:
                    break
            current = [overlap_text.strip()] if overlap_text.strip() else []
            current_len = len(overlap_text)
        current.append(para)
        current_len += len(para) + 2

    if current:
        chunks.append("\n\n".join(current))

    return [c for c in chunks if len(c.strip()) > 100]


# ─── TOPIC DETECTION ────────────────────────────────────────────────────────

TOPIC_KEYWORDS = {
    "Polity": ["constitution", "parliament", "lok sabha", "rajya sabha", "article", "act", "judiciary", "supreme court", "high court", "election", "president", "governor", "minister", "panchayat", "fundamental rights", "directive principles", "amendment", "writ"],
    "Economy": ["gdp", "inflation", "fiscal", "monetary", "budget", "rbi", "sebi", "bank", "tax", "trade", "export", "import", "investment", "market", "currency", "credit", "finance", "insurance", "pension", "startup"],
    "Environment": ["climate", "biodiversity", "forest", "wildlife", "pollution", "carbon", "emission", "ecosystem", "species", "conservation", "renewable", "solar", "energy", "water", "river", "ocean", "glacier"],
    "International Relations": ["bilateral", "multilateral", "treaty", "agreement", "summit", "un", "nato", "asean", "g20", "g7", "brics", "diplomatic", "foreign policy", "sanctions", "trade deal", "ambassador"],
    "Science & Technology": ["satellite", "space", "isro", "nasa", "ai", "artificial intelligence", "quantum", "technology", "innovation", "research", "mission", "launch", "biotech", "pharma", "vaccine", "nuclear", "cyber"],
    "Social Issues": ["poverty", "health", "education", "gender", "women", "child", "tribal", "dalit", "sc", "st", "obc", "reservation", "welfare", "social", "human rights", "migration", "unemployment"],
    "Governance": ["scheme", "policy", "programme", "mission", "yojana", "committee", "commission", "authority", "regulation", "reform", "e-governance", "transparency", "corruption", "accountability"],
    "Culture": ["heritage", "art", "culture", "festival", "dance", "music", "literature", "history", "archaeology", "monument", "temple", "religion", "language", "tradition", "tribe"],
    "Geography": ["mountain", "river", "plateau", "coast", "state", "district", "border", "region", "zone", "latitude", "longitude", "map", "peninsula", "island", "delta"]
}

def detect_topic(text):
    text_lower = text.lower()
    scores = {}
    for topic, keywords in TOPIC_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text_lower)
        if score > 0:
            scores[topic] = score
    if not scores:
        return "General"
    return max(scores, key=scores.get)


# ─── MAIN PIPELINE ───────────────────────────────────────────────────────────

def process_pdf(pdf_path, max_chunk_chars=3000):
    if not os.path.exists(pdf_path):
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    file_size_mb = os.path.getsize(pdf_path) / (1024 * 1024)

    # Extract
    pages, meta = extract_text(pdf_path)
    total_pages = len(pages)

    # Build structured text
    raw = build_structured_text(pages)

    # Clean
    cleaned = clean_text(raw)

    # Chunk
    chunks = smart_chunk(cleaned, max_chars=max_chunk_chars, overlap=200)

    # Annotate chunks with topic
    annotated_chunks = []
    for i, chunk in enumerate(chunks):
        annotated_chunks.append({
            "id": i + 1,
            "topic": detect_topic(chunk),
            "text": chunk,
            "char_count": len(chunk)
        })

    # Stats
    total_chars = sum(c["char_count"] for c in annotated_chunks)
    topic_distribution = {}
    for c in annotated_chunks:
        t = c["topic"]
        topic_distribution[t] = topic_distribution.get(t, 0) + 1

    result = {
        "status": "success",
        "file": os.path.basename(pdf_path),
        "file_size_mb": round(file_size_mb, 2),
        "total_pages": total_pages,
        "total_chunks": len(annotated_chunks),
        "total_chars": total_chars,
        "topics_detected": list(topic_distribution.keys()),
        "topic_distribution": topic_distribution,
        "metadata": {
            "title": meta.get("title", "") or meta.get("Title", ""),
            "author": meta.get("author", "") or meta.get("Author", ""),
            "subject": meta.get("subject", "") or meta.get("Subject", ""),
        },
        "chunks": annotated_chunks
    }
    return result


# ─── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="QuizForge PDF Processor")
    parser.add_argument("pdf_path", help="Path to input PDF")
    parser.add_argument("--chunk-size", type=int, default=3000, help="Max chars per chunk")
    parser.add_argument("--output", help="Output JSON path (default: stdout)")
    args = parser.parse_args()

    try:
        result = process_pdf(args.pdf_path, max_chunk_chars=args.chunk_size)
        output = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(output)
            print(json.dumps({"status": "success", "output": args.output, "chunks": result["total_chunks"]}))
        else:
            print(output)
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.exit(1)
