-- Jobs service schema (Neon Postgres). Owner: Marwan.
-- Run once with:  node scripts/migrate-jobs-db.js   (reads the URL from Secrets Manager)
-- Safe to run again: every statement is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(80)  NOT NULL UNIQUE,
  description VARCHAR(300),
  created_by  VARCHAR(64)  NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             VARCHAR(120) NOT NULL,
  description       TEXT         NOT NULL,
  requirements      TEXT,
  location          VARCHAR(80)  NOT NULL,
  employment_type   VARCHAR(20)  NOT NULL CHECK (employment_type IN ('full_time','part_time','contract','internship')),
  department_id     UUID         NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  hiring_manager_id VARCHAR(64),
  openings          INTEGER      NOT NULL DEFAULT 1 CHECK (openings BETWEEN 1 AND 50),
  hired_count       INTEGER      NOT NULL DEFAULT 0 CHECK (hired_count >= 0),
  salary_min        INTEGER      CHECK (salary_min >= 0),
  salary_max        INTEGER      CHECK (salary_max >= 0),
  closing_date      DATE,
  status            VARCHAR(12)  NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','closed')),
  close_reason      VARCHAR(200),
  created_by        VARCHAR(64)  NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_at      TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  CONSTRAINT salary_range CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx     ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_department_idx ON jobs(department_id);
CREATE INDEX IF NOT EXISTS jobs_manager_idx    ON jobs(hiring_manager_id);

-- Audit trail of every job status change (draft -> published -> closed ...)
CREATE TABLE IF NOT EXISTS job_events (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status VARCHAR(12),
  to_status   VARCHAR(12) NOT NULL,
  reason      VARCHAR(200),
  changed_by  VARCHAR(64) NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id);

-- Saved analytics reports, so recruiters can compare hiring KPIs over time
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  label      VARCHAR(80) NOT NULL,
  scope      JSONB       NOT NULL,
  metrics    JSONB       NOT NULL,
  taken_by   VARCHAR(64) NOT NULL,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
