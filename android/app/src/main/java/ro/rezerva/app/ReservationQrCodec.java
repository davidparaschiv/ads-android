package ro.rezerva.app;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;
import java.util.EnumMap;
import java.util.Map;

/** Pure Java QR encoding; no HTTP service, customer data or image upload. */
public final class ReservationQrCodec {
    private ReservationQrCodec() {}

    public static BitMatrix encode(String value) throws WriterException {
        if (value == null || !value.matches("ro\\.rezerva\\.app://reservation\\?token=RZB-[A-F0-9]{64}")) {
            throw new IllegalArgumentException("Invalid reservation QR payload");
        }
        Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
        hints.put(EncodeHintType.ERROR_CORRECTION, ErrorCorrectionLevel.M);
        hints.put(EncodeHintType.MARGIN, 4);
        return new QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 768, 768, hints);
    }
}
