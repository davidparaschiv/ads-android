package ro.rezerva.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(ReservationQrPlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the WebView inside Android's usable system-bar area. CSS safe-area
        // insets remain the fallback for devices that enforce edge-to-edge.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
    }
}
