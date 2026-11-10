package com.petbrain.pet;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;
import java.util.Random;

/**
 * Telinha: tela escura com dois olhos quadrados que passeiam e piscam. Tudo em Canvas.
 * Repete os humores e reações do rosto do chat (ui/style.css): idle, thinking, happy, alert, sleeping e as
 * reações blink, surprised, confused, yawn. O humor vem do painel; sem painel só valem alerta e sono.
 */
final class PetBubble extends View {
    static final int SIZE_DP = 72;

    private static final long GAZE_MS = 2200;
    private static final long BLINK_EVERY_MS = 5000;
    private static final long BLINK_LEN_MS = 140;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF rect = new RectF();
    private final Random random = new Random();

    private static final float GAZE_SMOOTH_MS = 90f;
    private static final long MAX_FRAME_MS = 100;

    private static final long SURPRISE_EVERY_MS = 1400;
    private static final long SURPRISE_LEN_MS = 350;
    private static final int EYE_COLOR = 0xFF5FF2FF;
    private static final int ALERT_COLOR = 0xFFFF6B6B;
    private static final int THINKING_COLOR = 0xFFFFD166;
    private static final int HAPPY_COLOR = 0xFF6BDC8B;
    private static final int SLEEP_COLOR = 0xFF2D6F76;
    private static final long SLEEP_AFTER_MS = 5 * 60 * 1000;

    private volatile boolean alert;
    private volatile String mood = "idle";
    private volatile String fxName = "";
    private volatile long fxStart;
    private volatile long moodSince = SystemClock.uptimeMillis();
    private long gazeAt;
    private long lastFrame;
    private float gazeX, gazeY, targetX, targetY;

    PetBubble(Context context) {
        super(context);
    }

    /** Pedido de aprovação esperando (vindo do aviso de fundo, vale mesmo com o painel fechado). */
    void setAlert(boolean on) {
        alert = on;
    }

    /** Humor do rosto do chat: idle, thinking, happy, alert ou sleeping. */
    void setMood(String name) {
        mood = name;
        moodSince = SystemClock.uptimeMillis();
    }

    /** Reação curta por cima do humor. */
    void setFx(String name) {
        fxName = name;
        fxStart = SystemClock.uptimeMillis();
    }

    private static long fxLength(String name) {
        switch (name) {
            case "blink": return 450;
            case "surprised": return 600;
            case "confused": return 1600;
            case "yawn": return 1500;
            default: return 0;
        }
    }

    private static float lerp(float a, float b, float t) { return a + (b - a) * t; }

    private void box(Canvas c, float l, float t, float r, float b, float radius, int color) {
        paint.setColor(color);
        rect.set(l, t, r, b);
        c.drawRoundRect(rect, radius, radius, paint);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth();
        float h = getHeight();
        long now = SystemClock.uptimeMillis();

        if (now - gazeAt > GAZE_MS) {
            gazeAt = now;
            boolean rest = random.nextFloat() < 0.3f;
            targetX = rest ? 0 : (random.nextFloat() * 2 - 1) * w * 0.07f;
            targetY = rest ? 0 : (random.nextFloat() * 2 - 1) * h * 0.04f;
        }
        // Suavização pelo tempo real do quadro: mesma velocidade em 60, 90 ou 120 Hz.
        long dt = lastFrame == 0 ? 0 : Math.min(now - lastFrame, MAX_FRAME_MS);
        lastFrame = now;
        float k = 1f - (float) Math.exp(-dt / GAZE_SMOOTH_MS);
        gazeX += (targetX - gazeX) * k;
        gazeY += (targetY - gazeY) * k;

        box(canvas, w * 0.06f, h * 0.22f, w * 0.94f, h * 0.78f, w * 0.09f, 0xFF2A2F3B);
        box(canvas, w * 0.13f, h * 0.29f, w * 0.87f, h * 0.71f, w * 0.04f, 0xFF06090D);

        String current = alert ? "alert" : mood;
        if ("idle".equals(current) && now - moodSince > SLEEP_AFTER_MS) current = "sleeping";
        String fx = fxName;
        long fxLen = fxLength(fx);
        float f = fxLen > 0 && now - fxStart < fxLen ? (now - fxStart) / (float) fxLen : -1f;

        int color = EYE_COLOR;
        float scaleX = 1f, scaleY = 1f, lift = 0f, shake = 0f;
        boolean still = false;
        switch (current) {
            case "thinking": color = THINKING_COLOR; scaleY = 0.5f; break;
            case "happy":
                color = HAPPY_COLOR; scaleY = 0.45f;
                lift = -w * 0.04f - (float) Math.abs(Math.sin(now / 190.0)) * w * 0.03f;
                break;
            case "alert":
                color = ALERT_COLOR;
                scaleX = scaleY = 1f + 0.25f * (float) Math.abs(Math.sin(now / 160.0));
                shake = (now % 400 < 200 ? -1f : 1f) * w * 0.02f;
                break;
            case "sleeping": color = SLEEP_COLOR; scaleY = 0.12f; still = true; break;
            default:
                if (now % BLINK_EVERY_MS < BLINK_LEN_MS) scaleY = 0.12f;
        }

        float leftScale = 1f, rightScale = 1f, leftTurn = 0f, rightTurn = 0f;
        if (f >= 0f) {
            switch (fx) {
                case "blink": scaleY = f < 0.25f || (f > 0.42f && f < 0.6f) ? 0.08f : 1f; break;
                case "surprised": {
                    float grow = f < 0.3f ? lerp(1f, 1.4f, f / 0.3f) : lerp(1.4f, 1f, (f - 0.3f) / 0.7f);
                    scaleX *= grow; scaleY *= grow; break;
                }
                case "confused": leftScale = 0.7f; leftTurn = -12f; rightScale = 1.15f; rightTurn = 8f; break;
                case "yawn": scaleY = f < 0.35f ? lerp(1f, 0.2f, f / 0.35f) : f < 0.6f ? lerp(0.2f, 0.55f, (f - 0.35f) / 0.25f) : lerp(0.55f, 0.12f, (f - 0.6f) / 0.4f); break;
                default: break;
            }
        }

        float eye = w * 0.14f;
        float cy = h * 0.43f + eye / 2 + (still ? 0 : gazeY) + lift;
        float[] lefts = {w * 0.29f, w * 0.57f};
        for (int n = 0; n < 2; n++) {
            float cx = lefts[n] + eye / 2 + (still ? 0 : gazeX) + shake;
            float extra = n == 0 ? leftScale : rightScale;
            canvas.save();
            canvas.translate(cx, cy);
            canvas.rotate(n == 0 ? leftTurn : rightTurn);
            canvas.scale(scaleX * extra, scaleY * extra);
            box(canvas, -eye / 2, -eye / 2, eye / 2, eye / 2, 0, color);
            canvas.restore();
        }
        postInvalidateOnAnimation();
    }
}
