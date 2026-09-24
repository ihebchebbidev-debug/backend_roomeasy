/** Shared PL/pgSQL helpers. All are CREATE OR REPLACE, so they are idempotent. */
export const functions: string[] = [
  `CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     NEW.updated_at := now();
     RETURN NEW;
   END;
   $$;`,

  `CREATE OR REPLACE FUNCTION deaccent(value text) RETURNS text
   LANGUAGE sql IMMUTABLE STRICT AS $$
     SELECT lower(regexp_replace(translate(value,
       'áàâäãåéèêëíìîïóòôöõúùûüçñýÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑÝ',
       'aaaaaaeeeeiiiiooooouuuucnyaaaaaaeeeeiiiiooooouuuucny'), '[^ -~]', '', 'g'));
   $$;`,

  `CREATE OR REPLACE FUNCTION has_role(p_user_id uuid, p_role user_role)
   RETURNS boolean LANGUAGE sql STABLE AS $$
     SELECT EXISTS (SELECT 1 FROM user_role_grant WHERE user_id = p_user_id AND role = p_role);
   $$;`,

  `CREATE OR REPLACE FUNCTION refresh_property_rating() RETURNS trigger
   LANGUAGE plpgsql AS $$
   DECLARE target text := coalesce(NEW.property_id, OLD.property_id);
   BEGIN
     UPDATE property p
        SET rating = coalesce((SELECT round(avg(rating)::numeric, 2)
                                 FROM review WHERE property_id = target AND hidden = false), 0),
            review_count = (SELECT count(*) FROM review
                             WHERE property_id = target AND hidden = false)
      WHERE p.id = target;
     RETURN NULL;
   END;
   $$;`,

  `CREATE OR REPLACE FUNCTION enforce_photo_limit() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     IF (SELECT count(*) FROM property_photo WHERE property_id = NEW.property_id) > 10 THEN
       RAISE EXCEPTION 'A listing can hold at most 10 photos' USING ERRCODE = '23514';
     END IF;
     RETURN NULL;
   END;
   $$;`,

  `CREATE OR REPLACE FUNCTION protect_audit_log() RETURNS trigger
   LANGUAGE plpgsql AS $$
   BEGIN
     -- Maintenance scripts (demo reseed) may purge their own rows explicitly.
     IF current_setting('app.audit_maintenance', true) = 'on' THEN
       RETURN coalesce(NEW, OLD);
     END IF;
     -- Deleting an admin account nulls admin_id (ON DELETE SET NULL): allowed,
     -- as long as nothing else in the row changes.
     IF TG_OP = 'UPDATE'
        AND NEW.admin_id IS NULL
        AND (NEW.id, NEW.action, NEW.target_kind, NEW.target_id, NEW.reason, NEW.metadata, NEW.created_at)
            IS NOT DISTINCT FROM
            (OLD.id, OLD.action, OLD.target_kind, OLD.target_id, OLD.reason, OLD.metadata, OLD.created_at) THEN
       RETURN NEW;
     END IF;
     RAISE EXCEPTION 'The audit log is append-only' USING ERRCODE = '42501';
   END;
   $$;`,
];
