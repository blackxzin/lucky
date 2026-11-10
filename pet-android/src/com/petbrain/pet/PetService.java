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
import android.os.Bundle;
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
    static final String ACTION_VOICE = "com.petbrain.pet.VOICE";
    static final String ACTION_MIC_ON = "com.petbrain.pet.MIC_ON";
    private static final long HAPPY_MS = 4000;
    private static final int MAX_MIC_ERRORS = 5;
    private static final long MIC_RESTART_MS = 300;
    private static final long MIC_ERROR_RESTART_MS = 2000;
    private static final String CHANNEL_ID = "pet";
    private static final String APPROVAL_CHANNEL_ID = "pet-approvals";
    private static final int NOTIFICATION_ID = 1;
    private static final int APPROVAL_NOTIFICATION_ID = 2;
    private static final int TAP_SLOP_PX = 12;

    private static final String ERROR_PAGE = "<meta name=viewport content='width=device-width'>"
            + "<body style='background:#14161c;color:#eee;font-family:sans-serif;padding:24px'>"
            + "<h3>Não consegui falar com o hub</h3>"
            + "<p>Confira se o PC está ligado, se o hub está rodando, se o Tailscale está ativo no celular e se a URL do app Pet está certa.</p>"
            + "<button style='font-size:18px;padding:12px 24px' onclick='PetHost.minimize()'>Fechar</button></body>";

    private WindowManager windowManager;
    private PetBubble bubble;
    private WebView panel;
    private WindowManager.LayoutParams bubbleParams;
    private ApprovalWatcher watcher;
    private android.speech.SpeechRecognizer recognizer;
    private boolean micOn;
    private boolean wasBusy;
    private final Runnable listenAgain = this::listenOnce;
    private int micErrors;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopPet();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_MIC_ON.equals(intent.getAction())) {
            startMic();
            return START_STICKY;
        }
        new Prefs(this).setWantsRunning(true);
        // Tipo explícito: sem ele valem todos os do manifest, e o de microfone não pode começar em segundo plano.
        startForeground(NOTIFICATION_ID, notification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        if (bubble == null) showBubble();
        if (watcher == null) startWatcher();
        if (intent != null && ACTION_OPEN.equals(intent.getAction()) && panel == null) openPanel();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopMic();
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

    /** Manda ao chat o que foi ouvido. JSONObject.quote gera um literal JS seguro. */
    private void deliverVoice(String text) {
        if (text == null || panel == null) return;
        panel.evaluateJavascript("window.petVoice && window.petVoice(" + org.json.JSONObject.quote(text) + ")", null);
    }

    /** Painel fechado: o humor vem do hub. Pensando -> feliz por um instante ao terminar -> normal. */
    private void followBusy(boolean busy) {
        if (busy == wasBusy) return;
        wasBusy = busy;
        if (busy) {
            bubble.setMood("thinking");
        } else {
            bubble.setMood("happy");
            main.postDelayed(() -> { if (bubble != null && panel == null && !wasBusy) bubble.setMood("idle"); }, HAPPY_MS);
        }
    }

    private void tellPanelMic() {
        if (panel != null) panel.evaluateJavascript("window.petMic && window.petMic(" + micOn + ")", null);
    }

    /** Botão do microfone: liga se desligado, desliga se ligado. Sem permissão ainda, pede primeiro. */
    private void toggleMic() {
        if (micOn) {
            stopMic();
        } else if (checkSelfPermission("android.permission.RECORD_AUDIO") == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            startMic();
        } else {
            startActivity(new Intent(this, VoiceActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
    }

    private void startMic() {
        if (micOn || panel == null) return;
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
            android.widget.Toast.makeText(this, "Este celular não tem reconhecimento de voz.", android.widget.Toast.LENGTH_LONG).show();
            return;
        }
        micOn = true;
        micErrors = 0;
        startForeground(NOTIFICATION_ID, notification(),
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE | android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this);
        recognizer.setRecognitionListener(new MicListener());
        tellPanelMic();
        listenOnce();
    }

    private void stopMic() {
        main.removeCallbacks(listenAgain);
        boolean wasOn = micOn;
        micOn = false;
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        if (wasOn) {
            startForeground(NOTIFICATION_ID, notification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            tellPanelMic();
        }
    }

    private void listenOnce() {
        if (!micOn || recognizer == null) return;
        recognizer.startListening(new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "pt-BR")
                .putExtra(android.speech.RecognizerIntent.EXTRA_MAX_RESULTS, 1));
    }

    /** Escuta frase por frase enquanto o microfone está ligado; erros seguidos demais desligam. */
    private class MicListener implements android.speech.RecognitionListener {
        @Override public void onResults(Bundle results) {
            java.util.ArrayList<String> heard = results.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            micErrors = 0;
            if (heard != null && !heard.isEmpty()) deliverVoice(heard.get(0));
            main.postDelayed(listenAgain, MIC_RESTART_MS);
        }

        @Override public void onError(int error) {
            boolean quiet = error == android.speech.SpeechRecognizer.ERROR_NO_MATCH
                    || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT;
            if (error == android.speech.SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS || (!quiet && ++micErrors >= MAX_MIC_ERRORS)) {
                android.widget.Toast.makeText(PetService.this, "Microfone desligado: o reconhecimento de voz falhou.", android.widget.Toast.LENGTH_LONG).show();
                stopMic();
                return;
            }
            main.postDelayed(listenAgain, quiet ? MIC_RESTART_MS : MIC_ERROR_RESTART_MS);
        }

        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onPartialResults(Bundle partialResults) {}
        @Override public void onEvent(int eventType, Bundle params) {}
    }

    private void startWatcher() {
        watcher = new ApprovalWatcher(new Prefs(this), new ApprovalWatcher.Listener() {
            @Override
            public void onPending(int total, boolean hasNew, boolean anyDanger, boolean busy) { showApprovalNotice(total, hasNew, anyDanger, busy); }

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
    private void showApprovalNotice(int total, boolean hasNew, boolean anyDanger, boolean busy) {
        // Roda na thread do watcher: a bolinha só pode ser mexida na principal.
        main.post(() -> {
            if (bubble == null) return;
            bubble.setAlert(total > 0);
            if (panel == null) followBusy(busy); // com o painel aberto o rosto do chat manda no humor
        });
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
                .setContentTitle(micOn ? "Pet ligado · microfone ligado" : "Pet ligado")
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
        if (bubble != null) bubble.setMood(wasBusy ? "thinking" : "idle");
        stopMic(); // sem o painel aberto não há para onde mandar o que foi ouvido
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

            /** Hub fora do ar: em vez da página de erro do navegador (sem saída), mostra um aviso com botão de fechar. */
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                if (!request.isForMainFrame()) return;
                view.loadDataWithBaseURL(null, ERROR_PAGE, "text/html", "utf-8", null);
            }
        });
        panel.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public String getToken() { return prefs.token(); }

            /** Botão do microfone: liga/desliga (mutar e desmutar). */
            @JavascriptInterface
            public void listen() {
                main.post(PetService.this::toggleMic);
            }

            /** Humor e reações do rosto do chat, repetidos na bolinha. O nome é checado no PetBubble. */
            @JavascriptInterface
            public void mood(String name) {
                main.post(() -> { if (bubble != null) bubble.setMood(name); });
            }

            @JavascriptInterface
            public void fx(String name) {
                main.post(() -> { if (bubble != null) bubble.setFx(name); });
            }

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
