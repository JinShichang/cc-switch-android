package app.ccswitch.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import org.json.JSONObject;
import java.util.UUID;

/** User-started special-use FGS: continuous local HTTP relay for Codex. */
public final class FilterService extends Service {
    private static final Object LOCK=new Object();
    private static volatile FilterService instance;
    private static volatile String failure="";
    private volatile FilterServer server;
    private PowerManager.WakeLock wake;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable renew=new Runnable(){public void run(){if(server!=null){wake.acquire(10*60*1000L);handler.postDelayed(this,5*60*1000L);}}};
    private static EncryptedRepository vault(Context c)throws Exception{return new EncryptedRepository(c,"filter-routes.v1.enc");}
    public static JSONObject prepare(Context c,JSONObject args)throws Exception{
        String url=args.getString("url"),key=args.getString("apiKey");java.net.URL parsed=new java.net.URL(url);
        if(!java.util.Set.of("http","https").contains(parsed.getProtocol())||parsed.getUserInfo()!=null||parsed.getRef()!=null||key.isBlank()||key.matches("(?s).*[\r\n].*"))throw new AppFailure("invalid_route","中转需要有效的 Responses 地址和 API Key。");
        if(parsed.getHost().equals("127.0.0.1")&&parsed.getPort()==FilterServer.PORT)throw new AppFailure("proxy_loop","不能将过滤服务自身设为供应商。");
        String token=UUID.randomUUID().toString().replace("-","")+UUID.randomUUID().toString().replace("-","");
        synchronized(LOCK){EncryptedRepository v=vault(c);JSONObject data=v.copy();JSONObject routes=data.optJSONObject("routes");if(routes==null)routes=new JSONObject();if(routes.length()>=100)throw new AppFailure("route_limit","已保留 100 个中转路由，请先切回直连，再在后台运行设置中清理历史路由。");routes.put(token,new JSONObject(args.toString()));data.put("routes",routes).put("enabled",true);v.replace(data);if(instance!=null&&instance.server!=null)instance.server.setRoutes(routes);}
        start(c);return new JSONObject().put("baseUrl","http://127.0.0.1:"+FilterServer.PORT+"/r/"+token).put("token",token);
    }
    public static void start(Context c)throws Exception {synchronized(LOCK){EncryptedRepository v=vault(c);JSONObject d=v.copy();JSONObject r=d.optJSONObject("routes");if(r==null||r.length()==0)throw new AppFailure("no_filter_route","请先启用并应用一个历史过滤供应商方案。");d.put("enabled",true);v.replace(d);}failure="";c.startForegroundService(new Intent(c,FilterService.class));for(int i=0;i<100;i++){FilterService service=instance;if(service!=null&&service.server!=null)return;if(!failure.isEmpty())throw new AppFailure("filter_start_failed",failure);Thread.sleep(50);}throw new AppFailure("filter_start_timeout","中转服务没有就绪，未修改 Codex 配置。请允许后台运行后重试。");}
    public static void clear(Context c)throws Exception {synchronized(LOCK){if(instance!=null&&instance.server!=null)throw new AppFailure("filter_running","请先应用直连方案，确认中转停止后再清理。");EncryptedRepository v=vault(c);JSONObject d=v.copy();d.put("routes",new JSONObject()).put("enabled",false);v.replace(d);}}
    public static void stop(Context c)throws Exception {synchronized(LOCK){EncryptedRepository v=vault(c);JSONObject d=v.copy();d.put("enabled",false);v.replace(d);}c.stopService(new Intent(c,FilterService.class));for(int i=0;i<100&&instance!=null;i++)Thread.sleep(50);if(instance!=null)throw new AppFailure("filter_stop_timeout","直连配置已保存，但中转服务未及时停止。");}
    public static JSONObject routes(Context c)throws Exception {synchronized(LOCK){JSONObject r=vault(c).copy().optJSONObject("routes");return r==null?new JSONObject():r;}}
    public static JSONObject status()throws Exception{FilterService s=instance;return s!=null&&s.server!=null?s.server.status():new JSONObject().put("running",false).put("error",failure);}
    @Override public void onCreate(){super.onCreate();instance=this;NotificationManager nm=getSystemService(NotificationManager.class);nm.createNotificationChannel(new NotificationChannel("codex-filter","Codex 本机中转",NotificationManager.IMPORTANCE_LOW));Intent open=new Intent(this,MainActivity.class);PendingIntent intent=PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Notification n=new Notification.Builder(this,"codex-filter").setSmallIcon(R.drawable.ic_filter_notification).setContentTitle("CC Switch · 历史推理与ID过滤").setContentText("本机中转运行中；停止应用将中断 Codex 请求").setOngoing(true).setContentIntent(intent).build();if(Build.VERSION.SDK_INT>=34)startForeground(108,n,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(108,n);
        try{synchronized(LOCK){JSONObject data=vault(this).copy();JSONObject routes=data.optJSONObject("routes");if(!data.optBoolean("enabled")||routes==null||routes.length()==0)throw new Exception("尚未应用过滤方案");server=new FilterServer(FilterServer.PORT,routes);}wake=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"CCSwitch:CodexRelay");wake.setReferenceCounted(false);renew.run();}catch(Exception e){failure="本机中转启动失败（端口占用、设备未解锁或路由数据不可用）。请解锁并重新应用方案。";stopSelf();}}
    @Override public int onStartCommand(Intent i,int flags,int id){return server==null?START_NOT_STICKY:START_STICKY;}
    @Override public IBinder onBind(Intent i){return null;}
    @Override public void onDestroy(){handler.removeCallbacks(renew);if(server!=null){server.close();server=null;}if(wake!=null&&wake.isHeld())wake.release();instance=null;super.onDestroy();}
}
