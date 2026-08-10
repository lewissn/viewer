-- Storage bucket for imported cabinet models and textures.
--
-- Public read: the 3D viewer loads models and their textures by URL straight
-- from the browser, and customers open assembly guides without an account.
-- Writes are never public — uploads only happen through short-lived signed
-- upload URLs minted server-side with the service-role key.

INSERT INTO storage.buckets (id, name, public)
VALUES ('project-files', 'project-files', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Anyone may read objects in this bucket.
DROP POLICY IF EXISTS "project-files public read" ON storage.objects;
CREATE POLICY "project-files public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'project-files');
