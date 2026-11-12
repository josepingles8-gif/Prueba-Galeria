package com.galeria.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.app.PendingIntent;
import android.app.RecoverableSecurityException;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.widget.Toast;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Puente JS -> Android. Los metodos se ejecutan en un hilo de WebView (no UI). */
public class AndroidBridge {
    private static final String DIR = "shared";
    private static final String ALBUM = "Galería";

    private static final class Entry {
        final File file;
        final String name;
        final String mime;
        FileOutputStream out;

        Entry(File file, String name, String mime) {
            this.file = file;
            this.name = name;
            this.mime = mime;
        }
    }

    private final MainActivity activity;
    private final Context app;
    private final Map<String, Entry> files = new ConcurrentHashMap<>();
    private final Object permLock = new Object();
    private String pendingSaveId;
    // Borrado de MediaStore en curso (un solo lote a la vez).
    private final Object delLock = new Object();
    private ArrayList<String> delTodo; // ids aun por borrar
    private final ArrayList<String> delDone = new ArrayList<>();
    private String delCurrent; // API 29: id esperando el permiso del usuario
    private boolean delWaitPerm; // API <= 28: esperando WRITE_EXTERNAL_STORAGE

    AndroidBridge(MainActivity activity) {
        this.activity = activity;
        this.app = activity.getApplicationContext();
        File dir = new File(app.getCacheDir(), DIR);
        deleteChildren(dir); // limpia restos de sesiones anteriores
    }

    private File dir() {
        File d = new File(app.getCacheDir(), DIR);
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    private static void deleteChildren(File dir) {
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    void cleanup() {
        for (Entry e : files.values()) closeQuietly(e);
        files.clear();
        deleteChildren(dir());
    }

    private static void closeQuietly(Entry e) {
        synchronized (e) {
            if (e.out != null) {
                try { e.out.close(); } catch (IOException ignored) { }
                e.out = null;
            }
        }
    }

    private static String sanitize(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.isEmpty() || n.equals(".") || n.equals("..")) n = "archivo";
        return n.length() > 100 ? n.substring(n.length() - 100) : n;
    }

    @JavascriptInterface
    public String beginFile(String name, String mime) {
        try {
            String id = java.util.UUID.randomUUID().toString();
            File sub = new File(dir(), id);
            //noinspection ResultOfMethodCallIgnored
            sub.mkdirs();
            File f = new File(sub, sanitize(name));
            Entry e = new Entry(f, f.getName(), mime == null || mime.isEmpty()
                    ? guessMime(f.getName()) : mime);
            e.out = new FileOutputStream(f);
            files.put(id, e);
            return id;
        } catch (Exception ex) {
            return "";
        }
    }

    @JavascriptInterface
    public boolean appendChunk(String id, String base64) {
        Entry e = id == null ? null : files.get(id);
        if (e == null || base64 == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            synchronized (e) {
                if (e.out == null) e.out = new FileOutputStream(e.file, true);
                e.out.write(bytes);
            }
            return true;
        } catch (Exception ex) {
            return false;
        }
    }

    @JavascriptInterface
    public void shareFiles(String jsonIds) {
        try {
            JSONArray arr = new JSONArray(jsonIds);
            ArrayList<Uri> uris = new ArrayList<>();
            ArrayList<String> mimes = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                Entry e = files.get(arr.getString(i));
                if (e == null) continue;
                closeQuietly(e);
                uris.add(FileProvider.getUriForFile(app, app.getPackageName() + ".fileprovider", e.file));
                mimes.add(e.mime);
            }
            if (uris.isEmpty()) return;
            Intent send;
            if (uris.size() == 1) {
                send = new Intent(Intent.ACTION_SEND);
                send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                send.setType(mimes.get(0));
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                send.setType(commonType(mimes));
            }
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, activity.getString(R.string.share_title));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // ClipData para que el permiso de lectura se conceda a todas las URIs.
            android.content.ClipData clip = android.content.ClipData.newRawUri(null, uris.get(0));
            for (int i = 1; i < uris.size(); i++) {
                clip.addItem(new android.content.ClipData.Item(uris.get(i)));
            }
            send.setClipData(clip);
            chooser.setClipData(clip);
            activity.runOnUiThread(() -> {
                try {
                    activity.startActivity(chooser);
                } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }

    private static String commonType(ArrayList<String> mimes) {
        String first = mimes.get(0);
        String major = first.contains("/") ? first.substring(0, first.indexOf('/')) : "*";
        for (String m : mimes) {
            if (!m.startsWith(major + "/")) return "*/*";
        }
        return major + "/*";
    }

    @JavascriptInterface
    public void saveFile(String id) {
        Entry e = id == null ? null : files.get(id);
        if (e == null) return;
        closeQuietly(e);
        if (Build.VERSION.SDK_INT >= 29) {
            doSave(e);
            return;
        }
        if (ContextCompat.checkSelfPermission(app, android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED) {
            doSave(e);
        } else {
            synchronized (permLock) { pendingSaveId = id; }
            activity.requestStoragePermission();
        }
    }

    void onStoragePermissionResult(boolean granted) {
        final boolean resumeDelete;
        synchronized (delLock) {
            resumeDelete = delWaitPerm;
            delWaitPerm = false;
        }
        if (resumeDelete) {
            if (granted) new Thread(this::processDeletes).start();
            else finishDelete();
            return;
        }
        final String id;
        synchronized (permLock) {
            id = pendingSaveId;
            pendingSaveId = null;
        }
        if (id == null) return;
        if (!granted) {
            toast(R.string.permission_denied);
            return;
        }
        final Entry e = files.get(id);
        if (e == null) return;
        new Thread(() -> doSave(e)).start();
    }

    private void doSave(Entry e) {
        boolean video = e.mime.startsWith("video/");
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = app.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, e.name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, e.mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES)
                                + "/" + ALBUM);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri collection = video
                        ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri uri = cr.insert(collection, v);
                if (uri == null) throw new IOException("insert failed");
                try (InputStream in = new java.io.FileInputStream(e.file);
                     OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) throw new IOException("no stream");
                    copy(in, out);
                } catch (IOException ex) {
                    cr.delete(uri, null, null);
                    throw ex;
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, done, null, null);
            } else {
                File base = Environment.getExternalStoragePublicDirectory(
                        video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES);
                File album = new File(base, ALBUM);
                if (!album.isDirectory() && !album.mkdirs()) throw new IOException("mkdirs");
                File dest = uniqueFile(album, e.name);
                try (InputStream in = new java.io.FileInputStream(e.file);
                     OutputStream out = new FileOutputStream(dest)) {
                    copy(in, out);
                }
                MediaScannerConnection.scanFile(app, new String[]{dest.getAbsolutePath()},
                        new String[]{e.mime}, (path, uri) -> notifyMediaChanged());
            }
            notifyMediaChanged();
            toast(R.string.saved);
        } catch (Exception ex) {
            toast(R.string.save_failed);
        }
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, stem + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return f;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private void toast(int res) {
        activity.runOnUiThread(() -> Toast.makeText(app, res, Toast.LENGTH_SHORT).show());
    }

    // ------------------------------------------------------------ MediaStore (fotos del telefono)

    private void notifyMediaChanged() {
        ContentResolver cr = app.getContentResolver();
        cr.notifyChange(MediaApi.IMAGES, null);
        cr.notifyChange(MediaApi.VIDEOS, null);
    }

    @JavascriptInterface
    public String hasMediaPermission() {
        return MediaApi.permissionState(app);
    }

    @JavascriptInterface
    public void requestMediaPermission() {
        activity.requestMediaPermission();
    }

    @JavascriptInterface
    public void openAppSettings() {
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", app.getPackageName(), null));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(i);
            } catch (Exception ignored) { }
        });
    }

    /** Ids validos ("i123"/"v456") de un array JSON. */
    private static ArrayList<String> parseIds(String json) {
        ArrayList<String> ids = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(json);
            for (int i = 0; i < a.length(); i++) {
                String id = a.optString(i, "");
                if (MediaApi.uriFor(id) != null && !ids.contains(id)) ids.add(id);
            }
        } catch (JSONException ignored) { }
        return ids;
    }

    @JavascriptInterface
    public void shareMedia(String jsonIds) {
        try {
            ArrayList<String> ids = parseIds(jsonIds);
            ContentResolver cr = app.getContentResolver();
            ArrayList<Uri> uris = new ArrayList<>();
            ArrayList<String> mimes = new ArrayList<>();
            for (String id : ids) {
                Uri u = MediaApi.uriFor(id);
                String m = null;
                try { m = cr.getType(u); } catch (RuntimeException ignored) { }
                uris.add(u);
                mimes.add(m != null ? m : id.charAt(0) == 'v' ? "video/*" : "image/*");
            }
            if (uris.isEmpty()) return;
            Intent send;
            if (uris.size() == 1) {
                send = new Intent(Intent.ACTION_SEND);
                send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                send.setType(mimes.get(0));
            } else {
                send = new Intent(Intent.ACTION_SEND_MULTIPLE);
                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                send.setType(commonType(mimes));
            }
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            android.content.ClipData clip = android.content.ClipData.newRawUri(null, uris.get(0));
            for (int i = 1; i < uris.size(); i++) {
                clip.addItem(new android.content.ClipData.Item(uris.get(i)));
            }
            send.setClipData(clip);
            Intent chooser = Intent.createChooser(send, activity.getString(R.string.share_title));
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            chooser.setClipData(clip);
            activity.runOnUiThread(() -> {
                try { activity.startActivity(chooser); } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public void deleteMedia(String jsonIds) {
        ArrayList<String> ids = parseIds(jsonIds);
        synchronized (delLock) {
            if (delTodo != null) { // ya hay un borrado en curso
                ids.clear();
            } else if (!ids.isEmpty()) {
                delTodo = ids;
                delDone.clear();
                delCurrent = null;
                delWaitPerm = false;
            }
        }
        if (ids.isEmpty()) {
            activity.callJs("window.__onMediaDeleted&&window.__onMediaDeleted([])");
            return;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            try {
                ArrayList<Uri> uris = new ArrayList<>();
                for (String id : ids) uris.add(MediaApi.uriFor(id));
                PendingIntent pi = MediaStore.createDeleteRequest(app.getContentResolver(), uris);
                activity.launchIntentSender(pi.getIntentSender());
            } catch (Exception e) {
                finishDelete();
            }
        } else {
            new Thread(this::processDeletes).start();
        }
    }

    /** Resultado del dialogo del sistema (createDeleteRequest en 30+, o permiso por archivo en 29). */
    void onDeleteResult(boolean ok) {
        if (Build.VERSION.SDK_INT >= 30) {
            synchronized (delLock) {
                if (ok && delTodo != null) delDone.addAll(delTodo);
            }
            finishDelete();
            return;
        }
        if (!ok) { finishDelete(); return; }
        new Thread(() -> {
            String id;
            synchronized (delLock) { id = delCurrent; delCurrent = null; }
            if (id != null) {
                try {
                    if (app.getContentResolver().delete(MediaApi.uriFor(id), null, null) > 0) {
                        synchronized (delLock) { delDone.add(id); }
                    }
                } catch (RuntimeException ignored) { }
                synchronized (delLock) { if (delTodo != null) delTodo.remove(id); }
            }
            processDeletes();
        }).start();
    }

    /** API <= 29: borra uno a uno; en 29 pide permiso al usuario con RecoverableSecurityException. */
    private void processDeletes() {
        ContentResolver cr = app.getContentResolver();
        if (Build.VERSION.SDK_INT < 29 && ContextCompat.checkSelfPermission(app,
                android.Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            synchronized (delLock) { delWaitPerm = true; }
            activity.requestStoragePermission();
            return;
        }
        while (true) {
            String id;
            synchronized (delLock) {
                if (delTodo == null || delTodo.isEmpty()) break;
                id = delTodo.get(0);
            }
            try {
                if (cr.delete(MediaApi.uriFor(id), null, null) > 0) {
                    synchronized (delLock) { delDone.add(id); }
                }
            } catch (SecurityException se) {
                if (Build.VERSION.SDK_INT >= 29 && se instanceof RecoverableSecurityException) {
                    IntentSender is = ((RecoverableSecurityException) se).getUserAction()
                            .getActionIntent().getIntentSender();
                    synchronized (delLock) { delCurrent = id; }
                    activity.launchIntentSender(is);
                    return; // continua en onDeleteResult
                }
            } catch (RuntimeException ignored) { }
            synchronized (delLock) { if (delTodo != null) delTodo.remove(id); }
        }
        finishDelete();
    }

    private void finishDelete() {
        JSONArray out = new JSONArray();
        synchronized (delLock) {
            for (String id : delDone) out.put(id);
            delDone.clear();
            delTodo = null;
            delCurrent = null;
            delWaitPerm = false;
        }
        notifyMediaChanged();
        activity.callJs("window.__onMediaDeleted&&window.__onMediaDeleted(" + out + ")");
    }

    @JavascriptInterface
    public void setTheme(boolean isDark) {
        activity.runOnUiThread(() -> activity.applyTheme(isDark));
    }

    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String m = MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase(Locale.ROOT));
            if (m != null) return m;
        }
        return "application/octet-stream";
    }
}
