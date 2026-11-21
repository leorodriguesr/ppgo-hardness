-- Avaliação humana opcional por resultado (complementa o juiz automático)
ALTER TABLE evaluation_results ADD COLUMN IF NOT EXISTS human_review jsonb;
