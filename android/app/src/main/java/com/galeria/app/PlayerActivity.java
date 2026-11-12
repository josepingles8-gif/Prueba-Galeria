package com.galeria.app;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;

/** Reproductor nativo a pantalla completa para un video (content:// o file://). */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity {
    static final String EXTRA_URI = "uri";
    private static final String STATE_POS = "pos";
    private static final String STATE_PLAY = "play";

    private PlayerView view;
    private ExoPlayer player;
    private Uri uri;
    private long resumePos;
    private boolean resumePlay = true;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        String s = getIntent().getStringExtra(EXTRA_URI);
        uri = s == null ? null : Uri.parse(s);
        if (uri == null) {
            fail();
            return;
        }
        if (b != null) {
            resumePos = b.getLong(STATE_POS, 0);
            resumePlay = b.getBoolean(STATE_PLAY, true);
        }
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        WindowCompat.setDecorFitsSystemWindows(w, false);
        view = new PlayerView(this);
        view.setBackgroundColor(0xFF000000);
        view.setKeepScreenOn(true);
        view.setShowRewindButton(true);
        view.setShowFastForwardButton(true);
        view.setControllerShowTimeoutMs(3000);
        setContentView(view);
        hideSystemBars();
    }

    private void hideSystemBars() {
        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(getWindow(),
                getWindow().getDecorView());
        c.hide(WindowInsetsCompat.Type.systemBars());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && view != null) hideSystemBars();
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (uri != null && player == null) startPlayer();
    }

    private void startPlayer() {
        try {
            player = new ExoPlayer.Builder(this).build();
            player.addListener(new Player.Listener() {
                @Override
                public void onPlayerError(@NonNull PlaybackException error) {
                    fail();
                }
            });
            view.setPlayer(player);
            player.setMediaItem(MediaItem.fromUri(uri), resumePos);
            player.setPlayWhenReady(resumePlay);
            player.prepare();
        } catch (RuntimeException e) {
            fail();
        }
    }

    private void releasePlayer() {
        if (player != null) {
            resumePos = player.getCurrentPosition();
            resumePlay = player.getPlayWhenReady();
            if (view != null) view.setPlayer(null);
            player.release();
            player = null;
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle out) {
        super.onSaveInstanceState(out);
        long pos = player != null ? player.getCurrentPosition() : resumePos;
        out.putLong(STATE_POS, pos);
        out.putBoolean(STATE_PLAY, player != null ? player.getPlayWhenReady() : resumePlay);
    }

    @Override
    protected void onStop() {
        releasePlayer();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        releasePlayer();
        super.onDestroy();
    }

    private void fail() {
        Toast.makeText(this, R.string.video_error, Toast.LENGTH_LONG).show();
        finish();
    }
}
