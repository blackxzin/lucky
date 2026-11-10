package com.petbrain.pet;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;

/** Depois de reiniciar o celular ou de atualizar o app, religa o pet se o dono não tinha mandado parar. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        Prefs prefs = new Prefs(context);
        if (prefs.wantsRunning() && Settings.canDrawOverlays(context)) {
            context.startForegroundService(new Intent(context, PetService.class));
        }
    }
}
