package com.petbrain.pet;

import android.content.Context;
import android.content.SharedPreferences;

/** Guarda a URL do hub e o token. Fica no armazenamento privado do app (allowBackup=false). */
final class Prefs {
    private static final String FILE = "pet";
    private static final String KEY_URL = "hub_url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_RUNNING = "running";

    private final SharedPreferences prefs;

    Prefs(Context context) {
        prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    String hubUrl() { return prefs.getString(KEY_URL, ""); }
    String token() { return prefs.getString(KEY_TOKEN, ""); }

    /** O dono ligou o pet e ainda não mandou parar. Só ele muda isso. */
    boolean wantsRunning() { return prefs.getBoolean(KEY_RUNNING, false); }

    void setWantsRunning(boolean value) { prefs.edit().putBoolean(KEY_RUNNING, value).apply(); }

    void save(String hubUrl, String token) {
        prefs.edit().putString(KEY_URL, hubUrl).putString(KEY_TOKEN, token).apply();
    }
}
