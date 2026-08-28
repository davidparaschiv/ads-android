package ro.rezerva.app;

import static org.junit.Assert.*;
import org.junit.Test;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.decoder.Decoder;
import com.google.zxing.qrcode.detector.Detector;

public class ReservationQrCodecTest {
    private static final String PAYLOAD = "ro.rezerva.app://reservation?token=RZB-" + "A".repeat(64);

    @Test
    public void qrRoundTripAndQuietZone() throws Exception {
        BitMatrix image = ReservationQrCodec.encode(PAYLOAD);
        assertEquals(768, image.getWidth());
        assertEquals(768, image.getHeight());
        for (int i = 0; i < 768; i++) {
            assertFalse(image.get(i, 0)); assertFalse(image.get(0, i));
            assertFalse(image.get(i, 767)); assertFalse(image.get(767, i));
        }
        assertEquals(PAYLOAD, new Decoder().decode(new Detector(image).detect().getBits()).getText());
    }

    @Test
    public void rejectsOtherLinksAndPersonalData() {
        for (String value : new String[] {null, "https://example.com", "name@example.com", PAYLOAD + "&name=David", "RZB-" + "A".repeat(64)}) {
            assertThrows(IllegalArgumentException.class, () -> ReservationQrCodec.encode(value));
        }
    }
}
