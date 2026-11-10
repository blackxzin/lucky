package com.petbrain.pet;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;

/** O bichinho desenhado em Canvas, pra bolha não precisar de imagens. */
final class PetBubble extends View {
    static final int SIZE_DP = 72;

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    PetBubble(Context context) {
        super(context);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        float w = getWidth();
        float h = getHeight();
        paint.setColor(0xFF7CC4FF);
        canvas.drawOval(w * 0.08f, h * 0.2f, w * 0.92f, h * 0.95f, paint);
        paint.setColor(0xFF10131A);
        canvas.drawCircle(w * 0.36f, h * 0.55f, w * 0.06f, paint);
        canvas.drawCircle(w * 0.64f, h * 0.55f, w * 0.06f, paint);
        paint.setStrokeWidth(w * 0.04f);
        canvas.drawLine(w * 0.5f, h * 0.2f, w * 0.5f, h * 0.08f, paint);
        paint.setColor(0xFFFFD166);
        canvas.drawCircle(w * 0.5f, h * 0.07f, w * 0.05f, paint);
    }
}
