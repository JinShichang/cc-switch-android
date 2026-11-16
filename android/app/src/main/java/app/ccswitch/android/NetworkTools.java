package app.ccswitch.android;

import org.json.*;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Explicit UI actions only. Never follows redirects with a supplier credential. */
final class NetworkTools {
    static String get(String address,String key,JSONObject headers,int limit)throws Exception{
        URL url=new URL(address);if(!Set.of("https","http").contains(url.getProtocol())||url.getUserInfo()!=null||url.getRef()!=null)throw new AppFailure("invalid_url","请输入有效的 HTTP(S) 地址。");
        HttpURLConnection c=(HttpURLConnection)url.openConnection();try{c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(30000);c.setRequestProperty("Accept","application/json");c.setRequestProperty("Accept-Encoding","identity");if(key!=null&&!key.isEmpty())c.setRequestProperty("Authorization","Bearer "+key);
        if(headers!=null){Iterator<String> it=headers.keys();while(it.hasNext()){String h=it.next();if(!Set.of("host","authorization","content-length","connection","transfer-encoding","cookie").contains(h.toLowerCase(Locale.ROOT)))c.setRequestProperty(h,headers.getString(h));}}
        int status=c.getResponseCode();if(status<200||status>=300)throw new AppFailure("http_error","HTTP "+status+"，请检查地址、密钥和服务商状态（未跟随重定向）。");
        try(InputStream in=c.getInputStream()){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];for(int n;(n=in.read(buf))!=-1;){if(out.size()+n>limit)throw new AppFailure("too_large","服务器响应超过大小限制。");out.write(buf,0,n);}return new String(out.toByteArray(),StandardCharsets.UTF_8);}
        }finally{c.disconnect();}
    }
    static JSONArray models(JSONObject args)throws Exception{
        String explicit=args.optString("modelsUrl"),base=args.getString("baseUrl");URL u=new URL(base);String p=u.getPath().replaceFirst("/+$","");if(args.optBoolean("isFullUrl"))p=p.replaceFirst("/(responses|chat/completions)$","");if(p.isEmpty())p="/v1";String target=explicit.isEmpty()?new URI(u.getProtocol(),null,u.getHost(),u.getPort(),p+"/models",u.getQuery(),null).toString():explicit;
        JSONObject headers=args.optJSONObject("requestHeaders");if(headers==null)headers=new JSONObject();String ua=args.optString("customUserAgent");if(!ua.isEmpty())headers.put("User-Agent",ua);
        JSONObject root=new JSONObject(get(target,args.optString("apiKey"),headers,8*1024*1024));JSONArray data=root.optJSONArray("data");if(data==null)data=root.optJSONArray("models");if(data==null)throw new AppFailure("model_format","服务器没有返回模型列表。");JSONArray result=new JSONArray();for(int i=0;i<Math.min(data.length(),5000);i++){JSONObject m=data.optJSONObject(i);if(m!=null){String id=m.optString("id",m.optString("slug"));if(!id.isEmpty())result.put(new JSONObject().put("id",id).put("ownedBy",m.opt("owned_by")));}}return result;
    }
    static JSONArray endpoints(JSONObject args)throws Exception{JSONArray list=args.getJSONArray("urls"),result=new JSONArray();if(list.length()>30)throw new AppFailure("limit","单次最多测 30 个地址。");for(int i=0;i<list.length();i++){String address=list.getString(i);JSONObject item=new JSONObject().put("url",address);HttpURLConnection c=null;long start=System.nanoTime();try{URL u=new URL(address);if(!Set.of("https","http").contains(u.getProtocol())||u.getUserInfo()!=null)throw new IOException();c=(HttpURLConnection)u.openConnection();c.setRequestMethod("HEAD");c.setInstanceFollowRedirects(false);c.setConnectTimeout(12000);c.setReadTimeout(12000);int status=c.getResponseCode();item.put("latency",(System.nanoTime()-start)/1000000).put("status",status);}catch(Exception e){item.put("latency",JSONObject.NULL).put("error","连接失败或超时");}finally{if(c!=null)c.disconnect();}result.put(item);}return result;}
    static JSONObject exchangeRates()throws Exception{JSONObject raw=new JSONObject(get("https://open.er-api.com/v6/latest/USD",null,null,1024*1024));return new JSONObject().put("rates",raw.getJSONObject("rates")).put("fetchedAt",System.currentTimeMillis()).put("source","open.er-api.com");}
}
