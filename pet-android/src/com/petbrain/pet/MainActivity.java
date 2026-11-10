package com.petbrain.pet;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/** Tela de configuração: URL do hub (Tailscale), token, permissões e liga/desliga. */
public class MainActivity extends Activity {
    private static final int PAD = 32;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Prefs prefs = new Prefs(this);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(PAD, PAD, PAD, PAD);

        TextView help = new TextView(this);
        help.setText("Hub do pet (ex.: http://100.x.y.z:8787) e o token de ~/.config/pet-brain/token");
        root.addView(help);

        EditText url = new EditText(this);
        url.setHint("http://100.x.y.z:8787");
        url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        url.setText(prefs.hubUrl());
        root.addView(url, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText token = new EditText(this);
        token.setHint("token");
        token.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        token.setText(prefs.token());
        root.addView(token, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button overlay = new Button(this);
        overlay.setText("Permitir sobre outros apps");
        overlay.setOnClickListener(v -> startActivity(new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()))));
        root.addView(overlay);

        Button battery = new Button(this);
        battery.setText("Não otimizar bateria (mantém o pet vivo)");
        battery.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)));
        root.addView(battery);

        Button start = new Button(this);
        start.setText("Ligar pet");
        start.setOnClickListener(v -> {
            String hub = url.getText().toString().trim();
            if (!isAllowedHub(hub)) {
                Toast.makeText(this, "Use https://, ou http:// com IP do Tailscale (100.64–127.x.x.x) ou 127.0.0.1.", Toast.LENGTH_LONG).show();
                return;
            }
            if (!Settings.canDrawOverlays(this)) {
                Toast.makeText(this, "Dê a permissão de sobrepor apps primeiro.", Toast.LENGTH_LONG).show();
                return;
            }
            prefs.save(hub, token.getText().toString().trim());
            requestNotificationPermission();
            startForegroundService(new Intent(this, PetService.class));
        });
        root.addView(start);

        Button stop = new Button(this);
        stop.setText("Desligar pet");
        stop.setOnClickListener(v -> startService(new Intent(this, PetService.class).setAction(PetService.ACTION_STOP)));
        root.addView(stop);

        setContentView(root);
    }

    /** https em qualquer host; http só para IP do Tailscale (100.64.0.0/10), que o WireGuard já cifra, ou 127.0.0.1 (USB via adb reverse). */
    static boolean isAllowedHub(String url) {
        Uri uri = Uri.parse(url);
        String host = uri.getHost();
        if (host == null) return false;
        if ("https".equals(uri.getScheme())) return true;
        if (!"http".equals(uri.getScheme())) return false;
        if ("127.0.0.1".equals(host)) return true; // loopback do próprio celular: só chega ao PC via `adb reverse` (USB)
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        try {
            int first = Integer.parseInt(parts[0]);
            int second = Integer.parseInt(parts[1]);
            return first == 100 && second >= 64 && second <= 127;
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS"}, 1);
        }
    }
}
