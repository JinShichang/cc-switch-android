package app.ccswitch.android;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.os.*;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android lifetime adapter for the original CC Switch Rust proxy. */
public final class RouterService extends Service {
    private static volatile RouterService instance;
    private static volatile String error="";
    private static volatile java.util.concurrent.CountDownLatch teardown=new java.util.concurrent.CountDownLatch(0);
    private volatile boolean stopping;
    private volatile boolean ready;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock wake;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable renew=new Runnable(){public void run(){if(wake!=null&&!stopping){wake.acquire(600000);handler.postDelayed(this,300000);}}};
    static void start(Context context) throws Exception {
        if(!teardown.await(10,java.util.concurrent.TimeUnit.SECONDS))throw new AppFailure("router_start_failed","上一份路由仍在停止，请稍后重试。");
        if(instance!=null&&instance.ready&&!instance.stopping)return;
        error="";
        context.startForegroundService(new Intent(context,RouterService.class));
        for(int i=0;i<200;i++){if(instance!=null&&instance.ready&&!instance.stopping)return;if(!error.isEmpty())throw new AppFailure("router_start_failed",error);Thread.sleep(50);}
        throw new AppFailure("router_start_failed","本机路由未能启动，请检查后台运行权限。");
    }
    static void stop(Context context){
        RouterService active=instance;
        if(active!=null&&!active.stopping){active.stopping=true;teardown=new java.util.concurrent.CountDownLatch(1);}
        if(!context.stopService(new Intent(context,RouterService.class)))teardown.countDown();
    }
    @Override public void onCreate(){
        super.onCreate();
        instance=this;
        NotificationManager manager=getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("codex-router","Codex 本机路由",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(this,"codex-router").setSmallIcon(R.drawable.ic_filter_notification)
            .setContentTitle("CC Switch · 本机路由").setContentText("Codex 路由 / 聚合服务运行中").setOngoing(true).setContentIntent(open).build();
        if(Build.VERSION.SDK_INT>=34)startForeground(109,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(109,notification);
        worker.execute(()->{try{
            NativeCore core=NativeCore.get(this,null);core.start(new EncryptedRepository(this).copy());
            if(stopping)return;
            core.call("start_proxy_server",new JSONObject());
            if(stopping)return;
            // START_STICKY can recreate the service without an Activity. Settle
            // pending writes and attach the original saved mode here too.
            core.call("startup",new JSONObject());
            handler.post(()->{if(stopping)return;
                wake=getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"CCSwitch:Router");
                wake.setReferenceCounted(false);renew.run();ready=true;
            });
        }catch(Exception failure){error=failure.getMessage()==null?"本机路由启动失败，请检查端口和后台权限。":failure.getMessage();handler.post(this::stopSelf);}});
    }
    @Override public int onStartCommand(Intent intent,int flags,int id){return START_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){
        boolean requested=stopping;stopping=true;
        java.util.concurrent.CountDownLatch completion=requested?teardown:new java.util.concurrent.CountDownLatch(1);teardown=completion;
        handler.removeCallbacks(renew);if(wake!=null&&wake.isHeld())wake.release();if(instance==this)instance=null;
        worker.execute(()->{try{NativeCore.get(this,null).call(requested?"stopListener":"detach",new JSONObject());}catch(Exception failure){error="路由停止后的配置恢复未完成，重新打开 CC Switch 后重试。";}finally{completion.countDown();}});
        worker.shutdown();super.onDestroy();
    }
}
