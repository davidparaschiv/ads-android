package ro.rezerva.app;

import android.graphics.Bitmap;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import com.google.zxing.common.BitMatrix;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "ReservationQr")
public class ReservationQrPlugin extends Plugin {
    private final AtomicBoolean scanning = new AtomicBoolean(false);

    @PluginMethod
    public void render(PluginCall call) {
        Bitmap bitmap = null;
        try {
            BitMatrix matrix = ReservationQrCodec.encode(call.getString("value"));
            int width = matrix.getWidth(), height = matrix.getHeight();
            int[] pixels = new int[width * height];
            for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
                pixels[y * width + x] = matrix.get(x, y) ? 0xFF000000 : 0xFFFFFFFF;
            }
            bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes);
            JSObject result = new JSObject();
            result.put("dataUrl", "data:image/png;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (Exception ignored) {
            call.reject("Imaginea QR nu a putut fi creată.", "QR_RENDER_FAILED");
        } finally {
            if (bitmap != null) bitmap.recycle();
        }
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (getActivity() == null) { call.reject("Redeschide aplicația.", "SCAN_UNAVAILABLE"); return; }
        if (!scanning.compareAndSet(false, true)) { call.reject("Scanarea este deja deschisă.", "SCAN_BUSY"); return; }
        getActivity().runOnUiThread(() -> {
            try {
                if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) != ConnectionResult.SUCCESS) {
                    scanning.set(false);
                    call.reject("Actualizează Google Play services pentru scanare.", "SCAN_UNAVAILABLE");
                    return;
                }
                GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE).enableAutoZoom().build();
                // Google Play services owns the camera UI; no app CAMERA permission.
                GmsBarcodeScanning.getClient(getActivity(), options).startScan()
                    .addOnSuccessListener(barcode -> {
                        scanning.set(false);
                        String value = barcode.getRawValue();
                        if (value == null || value.trim().isEmpty()) {
                            call.reject("Codul QR nu conține o rezervare validă.", "SCAN_EMPTY");
                            return;
                        }
                        JSObject result = new JSObject();
                        result.put("value", value);
                        call.resolve(result);
                    })
                    .addOnCanceledListener(() -> {
                        scanning.set(false);
                        JSObject result = new JSObject(); result.put("cancelled", true); call.resolve(result);
                    })
                    .addOnFailureListener(error -> {
                        scanning.set(false);
                        call.reject("Scanarea nu este disponibilă. Verifică internetul și Google Play services, apoi reîncearcă.", "SCAN_UNAVAILABLE");
                    });
            } catch (Exception ignored) {
                scanning.set(false);
                call.reject("Scanarea nu a putut porni. Reîncearcă.", "SCAN_UNAVAILABLE");
            }
        });
    }
}
