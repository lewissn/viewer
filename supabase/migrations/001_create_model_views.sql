-- Create the model_views table
CREATE TABLE IF NOT EXISTS model_views (
  id TEXT PRIMARY KEY,
  job_number TEXT UNIQUE NOT NULL,
  model_urls JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index on job_number for fast lookups during upsert
CREATE INDEX IF NOT EXISTS idx_model_views_job_number ON model_views (job_number);

-- Trigger to auto-update updated_at on row modification
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON model_views
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
