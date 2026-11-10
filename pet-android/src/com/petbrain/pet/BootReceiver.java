package com.petbrain.pet;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;

/** Depois de reiniciar o celular, religa o pet se o dono não tinha mandado parar. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        Prefs prefs = new Prefs(context);
        if (prefs.wantsRunning() && Settings.canDrawOverlays(context)) {
            context.startForegroundService(new Intent(context, PetService.class));
        }
    }
}
