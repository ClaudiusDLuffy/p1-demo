-- Expand allowed MIME types on photos bucket
-- to support all common image formats from any device
-- including iPhone HEIF, WebP, and standard JPEG/PNG

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff'
]
where id = 'photos';
