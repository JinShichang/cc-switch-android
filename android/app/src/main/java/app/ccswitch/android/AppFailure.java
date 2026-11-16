package app.ccswitch.android;

final class AppFailure extends Exception {
    final String code;
    AppFailure(String code, String message) { super(message); this.code = code; }
}
