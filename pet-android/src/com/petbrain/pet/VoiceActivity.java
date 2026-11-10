package com.petbrain.pet;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.widget.Toast;

/** Só pede a permissão de microfone (o serviço não consegue pedir). Concedida, liga o microfone do pet. */
public class VoiceActivity extends Activity {
    private static final int REQUEST_MIC = 1;
    private static final String MIC_PERMISSION = "android.permission.RECORD_AUDIO";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) return; // recriada pelo sistema: o resultado já foi tratado
        requestPermissions(new String[] {MIC_PERMISSION}, REQUEST_MIC);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQUEST_MIC && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            startService(new Intent(this, PetService.class).setAction(PetService.ACTION_MIC_ON));
        } else {
            Toast.makeText(this, "Sem permissão de microfone. Libere em Configurações > Apps > Pet.", Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
