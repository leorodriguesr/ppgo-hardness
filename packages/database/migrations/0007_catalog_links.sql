-- Vínculo entre o ato consolidado (pai) e os atos que o alteram ou que ele revoga.

CREATE TABLE catalog_act_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_source text NOT NULL,
  parent_external_id integer NOT NULL,
  child_source text NOT NULL,
  child_external_id integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('alteracao', 'revogacao')),
  incorporated boolean NOT NULL DEFAULT false,
  origin text NOT NULL CHECK (origin IN ('ementa', 'revoked_by')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_act_links_pair UNIQUE (parent_source, parent_external_id, child_source, child_external_id, kind),
  CONSTRAINT catalog_act_links_parent_fk FOREIGN KEY (parent_source, parent_external_id)
    REFERENCES catalog_acts (source, external_id) ON DELETE CASCADE,
  CONSTRAINT catalog_act_links_child_fk FOREIGN KEY (child_source, child_external_id)
    REFERENCES catalog_acts (source, external_id) ON DELETE CASCADE
);

CREATE INDEX catalog_act_links_parent_idx ON catalog_act_links (parent_source, parent_external_id);
CREATE INDEX catalog_act_links_child_idx ON catalog_act_links (child_source, child_external_id);
