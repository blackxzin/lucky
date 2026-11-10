package com.petbrain.pet;

import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;

/**
 * Consulta o hub a cada poucos segundos e avisa quando chega pedido de aprovação novo.
 * O celular não mantém o WebSocket aberto com o painel fechado; este aviso cobre esse caso.
 * O hub só devolve id, ferramenta e risco (a notificação aparece até na tela bloqueada).
 */
final class ApprovalWatcher {
    interface Listener {
        /** Chamado fora da thread principal. `hasNew` é true quando surgiu um pedido que ainda não tinha sido avisado. */
        void onPending(int total, boolean hasNew, boolean anyDanger);

        /** O hub recusou o token (401). O watcher para de consultar: insistir só trava o celular fora do próprio hub. */
        void onRejected();
    }

    private static final String TAG = "PetWatcher";
    private static final long POLL_MS = 15_000;
    private static final int TIMEOUT_MS = 5_000;
    private static final long LOCKED_OUT_POLL_MS = 90_000;
    private static final int MAX_BODY_BYTES = 16 * 1024;
    private static final String PENDING_PATH = "/api/pending";

    private final Prefs prefs;
    private final Listener listener;
    private final HandlerThread thread = new HandlerThread("pet-approval-watcher");
    private Handler handler;
    private Set<String> known = new HashSet<>();
    private volatile boolean running;

    ApprovalWatcher(Prefs prefs, Listener listener) {
        this.prefs = prefs;
        this.listener = listener;
    }

    void start() {
        if (running) return;
        running = true;
        thread.start();
        handler = new Handler(thread.getLooper());
        handler.post(this::poll);
    }

    void stop() {
        running = false;
        if (handler != null) handler.removeCallbacksAndMessages(null);
        thread.quitSafely();
    }

    private void poll() {
        if (!running) return;
        long next = POLL_MS;
        try {
            int status = check();
            if (status == 401) {
                running = false;
                listener.onRejected();
                return;
            }
            // 429: o hub travou este endereço por tentativas erradas. Esperar mais; insistir prolonga a trava.
            if (status == 429) next = LOCKED_OUT_POLL_MS;
        } catch (Exception error) {
            // Sem rede ou hub fora do ar: tenta de novo no próximo ciclo. Nunca loga a URL nem o token.
            Log.d(TAG, "falha ao consultar o hub: " + error.getClass().getSimpleName());
        }
        if (running) handler.postDelayed(this::poll, next);
    }

    /** Devolve o código HTTP (0 se nada foi consultado). */
    private int check() throws Exception {
        String hubUrl = prefs.hubUrl();
        String token = prefs.token();
        if (!MainActivity.isAllowedHub(hubUrl) || token.isEmpty()) return 0;

        HttpURLConnection connection = (HttpURLConnection) new URL(trimSlash(hubUrl) + PENDING_PATH).openConnection();
        try {
            connection.setConnectTimeout(TIMEOUT_MS);
            connection.setReadTimeout(TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            if (status != 200) return status;
            report(new JSONObject(readBody(connection.getInputStream())).getJSONArray("approvals"));
            return status;
        } finally {
            connection.disconnect();
        }
    }

    private void report(JSONArray approvals) throws Exception {
        // stop() pode ter rodado durante a consulta: não avisa depois de desligado.
        if (!running) return;
        Set<String> current = new HashSet<>();
        boolean hasNew = false;
        boolean anyDanger = false;
        for (int index = 0; index < approvals.length(); index++) {
            JSONObject approval = approvals.getJSONObject(index);
            String id = approval.getString("id");
            current.add(id);
            hasNew |= !known.contains(id);
            anyDanger |= "danger".equals(approval.optString("risk"));
        }
        known = current;
        listener.onPending(current.size(), hasNew, anyDanger);
    }

    private static String trimSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private static String readBody(InputStream input) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[2048];
        int read;
        while ((read = input.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_BODY_BYTES) throw new IllegalStateException("resposta grande demais");
        }
        return out.toString("UTF-8");
    }
}
