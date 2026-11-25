package app.ccswitch.android;

import android.content.Context;
import android.net.Uri;
import org.json.JSONObject;
import java.io.File;
import java.lang.ref.WeakReference;

/** JNI transport only. Codex mutations and routes use the vendored upstream
 * Rust services; content URIs are resolved exclusively through TreeAccess. */
final class NativeCore {
    static { System.loadLibrary("cc_switch_android_core"); }
    interface Events { void emit(String event, String payload); }
    private static NativeCore instance;
    private final Context context;
    private volatile WeakReference<Events> events=new WeakReference<>(null);
    private boolean initialized;
    private boolean startupAttempted;
    private String startupError="";
    private NativeCore(Context context) { this.context=context.getApplicationContext(); }
    static synchronized NativeCore get(Context context, Events events) {
        if(instance==null)instance=new NativeCore(context);
        if(events!=null)instance.events=new WeakReference<>(events);
        return instance;
    }
    private native String initialize(String home, String legacy);
    private native String dispatch(String command, String args);
    synchronized JSONObject start(JSONObject legacy) throws Exception {
        File home=new File(context.getNoBackupFilesDir(),"upstream");
        if(!home.isDirectory()&&!home.mkdirs())throw new AppFailure("storage_unavailable","无法创建 CC Switch 数据目录。");
        JSONObject result=object(initialize(home.getAbsolutePath(),legacy.toString()));
        if(!initialized){
            String uri=context.getSharedPreferences("directory",Context.MODE_PRIVATE).getString("uri","");
            call("bindDocuments",new JSONObject().put("uri",uri));
            initialized=true;
        }
        return result;
    }
    void startup() throws Exception {
        synchronized(this){if(startupAttempted)return;startupAttempted=true;}
        String uri=context.getSharedPreferences("directory",Context.MODE_PRIVATE).getString("uri","");
        if(uri.isEmpty())return;
        try{
            access().info();
            JSONObject mode=(JSONObject)call("get_app_mode",new JSONObject());
            if(!"direct".equals(mode.optString("mode")))RouterService.start(context);
            else call("startup",new JSONObject());
            startupError="";
        }catch(Exception failure){startupError=failure.getMessage()==null?"启动恢复未完成，请检查目录授权。":failure.getMessage();}
    }
    synchronized void bind(String uri) throws Exception {
        call("bindDocuments",new JSONObject().put("uri",uri));
        startupAttempted=false;startupError="";
    }
    String startupError(){return startupError;}
    void clearEvents(Events listener){if(events.get()==listener)events.clear();}
    Object call(String command,JSONObject args) throws Exception { return value(dispatch(command,args.toString())); }
    private static Object value(String response) throws Exception {
        if(response==null)throw new AppFailure("native_error","原生后端未返回结果。");
        JSONObject result=new JSONObject(response);
        if(!result.optBoolean("ok"))throw new AppFailure("upstream_error",result.optString("error","上游后端返回错误"));
        return result.opt("result");
    }
    private static JSONObject object(String response) throws Exception {return (JSONObject)value(response);}
    private TreeAccess access() throws Exception {
        String uri=context.getSharedPreferences("directory",Context.MODE_PRIVATE).getString("uri","");
        return new TreeAccess(context,uri.isEmpty()?null:Uri.parse(uri));
    }
    public byte[] readDocument(String path) throws Exception { return access().readFile(path); }
    public void writeDocument(String path,byte[] bytes) throws Exception { access().writeNativeFile(path,bytes); }
    public void deleteDocument(String path) throws Exception { access().deleteNativeFile(path); }
    public void emit(String event,String payload) { Events listener=events.get();if(listener!=null)listener.emit(event,payload); }
}
