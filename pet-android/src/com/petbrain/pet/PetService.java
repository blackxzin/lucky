package com.petbrain.pet;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.IBinder;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Serviço em primeiro plano: bolha arrastável; tocar abre/fecha o painel (WebView do hub). */
public class PetService extends Service {
    private static final String CHANNEL_ID = "pet";
    private static final int NOTIFICATION_ID = 1;
    private static final int TAP_SLOP_PX = 12;

    private WindowManager windowManager;
    private PetBubble bubble;
    private WebView panel;
    private WindowManager.LayoutParams bubbleParams;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification());
        if (bubble == null) showBubble();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (bubble != null) windowManager.removeView(bubble);
        if (panel != null) closePanel();
        bubble = null;
        super.onDestroy();
    }

    private Notification notification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Pet", NotificationManager.IMPORTANCE_LOW));
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Pet ligado")
                .setSmallIcon(android.R.drawable.star_on)
                .build();
    }

    private int px(int dp) { return Math.round(dp * getResources().getDisplayMetrics().density); }

    private WindowManager.LayoutParams overlayParams(int width, int height, int flags) {
        return new WindowManager.LayoutParams(width, height,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, flags, PixelFormat.TRANSLUCENT);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void showBubble() {
        windowManager = getSystemService(WindowManager.class);
        bubble = new PetBubble(this);
        int size = px(PetBubble.SIZE_DP);
        bubbleParams = overlayParams(size, size, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        bubbleParams.gravity = Gravity.TOP | Gravity.START;
        bubbleParams.x = px(8);
        bubbleParams.y = px(200);

        bubble.setOnTouchListener(new android.view.View.OnTouchListener() {
            private float downX, downY;
            private int startX, startY;
            private boolean moved;

            @Override
            public boolean onTouch(android.view.View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX(); downY = event.getRawY();
                        startX = bubbleParams.x; startY = bubbleParams.y;
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (Math.abs(dx) > TAP_SLOP_PX || Math.abs(dy) > TAP_SLOP_PX) moved = true;
                        bubbleParams.x = startX + Math.round(dx);
                        bubbleParams.y = startY + Math.round(dy);
                        windowManager.updateViewLayout(bubble, bubbleParams);
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!moved) togglePanel();
                        return true;
                    default:
                        return false;
                }
            }
        });
        windowManager.addView(bubble, bubbleParams);
    }

    private void togglePanel() {
        if (panel != null) closePanel(); else openPanel();
    }

    private void closePanel() {
        windowManager.removeView(panel);
        panel.destroy();
        panel = null;
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void openPanel() {
        Prefs prefs = new Prefs(this);
        String hubUrl = prefs.hubUrl();
        if (!MainActivity.isAllowedHub(hubUrl)) return;
        String hubHost = Uri.parse(hubUrl).getAuthority();

        panel = new WebView(this);
        panel.getSettings().setJavaScriptEnabled(true);
        panel.getSettings().setAllowFileAccess(false);
        panel.getSettings().setAllowContentAccess(false);
        panel.setBackgroundColor(0xFF14161C);
        panel.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Só o hub carrega aqui; o token nunca chega a outra origem.
                return hubHost == null || !hubHost.equals(request.getUrl().getAuthority());
            }
        });
        panel.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String getToken() { return prefs.token(); }
        }, "PetHost");

        WindowManager.LayoutParams params = overlayParams(
                WindowManager.LayoutParams.MATCH_PARENT, px(480), WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        params.gravity = Gravity.BOTTOM;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        windowManager.addView(panel, params);
        panel.loadUrl(hubUrl);
    }
}
