"""
OT Scheduling — Flask application.

    python app.py      →  http://127.0.0.1:5000
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

import requests
from dotenv import load_dotenv

try:
    from flask import Flask, jsonify, redirect, render_template, request, url_for
except ModuleNotFoundError as exc:
    raise SystemExit(
        "Flask is not installed. Please install dependencies with: "
        "python -m pip install -r requirements.txt"
    ) from exc

from scheduler.optimizer import Scheduler, to_clock, to_minutes

BASE = Path(__file__).parent
DB_PATH = BASE / "database" / "ot.db"
SCHEMA = BASE / "database" / "schema.sql"
SEED = BASE / "data" / "sample_data.json"

load_dotenv(BASE / ".env")
OPENAI_API_KEY = os.getenv("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")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

app = Flask(__name__)


def call_openai_api(prompt: str, model: str | None = None) -> dict | None:
    """Send a prompt to the OpenAI chat completions API using the configured key."""
    api_key = "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"
    if not api_key:
        return None

    payload = {
        "model": model or OPENAI_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.3,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30,
        )
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        print(f"OpenAI API error: {exc}")
        return None


# --------------------------------------------------------------------- #
# Database
# --------------------------------------------------------------------- #
def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(force: bool = False) -> None:
    """Create the schema and load sample data on first run."""
    if DB_PATH.exists() and not force:
        if DB_PATH.stat().st_size == 0:
            os.remove(DB_PATH)
        else:
            db_age = DB_PATH.stat().st_mtime
            seed_age = SEED.stat().st_mtime
            try:
                with sqlite3.connect(DB_PATH) as conn:
                    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                    if db_age >= seed_age and tables:
                        return
            except sqlite3.DatabaseError:
                pass
            os.remove(DB_PATH)
    if force and DB_PATH.exists():
        os.remove(DB_PATH)
    DB_PATH.parent.mkdir(exist_ok=True)

    seed = json.loads(SEED.read_text())
    with connect() as conn:
        conn.executescript(SCHEMA.read_text())
        conn.executemany(
            "INSERT INTO surgeon VALUES (:id,:name,:specialty,:shift_start,:shift_end,:max_minutes)",
            seed["surgeons"])
        for t in seed["theatres"]:
            conn.execute("INSERT INTO theatre VALUES (?,?,?,?)",
                         (t["id"], t["name"], t["ot_type"], t["turnover"]))
            for eq in t["fixed_equipment"]:
                conn.execute("INSERT INTO theatre_equipment VALUES (?,?)", (t["id"], eq))
        conn.executemany("INSERT INTO equipment VALUES (:id,:name,:units)", seed["equipment"])
        for r in seed["requests"]:
            insert_request(conn, r)


def insert_request(conn: sqlite3.Connection, r: dict) -> None:
    conn.execute(
        """INSERT INTO surgery_request
           (id, patient, procedure, duration, surgeon_id, ot_type, equipment,
            priority, earliest_start, deadline, requested_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (r["id"], r["patient"], r["procedure"], r["duration"], r["surgeon_id"],
         r["ot_type"], ",".join(r.get("equipment", [])), r.get("priority", "elective"),
         r.get("earliest_start"), r.get("deadline"), r.get("requested_by", "Hospital Staff")))


def load_resources(conn: sqlite3.Connection) -> dict:
    fixed: dict[str, list[str]] = {}
    for row in conn.execute("SELECT * FROM theatre_equipment"):
        fixed.setdefault(row["theatre_id"], []).append(row["equipment_id"])
    return {
        "surgeons": [dict(r) for r in conn.execute("SELECT * FROM surgeon ORDER BY id")],
        "theatres": [{**dict(r), "fixed_equipment": fixed.get(r["id"], [])}
                     for r in conn.execute("SELECT * FROM theatre ORDER BY id")],
        "equipment": [dict(r) for r in conn.execute("SELECT * FROM equipment ORDER BY id")],
    }


def load_requests(conn: sqlite3.Connection) -> list[dict]:
    out = []
    for row in conn.execute("SELECT * FROM surgery_request ORDER BY created_at, id"):
        r = dict(row)
        r["equipment"] = [e for e in r["equipment"].split(",") if e]
        out.append(r)
    return out


def next_request_id(conn: sqlite3.Connection, prefix: str = "R") -> str:
    n = conn.execute("SELECT COUNT(*) FROM surgery_request").fetchone()[0]
    return f"{prefix}{n + 1:02d}"


init_db()


# --------------------------------------------------------------------- #
# Scheduling
# --------------------------------------------------------------------- #
def build_schedule(emergency: dict | None = None) -> tuple[Scheduler, dict | None]:
    """Rebuild the full day, then fold in an emergency case if one is supplied."""
    with connect() as conn:
        resources = load_resources(conn)
        requests = load_requests(conn)

    day = json.loads(SEED.read_text())
    sched = Scheduler(resources, day["day_start"], day["day_end"])
    sched.build([r for r in requests if r["priority"] != "emergency"])

    delta = None
    for r in [r for r in requests if r["priority"] == "emergency"] + ([emergency] if emergency else []):
        if r:
            delta = sched.handle_emergency(r)
    return sched, delta


def build_ai_summary() -> dict:
    """Convert the current schedule into an AI-style assistant summary."""
    sched, _ = build_schedule()
    data = sched.to_dict()

    waitlist = data.get("waitlist", [])
    metrics = data.get("metrics", {})
    avg_wait = metrics.get("avg_wait", 0)
    waitlisted = metrics.get("waitlisted", 0)
    utilisation = metrics.get("utilisation", {})

    theatre_names = {t["id"]: t["name"] for t in data.get("theatres", [])}
    utilisation_ranked = sorted(
        ((theatre_names.get(ot_id, f"OT {ot_id}"), util) for ot_id, util in utilisation.items()),
        key=lambda item: item[1],
    )

    recommendations: list[str] = []
    if waitlisted > 0:
        cases = ", ".join(w.get("procedure", "case") for w in waitlist[:3])
        recommendations.append(
            f"AI review: {waitlisted} case(s) are still waiting for a slot, starting with {cases}."
        )
    if avg_wait > 55:
        recommendations.append(
            f"Average waiting time is {avg_wait} minutes; shift lower-priority work earlier to reduce delays."
        )
    if utilisation_ranked and utilisation_ranked[0][1] < 60:
        lowest_name, lowest_util = utilisation_ranked[0]
        recommendations.append(
            f"{lowest_name} is under-used at {lowest_util}% capacity; move flexible cases there first."
        )
    if not recommendations:
        recommendations.append(
            "The current schedule is balanced. Keep a small contingency window for urgent add-ons."
        )

    score = max(45, min(98, 100 - waitlisted * 8 - max(0, avg_wait - 30)))
    headline = (
        "This schedule is generally stable, but there is still room to free capacity for urgent work."
        if score >= 75
        else "The plan needs a tighter handoff to keep urgent work moving without creating bottlenecks."
    )

    return {
        "headline": headline,
        "score": int(score),
        "recommendations": recommendations,
        "bottlenecks": [
            {"name": name, "utilisation": util}
            for name, util in utilisation_ranked[:2]
        ],
    }


def _safe_text(value, default: str = "") -> str:
    if value is None:
        return default

    text = str(value).strip()
    if text.lower() in {"null", "none", "nan", "undefined", "n/a"}:
        return default
    return text or default


def _safe_int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def generate_ai_intake(payload: dict | None) -> dict:
    """Auto-fill patient details and intelligently select matching surgical equipment."""
    payload = payload or {}
    raw_patient = _safe_text(payload.get("patient"), "")
    raw_procedure = _safe_text(payload.get("procedure"), "")
    raw_ot = _safe_text(payload.get("ot_type"), "")

    EQUIPMENT_NAMES = {
        "HEART_LUNG": "Heart-lung machine",
        "C_ARM": "C-arm imaging",
        "VENT": "Ventilator",
        "LAPARO": "Laparoscopy tower",
        "NAV": "Navigation system",
        "ULTRA": "Ultrasound machine",
        "DOPPLER": "Doppler scanner",
        "ANESTH": "Anaesthesia workstation",
        "ICU_MONITOR": "ICU monitoring console",
        "ROBOTIC": "Robotic surgery arm",
        "ENDOSCOPE": "Flexible endoscope",
        "MICROSCOPE": "Microscope",
        "MONITOR": "Patient monitor",
        "LASER": "Laser surgery unit",
        "BIPOLAR": "Bipolar cautery",
        "PHACO": "Phacoemulsification unit",
        "THORACIC": "Thoracic stapler",
        "TRAUMA": "Trauma drill set",
        "COLORECTAL": "Colorectal stapler",
        "HEPATO": "Hepatobiliary retractor",
    }

    SURGERY_PROFILES = [
        {
            "keywords": ["cabg", "coronary artery bypass", "bypass graft", "heart valve", "valve replacement", "cardiac arrest", "aortic", "pericard", "myocardial"],
            "ot_type": "cardiac",
            "surgeon_id": "S1",
            "duration": 210,
            "priority": "urgent",
            "equipment": ["HEART_LUNG", "VENT", "ANESTH", "ICU_MONITOR", "MONITOR"],
        },
        {
            "keywords": ["knee", "hip", "arthroplasty", "joint replacement", "femur", "acl", "orthopedic", "ortho"],
            "ot_type": "ortho",
            "surgeon_id": "S2",
            "duration": 120,
            "priority": "elective",
            "equipment": ["C_ARM", "NAV", "BIPOLAR", "ANESTH"],
        },
        {
            "keywords": ["spine", "spinal", "vertebra", "disc", "cervical", "lumbar", "fusion"],
            "ot_type": "ortho",
            "surgeon_id": "S2",
            "duration": 150,
            "priority": "urgent",
            "equipment": ["C_ARM", "NAV", "MICROSCOPE", "ANESTH"],
        },
        {
            "keywords": ["brain", "neuro", "aneurysm", "craniotomy", "tumour", "tumor", "glioma", "skull"],
            "ot_type": "neuro",
            "surgeon_id": "S5",
            "duration": 170,
            "priority": "urgent",
            "equipment": ["NAV", "MICROSCOPE", "ULTRA", "ICU_MONITOR", "ANESTH"],
        },
        {
            "keywords": ["trauma", "fracture", "pelvic", "amputation", "accident", "bone repair", "orif", "open reduction"],
            "ot_type": "trauma",
            "surgeon_id": "S17",
            "duration": 140,
            "priority": "urgent",
            "equipment": ["TRAUMA", "C_ARM", "ANESTH", "MONITOR"],
        },
        {
            "keywords": ["robotic", "prostatectomy", "oncology", "cancer", "mastectomy", "resection"],
            "ot_type": "oncology",
            "surgeon_id": "S19",
            "duration": 180,
            "priority": "urgent",
            "equipment": ["ROBOTIC", "MONITOR", "BIPOLAR", "ANESTH"],
        },
        {
            "keywords": ["colectomy", "colorectal", "colon", "rectal", "bowel", "hemorrhoid"],
            "ot_type": "colorectal",
            "surgeon_id": "S18",
            "duration": 130,
            "priority": "elective",
            "equipment": ["COLORECTAL", "LAPARO", "BIPOLAR", "ANESTH", "MONITOR"],
        },
        {
            "keywords": ["kidney", "stone", "ureter", "bladder", "urology", "nephrolithotomy"],
            "ot_type": "urology",
            "surgeon_id": "S9",
            "duration": 90,
            "priority": "elective",
            "equipment": ["ENDOSCOPE", "ULTRA", "DOPPLER", "ANESTH", "MONITOR"],
        },
        {
            "keywords": ["cholecystectomy", "gallbladder removal", "gallbladder", "cholecyst", "appendectomy", "hernia repair", "laparoscopic", "laparo"],
            "ot_type": "general",
            "surgeon_id": "S3",
            "duration": 90,
            "priority": "elective",
            "equipment": ["LAPARO", "BIPOLAR", "ANESTH"],
        },
        {
            "keywords": ["liver", "hepat", "biliary", "pancreas", "hepatic resection", "hepatectomy"],
            "ot_type": "hepatobiliary",
            "surgeon_id": "S20",
            "duration": 170,
            "priority": "urgent",
            "equipment": ["HEPATO", "ICU_MONITOR", "ULTRA", "ANESTH"],
        },
        {
            "keywords": ["lung", "thoracic", "lobectomy", "chest", "esophagus", "vats"],
            "ot_type": "thoracic",
            "surgeon_id": "S16",
            "duration": 170,
            "priority": "urgent",
            "equipment": ["THORACIC", "VENT", "ANESTH", "MONITOR"],
        },
        {
            "keywords": ["vascular", "artery", "vein", "carotid", "stent", "doppler", "varicose"],
            "ot_type": "vascular",
            "surgeon_id": "S6",
            "duration": 130,
            "priority": "urgent",
            "equipment": ["DOPPLER", "ULTRA", "C_ARM", "ANESTH"],
        },
        {
            "keywords": ["eye", "cataract", "cornea", "retina", "phaco", "ophthal"],
            "ot_type": "ophthalmology",
            "surgeon_id": "S15",
            "duration": 50,
            "priority": "elective",
            "equipment": ["PHACO", "MICROSCOPE"],
        },
        {
            "keywords": ["endoscopy", "gastro", "colonoscopy", "gastric", "endoscope"],
            "ot_type": "gastro",
            "surgeon_id": "S11",
            "duration": 80,
            "priority": "elective",
            "equipment": ["ENDOSCOPE", "MONITOR", "ANESTH"],
        },
        {
            "keywords": ["ent", "ear", "nose", "throat", "tonsil", "sinus"],
            "ot_type": "ent",
            "surgeon_id": "S10",
            "duration": 85,
            "priority": "elective",
            "equipment": ["MICROSCOPE", "LASER", "ANESTH"],
        },
        {
            "keywords": ["plastic", "cosmetic", "skin", "mole", "lesion", "graft"],
            "ot_type": "plastic",
            "surgeon_id": "S13",
            "duration": 90,
            "priority": "elective",
            "equipment": ["LASER", "BIPOLAR", "ANESTH"],
        },
        {
            "keywords": ["pediatric", "paediatric", "child", "infant"],
            "ot_type": "pediatric",
            "surgeon_id": "S7",
            "duration": 80,
            "priority": "urgent",
            "equipment": ["ANESTH", "MONITOR"],
        },
        {
            "keywords": ["transplant"],
            "ot_type": "transplant",
            "surgeon_id": "S8",
            "duration": 240,
            "priority": "urgent",
            "equipment": ["ICU_MONITOR", "ULTRA", "VENT", "ANESTH"],
        },
    ]

    import random

    SAMPLE_SCENARIOS = [
        {
            "patient": "Ravi Kumar (MRN-8421)",
            "procedure": "Total Knee Arthroplasty (TKA)",
            "ot_type": "ortho",
            "surgeon_id": "S2",
            "duration": 120,
            "priority": "elective",
            "equipment": ["C_ARM", "NAV", "BIPOLAR", "ANESTH"],
        },
        {
            "patient": "Anand K. (MRN-9104)",
            "procedure": "Coronary Artery Bypass Graft (CABG x3)",
            "ot_type": "cardiac",
            "surgeon_id": "S1",
            "duration": 240,
            "priority": "urgent",
            "equipment": ["HEART_LUNG", "VENT", "ANESTH", "ICU_MONITOR", "MONITOR"],
        },
        {
            "patient": "Meera Sundaram (MRN-3320)",
            "procedure": "Laparoscopic Cholecystectomy",
            "ot_type": "general",
            "surgeon_id": "S3",
            "duration": 75,
            "priority": "elective",
            "equipment": ["LAPARO", "BIPOLAR", "ANESTH"],
        },
        {
            "patient": "Vikram Das (MRN-7712)",
            "procedure": "Craniotomy & Tumour Resection",
            "ot_type": "neuro",
            "surgeon_id": "S5",
            "duration": 160,
            "priority": "urgent",
            "equipment": ["NAV", "MICROSCOPE", "ULTRA", "ANESTH", "ICU_MONITOR"],
        },
        {
            "patient": "Samir Lal (MRN-5509)",
            "procedure": "Pelvic Fracture Open Reduction (ORIF)",
            "ot_type": "trauma",
            "surgeon_id": "S17",
            "duration": 150,
            "priority": "urgent",
            "equipment": ["TRAUMA", "C_ARM", "ANESTH", "MONITOR"],
        },
        {
            "patient": "Karthik Raja (MRN-6643)",
            "procedure": "Robotic Radical Prostatectomy",
            "ot_type": "oncology",
            "surgeon_id": "S19",
            "duration": 180,
            "priority": "urgent",
            "equipment": ["ROBOTIC", "MONITOR", "BIPOLAR", "ANESTH"],
        },
        {
            "patient": "Pooja Deshmukh (MRN-4198)",
            "procedure": "Laparoscopic Anterior Colectomy",
            "ot_type": "colorectal",
            "surgeon_id": "S18",
            "duration": 130,
            "priority": "elective",
            "equipment": ["COLORECTAL", "LAPARO", "BIPOLAR", "ANESTH", "MONITOR"],
        },
        {
            "patient": "Ishita Banerjee (MRN-8821)",
            "procedure": "Right Hepatectomy for Hepatic Lesion",
            "ot_type": "hepatobiliary",
            "surgeon_id": "S20",
            "duration": 190,
            "priority": "urgent",
            "equipment": ["HEPATO", "ICU_MONITOR", "ULTRA", "ANESTH"],
        },
        {
            "patient": "Neha Agarwal (MRN-2245)",
            "procedure": "VATS Lung Lobectomy",
            "ot_type": "thoracic",
            "surgeon_id": "S16",
            "duration": 170,
            "priority": "urgent",
            "equipment": ["THORACIC", "VENT", "ANESTH", "MONITOR"],
        },
        {
            "patient": "Ranganathan G. (MRN-1054)",
            "procedure": "Phacoemulsification Cataract Extraction",
            "ot_type": "ophthalmology",
            "surgeon_id": "S15",
            "duration": 45,
            "priority": "elective",
            "equipment": ["PHACO", "MICROSCOPE"],
        },
    ]

    if not raw_procedure or raw_procedure.lower() in ["general procedure", "new case", "new patient", "case"]:
        scenario = random.choice(SAMPLE_SCENARIOS)
        patient_name = raw_patient or scenario["patient"]
        procedure = scenario["procedure"]
        ot_type = scenario["ot_type"]
        surgeon_id = scenario["surgeon_id"]
        duration = scenario["duration"]
        priority = scenario["priority"]
        suggested_equipment = scenario["equipment"]
    else:
        procedure = raw_procedure
        patient_name = raw_patient or "Patient " + procedure.split()[0].capitalize()
        lower = procedure.lower()
        ot_type = raw_ot if raw_ot and raw_ot != "any" else "general"
        surgeon_id = _safe_text(payload.get("surgeon_id"), "S3")
        duration = 90
        priority = _safe_text(payload.get("priority"), "elective")
        suggested_equipment = []

        matched_profile = None
        for profile in SURGERY_PROFILES:
            if any(keyword in lower for keyword in profile["keywords"]):
                matched_profile = profile
                break

        if matched_profile:
            ot_type = matched_profile["ot_type"]
            surgeon_id = matched_profile["surgeon_id"]
            duration = matched_profile["duration"]
            priority = matched_profile["priority"]
            suggested_equipment = matched_profile["equipment"]
        else:
            ot_type = raw_ot if raw_ot and raw_ot != "any" else "general"
            suggested_equipment = ["ANESTH", "MONITOR", "BIPOLAR"]
            priority = "elective"

    if payload.get("priority"):
        priority = _safe_text(payload.get("priority"), priority)
    if payload.get("duration") is not None and str(payload.get("duration")).isdigit():
        value = int(payload.get("duration"))
        if value > 0:
            duration = value

    patient_code = "".join(patient_name.split())[:4].upper() or "PT"
    patient_id = f"PT-{patient_code}{abs(hash(patient_name + procedure)) % 1000:03d}"

    eq_names_list = [EQUIPMENT_NAMES.get(eq, eq) for eq in suggested_equipment]
    eq_summary_str = ", ".join(eq_names_list) if eq_names_list else "Standard surgical set"

    return {
        "patient": patient_name,
        "patient_id": patient_id,
        "procedure": procedure,
        "duration": max(15, duration),
        "surgeon_id": surgeon_id,
        "ot_type": ot_type,
        "priority": priority,
        "equipment": suggested_equipment,
        "equipment_names": eq_names_list,
        "alert_message": (
            f"✨ AI Auto-Fill: {patient_name} — '{procedure}' ({ot_type.capitalize()}). "
            f"Equipments auto-selected: {eq_summary_str}."
        ),
    }


# --------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------- #
@app.route("/")
def index():
    with connect() as conn:
        return render_template("index.html",
                               resources=load_resources(conn),
                               requests=load_requests(conn),
                               to_clock=to_clock)


@app.post("/request")
def create_request():
    f = request.form
    with connect() as conn:
        record = {
            "id": next_request_id(conn),
            "patient": f["patient"].strip(),
            "procedure": f["procedure"].strip(),
            "duration": int(f["duration"]),
            "surgeon_id": f["surgeon_id"],
            "ot_type": f["ot_type"],
            "equipment": f.getlist("equipment"),
            "priority": f.get("priority", "elective"),
            "earliest_start": to_minutes(f["earliest_start"]) if f.get("earliest_start") else None,
            "deadline": to_minutes(f["deadline"]) if f.get("deadline") else None,
        }
        insert_request(conn, record)
    return redirect(url_for("dashboard"))


@app.post("/reset")
def reset():
    init_db(force=True)
    return redirect(url_for("index"))


@app.route("/dashboard")
def dashboard():
    with connect() as conn:
        return render_template("dashboard.html", resources=load_resources(conn))


@app.get("/api/schedule")
def api_schedule():
    sched, _ = build_schedule()
    return jsonify(sched.to_dict())


@app.post("/api/ai-intake")
def api_ai_intake():
    """Auto-fill patient details using an AI-style intake assistant."""
    payload = request.get_json(silent=True) or request.form.to_dict() or {}
    return jsonify(generate_ai_intake(payload))


@app.get("/api/ai-summary")
def api_ai_summary():
    """Return concise operational recommendations for the current OR plan."""
    return jsonify(build_ai_summary())


@app.post("/api/emergency")
def api_emergency():
    """Emergency Request → checks → optimization → New Schedule."""
    body = request.get_json(silent=True) or {}
    if not body:
        return jsonify({"error": "Emergency payload is required."}), 400

    surgeon_id = _safe_text(body.get("surgeon_id"), "S3")
    surgeon_name = _safe_text(body.get("surgeon_name"), "On-call surgeon")
    patient_name = _safe_text(body.get("patient"), "Unidentified patient")
    procedure = _safe_text(body.get("procedure"), "Emergency procedure")
    diagnosis = _safe_text(body.get("diagnosis"), procedure)
    duration = max(15, _safe_int(body.get("duration"), 90))
    ot_type = _safe_text(body.get("ot_type"), "general")
    equipment = body.get("equipment", []) if isinstance(body.get("equipment", []), list) else []
    arrives_at = body.get("arrives_at")
    ot_time = arrives_at if arrives_at else "11:20"

    with connect() as conn:
        emergency = {
            "id": next_request_id(conn, "E"),
            "patient": patient_name,
            "procedure": procedure,
            "duration": duration,
            "surgeon_id": surgeon_id,
            "ot_type": ot_type,
            "equipment": equipment,
            "priority": "emergency",
            "earliest_start": to_minutes(arrives_at) if arrives_at else None,
        }
        insert_request(conn, emergency)
    sched, delta = build_schedule()
    payload = sched.to_dict()
    payload["delta"] = delta
    alert_base = (
        f"Patient: {patient_name} | Doctor: {surgeon_name} | "
        f"Diagnosis: {diagnosis} | Procedure: {procedure} | "
        f"OT timing: {ot_time} | Duration: {duration} min"
    )
    if delta and delta.get("placed"):
        payload["alert_message"] = (
            f"Emergency alert: {alert_base}. A theatre slot has been reassigned and the board has been updated."
        )
    else:
        payload["alert_message"] = (
            f"Emergency alert: {alert_base}. No safe slot was available; escalate to another facility immediately."
        )
    return jsonify(payload)


if __name__ == "__main__":
    init_db()
    app.run(debug=True)
