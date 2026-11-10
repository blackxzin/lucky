package com.petbrain.pet;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Serviço em primeiro plano: bolha arrastável; tocar abre/fecha o painel (WebView do hub). */
public class PetService extends Service {
    static final String ACTION_STOP = "com.petbrain.pet.STOP";
    static final String ACTION_OPEN = "com.petbrain.pet.OPEN";
    private static final String CHANNEL_ID = "pet";
    private static final String APPROVAL_CHANNEL_ID = "pet-approvals";
    private static final int NOTIFICATION_ID = 1;
    private static final int APPROVAL_NOTIFICATION_ID = 2;
    private static final int TAP_SLOP_PX = 12;

    private WindowManager windowManager;
    private PetBubble bubble;
    private WebView panel;
    private WindowManager.LayoutParams bubbleParams;
    private ApprovalWatcher watcher;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopPet();
            return START_NOT_STICKY;
        }
        new Prefs(this).setWantsRunning(true);
        startForeground(NOTIFICATION_ID, notification());
        if (bubble == null) showBubble();
        if (watcher == null) startWatcher();
        if (intent != null && ACTION_OPEN.equals(intent.getAction()) && panel == null) openPanel();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWatcher();
        if (bubble != null) windowManager.removeView(bubble);
        if (panel != null) closePanel();
        bubble = null;
        super.onDestroy();
    }

    /** Parada pedida pelo dono: some de vez e não volta sozinho depois do reinício. */
    private void stopPet() {
        new Prefs(this).setWantsRunning(false);
        stopWatcher();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void startWatcher() {
        watcher = new ApprovalWatcher(new Prefs(this), new ApprovalWatcher.Listener() {
            @Override
            public void onPending(int total, boolean hasNew, boolean anyDanger) { showApprovalNotice(total, hasNew, anyDanger); }

            @Override
            public void onRejected() { showTokenRejectedNotice(); }
        });
        watcher.start();
    }

    private void stopWatcher() {
        if (watcher != null) watcher.stop();
        watcher = null;
        getSystemService(NotificationManager.class).cancel(APPROVAL_NOTIFICATION_ID);
    }

    /** O hub recusou o token: sem este aviso o dono ficaria sem notificações de aprovação e sem saber por quê. */
    private void showTokenRejectedNotice() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                APPROVAL_CHANNEL_ID, "Pedidos de aprovação", NotificationManager.IMPORTANCE_HIGH));
        manager.notify(APPROVAL_NOTIFICATION_ID, new Notification.Builder(this, APPROVAL_CHANNEL_ID)
                .setContentTitle("O pet não consegue falar com o hub")
                .setContentText("O hub recusou o token. Abra o app Pet e confira o token.")
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build());
    }

    /** Aviso de pedido de aprovação. Só diz quantos e se há algo perigoso; o detalhe fica no painel. */
    private void showApprovalNotice(int total, boolean hasNew, boolean anyDanger) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (total == 0) {
            manager.cancel(APPROVAL_NOTIFICATION_ID);
            return;
        }
        if (!hasNew) return;
        manager.createNotificationChannel(new NotificationChannel(
                APPROVAL_CHANNEL_ID, "Pedidos de aprovação", NotificationManager.IMPORTANCE_HIGH));
        Intent open = new Intent(this, PetService.class).setAction(ACTION_OPEN);
        PendingIntent openIntent = PendingIntent.getService(this, 1, open, PendingIntent.FLAG_IMMUTABLE);
        String text = total + (total == 1 ? " pedido esperando" : " pedidos esperando") + (anyDanger ? " (tem coisa perigosa)" : "");
        manager.notify(APPROVAL_NOTIFICATION_ID, new Notification.Builder(this, APPROVAL_CHANNEL_ID)
                .setContentTitle("O pet precisa da sua aprovação")
                .setContentText(text + ". Toque para abrir.")
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setContentIntent(openIntent)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .build());
    }

    private Notification notification() {
        Intent stop = new Intent(this, PetService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 0, stop, PendingIntent.FLAG_IMMUTABLE);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Pet", NotificationManager.IMPORTANCE_LOW));
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Pet ligado")
                .setSmallIcon(android.R.drawable.star_on)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Parar", stopIntent).build())
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
        bubbleParams = overlayParams(size, size,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
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

            /** Botão "—" do painel: fecha só a janela de chat; a bolinha continua. */
            @JavascriptInterface
            public void minimize() {
                new Handler(Looper.getMainLooper()).post(() -> { if (panel != null) closePanel(); });
            }

            /** "/parar" no chat: o dono mandou o pet parar de rodar. */
            @JavascriptInterface
            public void stop() {
                new Handler(Looper.getMainLooper()).post(PetService.this::stopPet);
            }
        }, "PetHost");

        WindowManager.LayoutParams params = overlayParams(
                WindowManager.LayoutParams.MATCH_PARENT, px(480), WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        params.gravity = Gravity.BOTTOM;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        windowManager.addView(panel, params);
        panel.loadUrl(hubUrl);
    }
}
