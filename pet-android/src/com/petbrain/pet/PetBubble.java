package com.petbrain.pet;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.SystemClock;
import android.view.View;
import java.util.Random;

/** Telinha: tela escura com dois olhos quadrados que passeiam e piscam. Tudo em Canvas. */
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

    private long gazeAt;
    private long lastFrame;
    private float gazeX, gazeY, targetX, targetY;

    PetBubble(Context context) {
        super(context);
    }

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

        boolean blinking = now % BLINK_EVERY_MS < BLINK_LEN_MS;
        float eye = w * 0.14f;
        float eyeH = blinking ? eye * 0.12f : eye;
        float top = h * 0.43f + gazeY + (eye - eyeH) / 2;
        for (float left : new float[] {w * 0.29f, w * 0.57f}) {
            box(canvas, left + gazeX, top, left + gazeX + eye, top + eyeH, 0, 0xFF5FF2FF);
        }
        postInvalidateOnAnimation();
    }
}
