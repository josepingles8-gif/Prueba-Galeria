package com.galeria.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.JsonWriter;
import android.util.Size;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import androidx.core.content.ContextCompat;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Semaphore;

/**
 * Sirve MediaStore (fotos y videos del telefono) al WebView bajo https://appassets.../media/...
 * Todo se ejecuta en el hilo de E/S del WebView que llama a shouldInterceptRequest, nunca en el de UI.
 */
final class MediaApi {
    static final String PREFIX = "/media/";
    static final Uri IMAGES = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
    static final Uri VIDEOS = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
    private static final int THUMB = 320;
    private static final String CACHE_FOREVER = "max-age=31536000, immutable";

    private final Context app;
    private final ContentResolver cr;
    /** Limita las miniaturas que se generan a la vez (decodificar es costoso en CPU y memoria). */
    private final Semaphore thumbSlots = new Semaphore(3);

    MediaApi(Context context) {
        this.app = context.getApplicationContext();
        this.cr = app.getContentResolver();
    }

    // ---------------------------------------------------------------- permisos

    /** "full" | "partial" | "none". */
    static String permissionState(Context c) {
        if (Build.VERSION.SDK_INT >= 33) {
            boolean img = granted(c, Manifest.permission.READ_MEDIA_IMAGES);
            boolean vid = granted(c, Manifest.permission.READ_MEDIA_VIDEO);
            if (img && vid) return "full";
            if (Build.VERSION.SDK_INT >= 34
                    && (img || vid || granted(c, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED))) {
                return "partial";
            }
            return "none";
        }
        return granted(c, Manifest.permission.READ_EXTERNAL_STORAGE) ? "full" : "none";
    }

    static String[] permissionsToRequest() {
        if (Build.VERSION.SDK_INT >= 34) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED};
        }
        if (Build.VERSION.SDK_INT >= 33) {
            return new String[]{Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO};
        }
        return new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
    }

    private static boolean granted(Context c, String p) {
        return ContextCompat.checkSelfPermission(c, p) == PackageManager.PERMISSION_GRANTED;
    }

    // ---------------------------------------------------------------- ids

    /** "i123" / "v456" -> content URI; null si el id no es valido. */
    static Uri uriFor(String id) {
        if (id == null || id.length() < 2 || id.length() > 20) return null;
        char k = id.charAt(0);
        if (k != 'i' && k != 'v') return null;
        for (int i = 1; i < id.length(); i++) {
            char ch = id.charAt(i);
            if (ch < '0' || ch > '9') return null;
        }
        try {
            return ContentUris.withAppendedId(k == 'v' ? VIDEOS : IMAGES, Long.parseLong(id.substring(1)));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    // ---------------------------------------------------------------- enrutado

    WebResourceResponse handle(WebResourceRequest req) {
        String path = req.getUrl().getPath();
        if (path == null) return null;
        try {
            if (path.equals(PREFIX + "list.json")) return list();
            if (path.startsWith(PREFIX + "thumb/")) return thumb(path.substring((PREFIX + "thumb/").length()));
            if (path.startsWith(PREFIX + "full/")) {
                return full(path.substring((PREFIX + "full/").length()), header(req.getRequestHeaders(), "Range"));
            }
        } catch (RuntimeException e) {
            return error(500, "Internal Server Error");
        }
        return null;
    }

    private static String header(Map<String, String> h, String name) {
        if (h == null) return null;
        for (Map.Entry<String, String> e : h.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) return e.getValue();
        }
        return null;
    }

    private static WebResourceResponse error(int code, String reason) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "UTF-8", code, reason, h,
                new ByteArrayInputStream(new byte[0]));
    }

    // ---------------------------------------------------------------- list.json

    private static final class Row {
        long id;
        boolean video;
        String name, album, mime;
        long date, bucket, size, duration;
        int w, h;
    }

    private static final class Buf extends ByteArrayOutputStream {
        Buf() { super(1 << 20); }
        InputStream stream() { return new ByteArrayInputStream(buf, 0, count); }
    }

    private WebResourceResponse list() {
        ArrayList<Row> rows = new ArrayList<>();
        HashMap<String, String> pool = new HashMap<>(); // mimes y albumes se repiten: una sola instancia
        try {
            query(rows, pool, false);
        } catch (RuntimeException ignored) { /* sin permiso: lista parcial/vacia */ }
        try {
            query(rows, pool, true);
        } catch (RuntimeException ignored) { }
        Row[] arr = rows.toArray(new Row[0]);
        rows = null;
        Arrays.sort(arr, (a, b) -> a.date != b.date ? (a.date < b.date ? 1 : -1)
                : (a.id != b.id ? (a.id < b.id ? 1 : -1) : 0));
        Buf buf = new Buf();
        try (JsonWriter w = new JsonWriter(new OutputStreamWriter(buf, StandardCharsets.UTF_8))) {
            w.beginArray();
            for (Row r : arr) {
                w.beginObject();
                w.name("id").value((r.video ? "v" : "i") + r.id);
                w.name("name").value(r.name);
                w.name("date").value(r.date);
                w.name("album").value(r.album);
                w.name("bucketId").value(r.bucket);
                w.name("width").value((long) r.w);
                w.name("height").value((long) r.h);
                w.name("size").value(r.size);
                w.name("mime").value(r.mime);
                if (r.video) w.name("duration").value(r.duration);
                w.endObject();
            }
            w.endArray();
        } catch (IOException e) {
            return error(500, "Internal Server Error");
        }
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        h.put("Content-Length", String.valueOf(buf.size()));
        return new WebResourceResponse("application/json", "UTF-8", 200, "OK", h, buf.stream());
    }

    private void query(ArrayList<Row> out, HashMap<String, String> pool, boolean video) {
        Uri base = video ? VIDEOS : IMAGES;
        String[] proj = video
                ? new String[]{MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME,
                MediaStore.Video.Media.DATE_TAKEN, MediaStore.Video.Media.DATE_MODIFIED,
                MediaStore.Video.Media.BUCKET_DISPLAY_NAME, MediaStore.Video.Media.BUCKET_ID,
                MediaStore.Video.Media.WIDTH, MediaStore.Video.Media.HEIGHT,
                MediaStore.Video.Media.SIZE, MediaStore.Video.Media.MIME_TYPE,
                MediaStore.Video.Media.DURATION}
                : new String[]{MediaStore.Images.Media._ID, MediaStore.Images.Media.DISPLAY_NAME,
                MediaStore.Images.Media.DATE_TAKEN, MediaStore.Images.Media.DATE_MODIFIED,
                MediaStore.Images.Media.BUCKET_DISPLAY_NAME, MediaStore.Images.Media.BUCKET_ID,
                MediaStore.Images.Media.WIDTH, MediaStore.Images.Media.HEIGHT,
                MediaStore.Images.Media.SIZE, MediaStore.Images.Media.MIME_TYPE,
                MediaStore.Images.Media.ORIENTATION};
        try (Cursor c = cr.query(base, proj, null, null, null)) {
            if (c == null) return;
            while (c.moveToNext()) {
                Row r = new Row();
                r.video = video;
                r.id = c.getLong(0);
                String n = c.getString(1);
                r.name = n == null ? (video ? "video" : "imagen") + r.id : n;
                long taken = c.getLong(2), mod = c.getLong(3);
                r.date = taken > 0 ? taken : mod * 1000L;
                String album = c.getString(4);
                r.album = pooled(pool, album == null || album.isEmpty() ? "Otros" : album);
                r.bucket = c.getLong(5);
                r.w = c.getInt(6);
                r.h = c.getInt(7);
                r.size = c.getLong(8);
                String mime = c.getString(9);
                r.mime = pooled(pool, mime == null ? (video ? "video/mp4" : "image/jpeg") : mime);
                if (video) {
                    r.duration = c.getLong(10);
                } else {
                    int o = c.getInt(10);
                    if (o == 90 || o == 270) { int t = r.w; r.w = r.h; r.h = t; }
                }
                out.add(r);
            }
        }
    }

    private static String pooled(HashMap<String, String> pool, String s) {
        String p = pool.get(s);
        if (p == null) { pool.put(s, s); p = s; }
        return p;
    }

    // ---------------------------------------------------------------- miniaturas

    private WebResourceResponse thumb(String id) {
        Uri uri = uriFor(id);
        if (uri == null) return error(404, "Not Found");
        boolean video = id.charAt(0) == 'v';
        try {
            thumbSlots.acquire();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return error(503, "Busy");
        }
        byte[] jpeg;
        try {
            jpeg = makeThumb(uri, id, video);
        } finally {
            thumbSlots.release();
        }
        if (jpeg == null) return error(404, "Not Found");
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", CACHE_FOREVER);
        h.put("Content-Length", String.valueOf(jpeg.length));
        return new WebResourceResponse("image/jpeg", null, 200, "OK", h, new ByteArrayInputStream(jpeg));
    }

    @SuppressWarnings("deprecation")
    private byte[] makeThumb(Uri uri, String id, boolean video) {
        Bitmap bm = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    bm = cr.loadThumbnail(uri, new Size(THUMB, THUMB), null);
                } catch (IOException | RuntimeException ignored) { /* se prueba el metodo manual */ }
            } else if (video) {
                try {
                    bm = MediaStore.Video.Thumbnails.getThumbnail(cr, Long.parseLong(id.substring(1)),
                            MediaStore.Video.Thumbnails.MINI_KIND, null);
                } catch (RuntimeException ignored) { }
            }
            if (bm == null) bm = video ? videoFrame(uri) : decodeSampled(uri);
            if (bm == null) return null;
            int max = Math.max(bm.getWidth(), bm.getHeight());
            if (max > THUMB * 1.25f) {
                float s = (float) THUMB / max;
                Bitmap sc = Bitmap.createScaledBitmap(bm, Math.max(1, Math.round(bm.getWidth() * s)),
                        Math.max(1, Math.round(bm.getHeight() * s)), true);
                if (sc != bm) { bm.recycle(); bm = sc; }
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream(24 * 1024);
            bm.compress(Bitmap.CompressFormat.JPEG, 82, bo);
            return bo.toByteArray();
        } catch (RuntimeException | OutOfMemoryError e) {
            return null;
        } finally {
            if (bm != null && !bm.isRecycled()) bm.recycle();
        }
    }

    private Bitmap videoFrame(Uri uri) {
        MediaMetadataRetriever mr = new MediaMetadataRetriever();
        try {
            mr.setDataSource(app, uri);
            return mr.getFrameAtTime(-1, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
        } catch (RuntimeException e) {
            return null;
        } finally {
            try { mr.release(); } catch (Exception ignored) { }
        }
    }

    /** Decodificacion con submuestreo + orientacion EXIF (APIs sin loadThumbnail o si este falla). */
    private Bitmap decodeSampled(Uri uri) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) return null;
            BitmapFactory.decodeStream(in, null, o);
        } catch (IOException | RuntimeException e) {
            return null;
        }
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (o.outWidth / (sample * 2) >= THUMB && o.outHeight / (sample * 2) >= THUMB) sample *= 2;
        o.inJustDecodeBounds = false;
        o.inSampleSize = sample;
        Bitmap bm;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) return null;
            bm = BitmapFactory.decodeStream(in, null, o);
        } catch (IOException | RuntimeException e) {
            return null;
        }
        if (bm == null) return null;
        int rot = 0;
        try (InputStream in = cr.openInputStream(uri)) {
            if (in != null) {
                int ori = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION,
                        ExifInterface.ORIENTATION_NORMAL);
                rot = ori == ExifInterface.ORIENTATION_ROTATE_90 ? 90
                        : ori == ExifInterface.ORIENTATION_ROTATE_180 ? 180
                        : ori == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
            }
        } catch (IOException | RuntimeException ignored) { }
        if (rot != 0) {
            Matrix m = new Matrix();
            m.postRotate(rot);
            try {
                Bitmap r = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true);
                if (r != bm) { bm.recycle(); bm = r; }
            } catch (OutOfMemoryError ignored) { }
        }
        return bm;
    }

    // ---------------------------------------------------------------- original (con Range)

    /** Lee como mucho `remaining` bytes del descriptor; cerrarlo cierra el ParcelFileDescriptor. */
    private static final class Slice extends InputStream {
        private final ParcelFileDescriptor.AutoCloseInputStream in;
        private long remaining;

        Slice(ParcelFileDescriptor.AutoCloseInputStream in, long remaining) {
            this.in = in;
            this.remaining = remaining;
        }

        @Override public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = in.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = in.read(b, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override public int available() { return (int) Math.min(remaining, 1 << 16); }

        @Override public void close() throws IOException { in.close(); }
    }

    private WebResourceResponse full(String id, String range) {
        Uri uri = uriFor(id);
        if (uri == null) return error(404, "Not Found");
        boolean video = id.charAt(0) == 'v';
        String mime = null;
        try { mime = cr.getType(uri); } catch (RuntimeException ignored) { }
        if (mime == null || mime.isEmpty()) mime = video ? "video/mp4" : "image/jpeg";
        ParcelFileDescriptor pfd;
        try {
            pfd = cr.openFileDescriptor(uri, "r");
        } catch (IOException | RuntimeException e) {
            return error(404, "Not Found");
        }
        if (pfd == null) return error(404, "Not Found");
        ParcelFileDescriptor.AutoCloseInputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
        long len = pfd.getStatSize();
        Map<String, String> h = new HashMap<>();
        h.put("Accept-Ranges", "bytes");
        h.put("Cache-Control", "private, max-age=3600");
        try {
            if (len < 0) { // tamano desconocido: flujo completo sin Range
                return new WebResourceResponse(mime, null, 200, "OK", h, in);
            }
            long start = 0, end = len - 1;
            boolean partial = false;
            if (range != null && range.startsWith("bytes=") && len > 0) {
                long[] r = parseRange(range.substring(6).trim(), len);
                if (r == null) {
                    in.close();
                    h.put("Content-Range", "bytes */" + len);
                    return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", h,
                            new ByteArrayInputStream(new byte[0]));
                }
                start = r[0];
                end = r[1];
                partial = true;
            }
            long count = len == 0 ? 0 : end - start + 1;
            if (start > 0) in.getChannel().position(start);
            h.put("Content-Length", String.valueOf(count));
            if (partial) {
                h.put("Content-Range", "bytes " + start + "-" + end + "/" + len);
                return new WebResourceResponse(mime, null, 206, "Partial Content", h, new Slice(in, count));
            }
            return new WebResourceResponse(mime, null, 200, "OK", h, new Slice(in, count));
        } catch (IOException | RuntimeException e) {
            try { in.close(); } catch (IOException ignored) { }
            return error(500, "Internal Server Error");
        }
    }

    /** Un solo rango: "a-b", "a-" o "-n". Devuelve {inicio, fin} o null si no es satisfacible. */
    static long[] parseRange(String spec, long len) {
        int comma = spec.indexOf(',');
        if (comma >= 0) spec = spec.substring(0, comma).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String a = spec.substring(0, dash).trim(), b = spec.substring(dash + 1).trim();
            long s, e;
            if (a.isEmpty()) {
                long n = Long.parseLong(b);
                if (n <= 0) return null;
                s = Math.max(0, len - n);
                e = len - 1;
            } else {
                s = Long.parseLong(a);
                e = b.isEmpty() ? len - 1 : Math.min(Long.parseLong(b), len - 1);
            }
            if (s < 0 || s >= len || e < s) return null;
            return new long[]{s, e};
        } catch (NumberFormatException ex) {
            return null;
        }
    }
}
