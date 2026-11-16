package app.ccswitch.android;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import java.util.zip.*;
import org.brotli.dec.BrotliInputStream;
import com.github.luben.zstd.ZstdInputStream;

/** Loopback-only Responses relay. No POST retries, redirects, body logs or credential logs. */
public final class FilterServer implements AutoCloseable {
    public static final int PORT=18181, LIMIT=64*1024*1024;
    private final ServerSocket server;
    private final ExecutorService workers=new ThreadPoolExecutor(0,4,30,TimeUnit.SECONDS,new SynchronousQueue<>());
    private final Set<Socket> clients=ConcurrentHashMap.newKeySet();
    private final Set<HttpURLConnection> connections=ConcurrentHashMap.newKeySet();
    private volatile JSONObject routes=new JSONObject();
    private volatile boolean closed;
    public final AtomicLong requests=new AtomicLong(),filtered=new AtomicLong(),reasoning=new AtomicLong(),ids=new AtomicLong(),blocked=new AtomicLong(),httpErrors=new AtomicLong();
    private volatile long lastFilteredAt;
    private volatile int lastStatus;
    public FilterServer(int port,JSONObject routes) throws Exception {
        this.routes=new JSONObject(routes.toString());server=new ServerSocket();server.setReuseAddress(true);server.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),port),16);
        Thread accept=new Thread(()->{while(!closed)try{Socket socket=server.accept();socket.setSoTimeout(30000);clients.add(socket);try{workers.execute(()->handle(socket));}catch(RejectedExecutionException e){socket.close();clients.remove(socket);}}catch(IOException ignored){}},"cc-switch-filter");accept.setDaemon(true);accept.start();
    }
    public void setRoutes(JSONObject next) throws Exception {routes=new JSONObject(next.toString());}
    public int port(){return server.getLocalPort();}
    public JSONObject status() throws Exception{return new JSONObject().put("running",!closed).put("port",port()).put("requests",requests.get()).put("filteredRequests",filtered.get()).put("removedReasoningItems",reasoning.get()).put("removedItemIds",ids.get()).put("blockedRequests",blocked.get()).put("upstreamHttpErrors",httpErrors.get()).put("lastFilteredAt",lastFilteredAt).put("lastUpstreamStatus",lastStatus);}
    private static final Set<String> HOP=Set.of("connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host","content-length","expect","accept-encoding");
    private static String line(InputStream in,int max) throws IOException {ByteArrayOutputStream b=new ByteArrayOutputStream();int c;while((c=in.read())!=-1){if(c=='\n')break;if(b.size()>=max)throw new IOException("Header limit");b.write(c);}if(c==-1&&b.size()==0)return null;return new String(b.toByteArray(),StandardCharsets.US_ASCII).replaceFirst("\r$","");}
    private static byte[] bounded(InputStream in,int limit)throws IOException,HistoryFilter.Failure{ByteArrayOutputStream b=new ByteArrayOutputStream();byte[] buf=new byte[8192];for(int n;(n=in.read(buf))!=-1;){if(b.size()>limit-n)throw new HistoryFilter.Failure(413,"request_too_large","请求超过过滤服务大小限制。");b.write(buf,0,n);}return b.toByteArray();}
    private static byte[] requestBody(InputStream in,Map<String,String> h)throws Exception{
        if(h.containsKey("transfer-encoding")){if(h.containsKey("content-length")||!h.get("transfer-encoding").equalsIgnoreCase("chunked"))throw new HistoryFilter.Failure(400,"invalid_framing","不支持的请求分帧。");ByteArrayOutputStream b=new ByteArrayOutputStream();while(true){String l=line(in,100);if(l==null)throw new EOFException();long n=Long.parseLong(l.split(";",2)[0].trim(),16);if(n<0||n>LIMIT-b.size())throw new HistoryFilter.Failure(413,"request_too_large","请求超过大小限制。");if(n==0){for(int count=0;;count++){String trailer=line(in,8192);if(trailer==null||count>64)throw new IOException();if(trailer.isEmpty())break;}return b.toByteArray();}byte[] chunk=new byte[(int)n];int got=0;while(got<n){int read=in.read(chunk,got,(int)n-got);if(read<0)throw new EOFException();got+=read;}b.write(chunk);if(!"".equals(line(in,2)))throw new IOException();}}
        long n=Long.parseLong(h.getOrDefault("content-length","0"));if(n<0||n>LIMIT)throw new HistoryFilter.Failure(413,"request_too_large","请求超过大小限制。");byte[] bytes=new byte[(int)n];int got=0;while(got<n){int read=in.read(bytes,got,(int)n-got);if(read<0)throw new EOFException();got+=read;}return bytes;
    }
    private static byte[] decode(byte[] bytes,String encoding)throws Exception{InputStream in=new ByteArrayInputStream(bytes);switch(encoding.toLowerCase(Locale.ROOT)){case "":case "identity":return bytes;case "gzip":in=new GZIPInputStream(in);break;case "deflate":in=new InflaterInputStream(in);break;case "br":in=new BrotliInputStream(in);break;case "zstd":try{in=new ZstdInputStream(in);}catch(LinkageError e){throw new HistoryFilter.Failure(503,"decoder_unavailable","zstd 解压器不可用，请更新 CC Switch 或在 Codex 停用请求压缩。");}break;default:throw new HistoryFilter.Failure(415,"unsupported_content_encoding","不支持的请求压缩格式。");}try(InputStream decoded=in){return bounded(decoded,LIMIT);}}
    private static void error(OutputStream out,int status,String code,String message)throws IOException {try{byte[] body=new JSONObject().put("error",new JSONObject().put("type","invalid_request_error").put("code",code).put("message",message)).toString().getBytes(StandardCharsets.UTF_8);out.write(("HTTP/1.1 "+status+" Error\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\nContent-Length: "+body.length+"\r\n\r\n").getBytes(StandardCharsets.US_ASCII));out.write(body);out.flush();}catch(org.json.JSONException impossible){throw new IOException(impossible);}}
    private void handle(Socket socket){HttpURLConnection upstream=null;boolean sent=false;AtomicBoolean finished=new AtomicBoolean();try{InputStream in=new BufferedInputStream(socket.getInputStream());OutputStream out=socket.getOutputStream();
        String first=line(in,8192);if(first==null)return;String[] request=first.split(" ");if(request.length!=3||!request[2].equals("HTTP/1.1"))throw new HistoryFilter.Failure(400,"invalid_request","需要 HTTP/1.1。");
        Map<String,String> h=new LinkedHashMap<>();int total=0;for(int count=0;;count++){String l=line(in,8192);if(l==null)throw new EOFException();if(l.isEmpty())break;total+=l.length();if(count>96||total>32768)throw new IOException();int colon=l.indexOf(':');if(colon<1||Character.isWhitespace(l.charAt(0)))throw new IOException();String key=l.substring(0,colon).toLowerCase(Locale.ROOT);if(h.putIfAbsent(key,l.substring(colon+1).trim())!=null)throw new HistoryFilter.Failure(400,"duplicate_header","不接受重复请求头。");}
        if(h.containsKey("origin")||h.containsKey("sec-fetch-site"))throw new HistoryFilter.Failure(403,"browser_request_rejected","本机中转不接受浏览器请求。");
        if(h.containsKey("upgrade"))throw new HistoryFilter.Failure(426,"websocket_disabled","历史过滤需要 HTTP Responses 流；请停用 Codex WebSocket 传输后重试。");
        String target=request[1];if(!target.matches("/r/[A-Za-z0-9_-]+/responses(?:/compact)?/?(?:\\?.*)?"))throw new HistoryFilter.Failure(404,"unknown_route","本机中转仅支持 Responses。");
        String token=target.split("/",4)[2];JSONObject route=routes.optJSONObject(token);if(route==null)throw new HistoryFilter.Failure(403,"route_unavailable","中转路由不存在，请回 CC Switch 重新应用方案。");
        if(!MessageDigest.isEqual(("Bearer "+token).getBytes(StandardCharsets.UTF_8),h.getOrDefault("authorization","").getBytes(StandardCharsets.UTF_8)))throw new HistoryFilter.Failure(403,"local_auth_failed","本机中转凭据不匹配。");
        if(!request[0].equals("POST"))throw new HistoryFilter.Failure(405,"method_not_allowed","仅支持 POST Responses。");
        if(target.split("\\?",2)[0].replaceFirst("/$","").endsWith("/compact"))throw new HistoryFilter.Failure(409,"encrypted_compaction_disabled","历史过滤不支持加密远程压缩。请用文本摘要开启新会话。");
        if("100-continue".equalsIgnoreCase(h.get("expect"))){out.write("HTTP/1.1 100 Continue\r\n\r\n".getBytes(StandardCharsets.US_ASCII));out.flush();}
        JSONObject json;try{json=new JSONObject(new String(decode(requestBody(in,h),h.getOrDefault("content-encoding","identity")),StandardCharsets.UTF_8));}catch(HistoryFilter.Failure e){throw e;}catch(Exception e){throw new HistoryFilter.Failure(400,"invalid_request_json","请求 JSON 或压缩数据无效。");}
        JSONObject overrides=route.optJSONObject("body");if(overrides!=null){Iterator<String> it=overrides.keys();while(it.hasNext()){String k=it.next();if(Set.of("stream","input","previous_response_id","conversation","context_management").contains(k))throw new HistoryFilter.Failure(400,"unsafe_override","不能覆盖历史或流式协议字段。");json.put(k,overrides.get(k));}}
        HistoryFilter.Result clean=HistoryFilter.filter(json);filtered.incrementAndGet();reasoning.addAndGet(clean.reasoning());ids.addAndGet(clean.ids());lastFilteredAt=System.currentTimeMillis();
        byte[] payload=clean.body().toString().getBytes(StandardCharsets.UTF_8);URL url=new URL(route.getString("url"));if(!Set.of("https","http").contains(url.getProtocol())||url.getUserInfo()!=null)throw new IOException();if(url.getHost().equals("127.0.0.1")&&url.getPort()==port())throw new HistoryFilter.Failure(503,"proxy_loop","不能把本机过滤服务作为上游。");
        upstream=(HttpURLConnection)url.openConnection();connections.add(upstream);upstream.setInstanceFollowRedirects(false);upstream.setConnectTimeout(20000);upstream.setReadTimeout(300000);upstream.setRequestMethod("POST");upstream.setDoOutput(true);upstream.setFixedLengthStreamingMode(payload.length);
        Set<String> hop=new HashSet<>(HOP);for(String name:h.getOrDefault("connection","").split(","))hop.add(name.trim().toLowerCase(Locale.ROOT));
        for(var entry:h.entrySet())if(!hop.contains(entry.getKey())&&!Set.of("authorization","content-encoding","cookie","chatgpt-account-id","x-api-key").contains(entry.getKey()))upstream.setRequestProperty(entry.getKey(),entry.getValue());
        JSONObject extra=route.optJSONObject("headers");if(extra!=null){Iterator<String> it=extra.keys();while(it.hasNext()){String k=it.next();if(!hop.contains(k.toLowerCase(Locale.ROOT))&&!k.equalsIgnoreCase("authorization"))upstream.setRequestProperty(k,extra.getString(k));}}
        upstream.setRequestProperty("Authorization","Bearer "+route.getString("apiKey"));upstream.setRequestProperty("Content-Type","application/json");upstream.setRequestProperty("Accept-Encoding","identity");requests.incrementAndGet();
        final HttpURLConnection active=upstream;socket.setSoTimeout(1000);Thread cancel=new Thread(()->{while(!finished.get())try{if(in.read()==-1){if(!finished.get())active.disconnect();return;}}catch(SocketTimeoutException ignored){}catch(IOException e){if(!finished.get())active.disconnect();return;}},"cc-filter-cancel");cancel.setDaemon(true);cancel.start();
        try(OutputStream body=upstream.getOutputStream()){body.write(payload);}int status=upstream.getResponseCode();lastStatus=status;if(status>=400)httpErrors.incrementAndGet();
        out.write(("HTTP/1.1 "+status+" Upstream\r\nConnection: close\r\n").getBytes(StandardCharsets.US_ASCII));Set<String> responseHop=new HashSet<>(HOP);String connection=upstream.getHeaderField("Connection");if(connection!=null)for(String s:connection.split(","))responseHop.add(s.trim().toLowerCase(Locale.ROOT));
        for(var entry:upstream.getHeaderFields().entrySet())if(entry.getKey()!=null&&!responseHop.contains(entry.getKey().toLowerCase(Locale.ROOT)))for(String value:entry.getValue())if(!value.contains("\r")&&!value.contains("\n"))out.write((entry.getKey()+": "+value+"\r\n").getBytes(StandardCharsets.ISO_8859_1));out.write("\r\n".getBytes(StandardCharsets.US_ASCII));out.flush();sent=true;
        InputStream response=status>=400?upstream.getErrorStream():upstream.getInputStream();if(response!=null)try(response){byte[] buf=new byte[8192];for(int n;(n=response.read(buf))!=-1;){out.write(buf,0,n);out.flush();}}
    }catch(Exception e){if(e instanceof HistoryFilter.Failure)blocked.incrementAndGet();try{if(!sent&&!socket.isClosed()){if(e instanceof HistoryFilter.Failure f)error(socket.getOutputStream(),f.status,f.code,f.getMessage());else error(socket.getOutputStream(),502,"upstream_unavailable","中转未完成，请检查服务商连接。请求未自动重试。");}}catch(IOException ignored){} }finally{finished.set(true);if(upstream!=null){upstream.disconnect();connections.remove(upstream);}clients.remove(socket);try{socket.close();}catch(IOException ignored){}}}
    @Override public void close(){closed=true;try{server.close();}catch(IOException ignored){}for(HttpURLConnection c:connections)c.disconnect();for(Socket s:clients)try{s.close();}catch(IOException ignored){}workers.shutdownNow();}
}
