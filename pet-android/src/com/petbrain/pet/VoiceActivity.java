package com.petbrain.pet;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.widget.Toast;
import java.util.ArrayList;

/**
 * Voz só com a tela do Google visível: o app NÃO tem permissão de microfone, então não consegue ouvir sozinho.
 * Abre o reconhecimento de voz do Google, devolve o texto ao serviço (que o coloca no campo do chat) e o dono
 * confere antes de enviar. Sem essa tela no celular, avisa e deixa o microfone do teclado como caminho.
 */
public class VoiceActivity extends Activity {
    private static final int REQUEST_SPEECH = 1;
    private static final String LANGUAGE = "pt-BR";
    private static final String GOOGLE_APP = "com.google.android.googlequicksearchbox";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) return; // recriada pelo sistema: o resultado já foi tratado
        Intent speech = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, LANGUAGE)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                .putExtra(RecognizerIntent.EXTRA_PROMPT, "Fala com o pet");
        ResolveInfo handler = getPackageManager().resolveActivity(speech, 0);
        if (handler == null || !GOOGLE_APP.equals(handler.activityInfo.packageName)) {
            Toast.makeText(this, "Sem a tela de voz do Google. Use o microfone do teclado.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        try {
            startActivityForResult(speech, REQUEST_SPEECH);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Sem a tela de voz do Google. Use o microfone do teclado.", Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SPEECH && resultCode == RESULT_OK && data != null) {
            ArrayList<String> heard = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (heard != null && !heard.isEmpty()) {
                startService(new Intent(this, PetService.class).setAction(PetService.ACTION_VOICE).putExtra(PetService.EXTRA_TEXT, heard.get(0)));
            }
        }
        finish();
    }
}
