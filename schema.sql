-- Operating Theatre Scheduling System — SQLite schema

DROP TABLE IF EXISTS surgery_request;
DROP TABLE IF EXISTS theatre_equipment;
DROP TABLE IF EXISTS equipment;
DROP TABLE IF EXISTS theatre;
DROP TABLE IF EXISTS surgeon;

CREATE TABLE surgeon (
    id           TEXT PRIMARY KEY,
    name         TEXT    NOT NULL,
    specialty    TEXT    NOT NULL,
    shift_start  TEXT    NOT NULL,          -- 'HH:MM'
    shift_end    TEXT    NOT NULL,
    max_minutes  INTEGER NOT NULL DEFAULT 600
);

CREATE TABLE theatre (
    id        TEXT PRIMARY KEY,
    name      TEXT    NOT NULL,
    ot_type   TEXT    NOT NULL,             -- cardiac | ortho | general | neuro
    turnover  INTEGER NOT NULL DEFAULT 30   -- cleaning minutes held after each case
);

CREATE TABLE equipment (
    id     TEXT PRIMARY KEY,
    name   TEXT    NOT NULL,
    units  INTEGER NOT NULL DEFAULT 1       -- mobile units shared across theatres
);

-- Equipment permanently installed in a theatre consumes no mobile unit.
CREATE TABLE theatre_equipment (
    theatre_id   TEXT NOT NULL REFERENCES theatre(id),
    equipment_id TEXT NOT NULL,
    PRIMARY KEY (theatre_id, equipment_id)
);

CREATE TABLE surgery_request (
    id             TEXT PRIMARY KEY,
    patient        TEXT    NOT NULL,
    procedure      TEXT    NOT NULL,
    duration       INTEGER NOT NULL,        -- minutes
    surgeon_id     TEXT    NOT NULL REFERENCES surgeon(id),
    ot_type        TEXT    NOT NULL,
    equipment      TEXT    NOT NULL DEFAULT '',   -- comma-separated equipment ids
    priority       TEXT    NOT NULL DEFAULT 'elective',
    earliest_start INTEGER,                 -- minutes from midnight, nullable
    deadline       INTEGER,
    requested_by   TEXT    NOT NULL DEFAULT 'Hospital Staff',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (duration > 0),
    CHECK (priority IN ('emergency', 'urgent', 'elective'))
);

CREATE INDEX idx_request_priority ON surgery_request(priority);
CREATE INDEX idx_request_surgeon  ON surgery_request(surgeon_id);
